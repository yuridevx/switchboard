// Живая проверка модуля shell на тестовом флоте. Запросы программ — прямо к Host машин A и B; сессия haiku на A
// зовёт инструменты MCP shell: картинка в разговоре, Esc посреди ждущего запуска, фоновый с сообщением о конце,
// Esc посреди wait фонового, kill.
// Каждая строка — ok или FAIL; в конце — число ok и FAIL.
// env: FLOW_CLIENT_KEY (client.*), FLOW_A (машина сессии и этого скрипта, по умолчанию win), FLOW_B (вторая, wsl),
//      FLOW_DIR (папка сессии на A), FLOW_MODEL (claude-haiku-4-5), FLOW_STOP=1 — в конце остановить Host B
//      через «выпуски» посреди фонового запуска и поднять снова.
import { existsSync } from "node:fs";
import zlib from "node:zlib";
import { client } from "./client.ts";

const A = process.env.FLOW_A ?? "win";
const B = process.env.FLOW_B ?? "wsl";
const model = process.env.FLOW_MODEL ?? "claude-haiku-4-5";
const name = "shellflow";
const cs = `${name}@${A}`;
const mark = Math.random().toString(36).slice(2, 8);
const l = client(process.env.FLOW_CLIENT_KEY!);

const fails: string[] = [];
let oks = 0;
const check = (n: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail === undefined ? "" : " · " + JSON.stringify(detail).slice(0, 400)}`);
  if (ok) oks++;
  else fails.push(n);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await sleep(1000);
  }
  return true;
};
type Snap = { state: string; code?: number | null; ms: number; stdout: string; stderr: string; files?: Array<{ name: string; media_type: string; data: string }> };
const rq = async (type: string, f: Record<string, unknown>) => (await l.request({ type, v: 1, ...f })) as { ok: boolean; error?: string; result?: unknown };
let n = 0;
const rid = () => `fl${mark}${++n}`;
const run = async (machine: string, f: Record<string, unknown>) => {
  const r = await rq("shell.run", { machine, run: f.run ?? rid(), ...f });
  return { ...r, snap: r.result as Snap | undefined };
};
const wait = async (machine: string, id: string, timeout: number) => {
  const r = await rq("shell.wait", { machine, run: id, timeout });
  return { ...r, snap: r.result as Snap | undefined };
};

/** PNG 32×32 одного цвета — модель должна назвать цвет. */
function png(rgb: [number, number, number]): string {
  const crcT = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(32).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(32).fill(row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const GREEN = png([0, 200, 0]);

type Msg = { type: string; message?: { content?: unknown } };
const history = async (): Promise<Msg[]> => ((await rq("session.history", { callsign: cs, before: null, limit: 200 })).result as { messages?: Msg[] })?.messages ?? [];
const blocksOf = (m: Msg) => (Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : typeof m.message?.content === "string" ? [{ type: "text", text: m.message!.content }] : []);
const said = (ms: Msg[]) => ms.filter((m) => m.type === "assistant").flatMap(blocksOf).filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
const toolUses = (ms: Msg[], tool: string) => ms.filter((m) => m.type === "assistant").flatMap(blocksOf).filter((b) => b.type === "tool_use" && b.name === tool);
const fleetMsgs = (ms: Msg[]) => ms.filter((m) => m.type === "user").flatMap(blocksOf).map((b) => String(b.text ?? "")).filter((t) => t.includes("<fleet-message"));
let state = "";
const idle = async (ms: number) =>
  until(() => {
    state = String(l.roster?.sessions.find((x) => x.callsign === cs)?.state ?? "—");
    return state === "idle";
  }, ms);
const prompt = async (text: string) => {
  const r = await rq("session.prompt", { callsign: cs, text });
  if (!r.ok) throw new Error(`session.prompt: ${r.error}`);
  await sleep(3000);
};

try {
  if (!(await until(() => l.state === "open", 15000))) throw new Error("нет связи с relay");

  // ───────── запросы программ ─────────
  for (const m of [A, B]) {
    const r = await rq("shell.info", { machine: m });
    const sh = (r.result as { shells?: Record<string, { version: string; path: string }> })?.shells ?? {};
    check(`info ${m}: шеллы с версиями`, r.ok && !!sh.bash?.version, r.ok ? sh : r);
  }

  const files = `echo ${GREEN} | base64 -d > "$SB_OUT/chart.png"; echo '{"ok":true}' > "$SB_OUT/data.json"; { echo '%PDF-1.4'; head -c 16 /dev/zero; } > "$SB_OUT/report.pdf"; echo built`;
  const f = await run(B, { shell: "bash", script: files, background: false });
  // картинку для сессии кладёт сценарий: длинную однообразную строку base64 модель перепечатывает с пропусками
  // (haiku теряла повторы «CoH0…» — PNG выходил битым, 1 нояб.); модель только копирует файл
  await run(B, { shell: "bash", script: `echo ${GREEN} | base64 -d > "$HOME/.sb-flow-chart.png"`, background: false });
  const sessionFiles = `cp "$HOME/.sb-flow-chart.png" "$SB_OUT/chart.png"; echo '{"ok":true}' > "$SB_OUT/data.json"; { echo '%PDF-1.4'; head -c 16 /dev/zero; } > "$SB_OUT/report.pdf"; echo built`;
  check(`bash на ${B}: файлы $SB_OUT с типами`, f.snap?.state === "exit" && JSON.stringify(f.snap.files?.map((x) => x.media_type)) === '["image/png","application/json","application/pdf"]', f.snap ? { state: f.snap.state, files: f.snap.files?.map((x) => x.name) } : f);

  const psScript = [
    "Write-Output 'привет'",
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    '$bmp.Save("$env:SB_OUT\\screen.png")',
  ].join("\n");
  const ps = await run(A, { shell: "powershell", script: psScript, background: false, timeout: 60 });
  check(`powershell на ${A}: кириллица в stdout`, ps.snap?.stdout.startsWith("привет") === true, ps.snap ? ps.snap.stdout.slice(0, 40) : ps);
  // снимок экрана — не свойство модуля: у Host, работающего службой Windows, рабочего стола нет (сессия 0); строка-наблюдение
  const shot = !!ps.snap?.files?.some((x) => x.name === "screen.png") && !/CopyFromScreen/.test(ps.snap?.stderr ?? "");
  console.log(`note снимок экрана на ${A}: ${shot ? "снят" : "недоступен — " + (ps.snap?.stderr.split("\n")[0] ?? ps.error)}`);

  const tId = rid();
  const t0 = Date.now();
  const t = await run(B, { run: tId, shell: "bash", script: '(sleep 8; touch "$SB_OUT/alive") & sleep 600', background: false, timeout: 5 });
  check(`sleep 600 с таймаутом 5: timeout за ${((Date.now() - t0) / 1000).toFixed(1)} с`, t.snap?.state === "timeout" && Date.now() - t0 < 9000, t.snap?.state ?? t);
  await sleep(9000);
  const tw = await wait(B, tId, 0);
  check("дерево убито: фоновый ребёнок не дожил до метки", tw.snap?.files?.length === 0, tw.snap?.files?.map((x) => x.name) ?? tw);

  const bgId = rid();
  const bg = await run(B, { run: bgId, shell: "bash", script: "for i in 1 2 3 4 5 6; do echo line$i; sleep 1; done", background: true, timeout: 60 });
  check("фоновый: снимок running сразу", bg.snap?.state === "running", bg.snap ?? bg);
  await sleep(2500);
  const mid = await wait(B, bgId, 0);
  check("wait 0 посреди: running и уже напечатанные строки", mid.snap?.state === "running" && /^line1\nline2\n/.test(mid.snap.stdout), mid.snap ? { state: mid.snap.state, stdout: mid.snap.stdout } : mid);
  const w0 = Date.now();
  const fin = await wait(B, bgId, 30);
  check(`wait 30: итог в момент конца, через ${((Date.now() - w0) / 1000).toFixed(1)} с`, fin.snap?.state === "exit" && fin.snap.stdout.split("\n").filter(Boolean).length === 6 && Date.now() - w0 < 8000, fin.snap ? { state: fin.snap.state, code: fin.snap.code } : fin);
  const again = await wait(B, bgId, 0);
  check("итог не забирается: второй wait — тот же", again.snap?.stdout === fin.snap?.stdout && again.snap?.state === "exit", again.snap?.state ?? again);

  const kId = rid();
  await run(B, { run: kId, shell: "bash", script: "sleep 300", background: true, timeout: 600 });
  const k = await rq("shell.kill", { machine: B, run: kId });
  await sleep(1500);
  const kw = await wait(B, kId, 0);
  check("kill фонового: ok, state killed", k.ok && kw.snap?.state === "killed", { kill: k.ok, state: kw.snap?.state });
  check("kill неизвестного: no_run", (await rq("shell.kill", { machine: B, run: "nope" + mark })).error === "no_run");

  // ───────── сессия haiku на A ─────────
  const prev = l.roster?.sessions.find((s) => s.callsign === cs);
  if (prev) await rq("session.remove", { callsign: cs });
  const open = await rq("session.open", { machine: A, name, dir: process.env.FLOW_DIR!, model });
  if (!open.ok) throw new Error(`session.open: ${open.error}`);
  await idle(90000);

  await prompt(
    `Вызови инструмент mcp__shell__run: machine "${B}", shell "bash", background false, script: ${JSON.stringify(sessionFiles)}. ` +
      "Потом одной строкой ответь: какого цвета картинка chart.png и полный путь к файлу report.pdf из ответа инструмента.",
  );
  await idle(240000);
  let h = await history();
  const pdf = /файл: (\S+report\.pdf)/.exec(JSON.stringify(h).replace(/\\\\/g, "\\"))?.[1];
  check("сессия: картинка chart.png пришла блоком изображения", JSON.stringify(h).includes('"type":"image"'));
  check("сессия: модель назвала цвет картинки", /зел[её]н|green/i.test(said(h)), said(h).slice(-200));
  check(`сессия: report.pdf лежит на ${A}`, !!pdf && existsSync(pdf), pdf);

  const esc = `/tmp/sbflow-${mark}`;
  const before = toolUses(h, "mcp__shell__run").length;
  await prompt(`Вызови инструмент mcp__shell__run: machine "${B}", shell "bash", background false, timeout 900, script: "(sleep 20; touch ${esc}) & sleep 600". Дождись ответа.`);
  const started = await until(async () => toolUses((h = await history()), "mcp__shell__run").length > before, 120000);
  await sleep(4000);
  const intr = await rq("session.call", { callsign: cs, method: "interrupt" });
  check("Esc посреди ждущего run: ход прерван", started && intr.ok, intr);
  await idle(60000);
  await sleep(22000);
  const probe = await run(B, { shell: "bash", script: `test -e ${esc} && echo alive || echo dead`, background: false });
  check(`Esc: процесса на ${B} нет — метка не появилась`, probe.snap?.stdout.trim() === "dead", probe.snap?.stdout ?? probe);

  await prompt(
    `Вызови mcp__shell__run: machine "${B}", shell "bash", background true, timeout 120, script: "for i in 1 2 3 4 5 6 7 8; do echo строка$i; sleep 1; done". ` +
      "Сразу после этого вызови mcp__shell__wait с этим run и timeout 0 и напиши, сколько строк уже есть. Закончи ход. " +
      "Когда придёт сообщение флота о конце запуска — дважды вызови mcp__shell__wait с timeout 0 и ответь строкой «итоги одинаковы» или «итоги разные».",
  );
  const ended = await until(async () => fleetMsgs((h = await history())).some((x) => x.includes("кончился: exit 0")), 240000);
  check("фоновый из сессии: сообщение флота о конце пришло", ended, fleetMsgs(h).slice(-1));
  const same = await until(async () => /итоги одинаковы|итоги разные/i.test(said((h = await history()))), 240000);
  check("после сообщения: два wait, итоги одинаковы", same && /итоги одинаковы/i.test(said(h)) && toolUses(h, "mcp__shell__wait").length >= 3, said(h).slice(-200));
  await idle(120000);

  // Esc посреди wait фонового: обрывается только ожидание — скрипт дорабатывает, о конце приходит сообщение exit 0
  h = await history();
  const msgs0 = fleetMsgs(h).length;
  const waits0 = toolUses(h, "mcp__shell__wait").length;
  await prompt(
    `Вызови mcp__shell__run: machine "${B}", shell "bash", background true, timeout 120, script "sleep 25; echo fin". ` +
      "Сразу после ответа вызови mcp__shell__wait с этим run и timeout 600 и дождись ответа.",
  );
  const inWait = await until(async () => toolUses((h = await history()), "mcp__shell__wait").length > waits0, 120000);
  await sleep(3000);
  const intrW = await rq("session.call", { callsign: cs, method: "interrupt" });
  check("Esc посреди wait фонового: ход прерван", inWait && intrW.ok, intrW);
  const finW = await until(async () => fleetMsgs((h = await history())).slice(msgs0).some((x) => x.includes("кончился: exit 0")), 120000);
  check("Esc в wait: скрипт доработал — сообщение «exit 0», не killed", finW && !fleetMsgs(h).slice(msgs0).some((x) => x.includes("killed")), fleetMsgs(h).slice(msgs0));
  await idle(120000);

  await prompt(`Вызови mcp__shell__run: machine "${B}", shell "bash", background true, timeout 600, script "sleep 300". Сразу после ответа погаси этот запуск инструментом mcp__shell__kill.`);
  const killed = await until(async () => fleetMsgs((h = await history())).some((x) => x.includes("кончился: killed")), 240000);
  check("kill фонового из сессии: сообщение «killed»", killed, fleetMsgs(h).slice(-1));
  await idle(120000);

  if (process.env.FLOW_STOP === "1") {
    await prompt(`Вызови mcp__shell__run: machine "${B}", shell "bash", background true, timeout 600, script "sleep 300". Больше ничего не делай.`);
    await idle(120000);
    const off = await rq("releases.set", { to: ".releases", machine: B, part: "host", on: false });
    const stopped = await until(async () => fleetMsgs((h = await history())).some((x) => x.includes("остановлен")), 120000);
    const on = await rq("releases.set", { to: ".releases", machine: B, part: "host", on: true });
    check(`остановка Host ${B} посреди фонового: «итог не сохранён»`, off.ok && stopped && on.ok, { off: off.ok, on: on.ok, last: fleetMsgs(h).slice(-1) });
    check(`Host ${B} снова на связи`, await until(() => !!l.roster?.machines.some((m) => m.machine === B), 120000));
  }
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  if (l.roster?.sessions.some((s) => s.callsign === cs)) await rq("session.remove", { callsign: cs });
  console.log(`flow-shell: ${oks} ok · ${fails.length} FAIL${fails.length ? " — " + fails.join("; ") : ""}`);
  process.exitCode = fails.length ? 1 : 0;
  l.close(1000, "done");
}
