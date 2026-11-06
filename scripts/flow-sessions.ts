// Живой сценарий: управление сессией, чат и лента, машина и журнал, отказы протокола и краевые входы.
// env: FLOW_CLIENT_KEY, FLOW_MACHINE, FLOW_DIR (папка проекта на машине, от ~), FLOW_HOST_KEY (пробный ключ машины для отказов протокола — не ключ живой машины: relay заменит её соединение, replaced).
import { type Roster } from "@switchboard/relay";
import { client, RELAY as url } from "./client.ts";

const machine = process.env.FLOW_MACHINE!;
const dir = process.env.FLOW_DIR!;
const events: Array<Record<string, any>> = [];
const l = client(process.env.FLOW_CLIENT_KEY!, { onFrame: (f) => void (f.type === "session.events" && events.push(f)) });
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 240)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
};
const state = (cs: string, s: string, ms = 120000) => wait(() => rec(cs)?.state === s, ms);
const text = async (cs: string) => {
  const h = await req({ type: "session.history", callsign: cs, before: null, limit: 6 });
  // последний текст ассистента целиком: длинный ответ не обрезается
  const texts = JSON.stringify(h).match(/"text":"(?:[^"\\]|\\.)*"/g) ?? [];
  return (texts.slice(-1)[0] ?? "").slice(8, -1);
};

await wait(() => l.state === "open", 15000);
const CS = `mg@${machine}`;
await req({ type: "session.remove", callsign: CS });
const t0 = new Date().toISOString();

// --- открытие и краевые входы ---
const open = await req({ type: "session.open", v: 2, machine, name: "mg", dir, model: "claude-haiku-4-5", effort: "low" });
check("session.open", open.ok, open.error);
await state(CS, "idle");
const dup = await req({ type: "session.open", v: 2, machine, name: "mg", dir });
check("то же имя — name_taken", !dup.ok && dup.error === "name_taken", dup.error);
for (const [what, word, f] of [
  ["плохое имя", "bad_name", { name: "a b/c", dir }],
  ["папки нет", "bad_dir", { name: "mg2", dir: "~/нет-такой-папки-" + Date.now() }],
  ["относительная папка", "bad_dir", { name: "mg3", dir: "x/y" }],
  ["усилие не из списка", "bad_spec", { name: "mg4", dir, effort: "ultra" }],
] as const) {
  const r = await req({ type: "session.open", v: 2, machine, ...f });
  check(`session.open: ${what} — ${word}`, !r.ok && r.error === word, r.error ?? r.result);
}
const spec = await req({ type: "session.spec", callsign: CS });
check("session.spec: папка, модель, усилие", spec.ok && spec.result.model === "claude-haiku-4-5" && spec.result.effort === "low", spec.result);
check("roster: поля model и effort", rec(CS)?.model === "claude-haiku-4-5" && rec(CS)?.effort === "low", { model: rec(CS)?.model, effort: rec(CS)?.effort });

// --- обновление ---
const up = await req({ type: "session.update", callsign: CS, title: "Проверка", effort: "medium" });
check("session.update: заголовок и усилие", up.ok, up.ok ? up.result : up.error);
const badUp = await req({ type: "session.update", callsign: CS, effort: "ultra" });
check("session.update: плохое усилие — bad_spec", !badUp.ok && badUp.error === "bad_spec", badUp.error);

// --- лента: зритель, события хода, отписка ---
const w = await req({ type: "session.watch", callsign: CS });
check("session.watch", w.ok, w.error);
await req({ type: "session.prompt", callsign: CS, text: "Ответь одним словом: сколько дней в неделе?" });
await state(CS, "busy", 60000);
await state(CS, "idle");
check("session.events: пачки событий хода пришли зрителю", events.length > 0 && events.every((e) => e.from === "@" + machine || String(e.from).endsWith("@" + machine)), { batches: events.length, seq: events.map((e) => e.seq).slice(0, 5) });
const seqs = events.map((e) => e.seq as number);
check("session.events: seq растёт без пропусков", seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), seqs.slice(0, 10));
check("ответ модели", /сем|7/i.test(await text(CS)), await text(CS));
await req({ type: "session.unwatch", callsign: CS });
const n = events.length;
await req({ type: "session.prompt", callsign: CS, text: "Ответь одним словом: столица Италии?" });
await state(CS, "busy", 60000);
await state(CS, "idle");
check("после session.unwatch событий нет", events.length === n, { before: n, after: events.length });

// --- история постранично ---
const h1 = await req({ type: "session.history", callsign: CS, before: null, limit: 2 });
const first = h1.result?.messages?.[0]?.uuid;
const h2 = first ? await req({ type: "session.history", callsign: CS, before: first, limit: 2 }) : null;
check("session.history постранично: before — более ранние", !!h2?.ok && h1.result.more === true && h2!.result.messages.every((m: any) => !h1.result.messages.some((x: any) => x.uuid === m.uuid)), { more: h1.result?.more, p2: h2?.result?.messages?.length });

// --- методы SDK ---
const cmds = await req({ type: "session.call", callsign: CS, method: "supportedCommands" });
check("session.call supportedCommands", cmds.ok && Array.isArray(cmds.result), Array.isArray(cmds.result) ? cmds.result.length : cmds.error);
const ctx = await req({ type: "session.call", callsign: CS, method: "getContextUsage" });
check("session.call getContextUsage", ctx.ok, ctx.ok ? Object.keys(ctx.result ?? {}).slice(0, 4) : ctx.error);
const bad = await req({ type: "session.call", callsign: CS, method: "streamInput" });
check("session.call закрытого метода — unknown_method", !bad.ok && bad.error === "unknown_method", bad.error);

// --- прерывание длинного хода ---
await req({ type: "session.prompt", callsign: CS, text: "Посчитай вслух от 1 до 300, каждое число с новой строки." });
await state(CS, "busy", 60000);
await new Promise((r) => setTimeout(r, 1500));
const intr = await req({ type: "session.call", callsign: CS, method: "interrupt" });
check("session.call interrupt во время хода", intr.ok, intr.error);
check("после interrupt сессия свободна", await state(CS, "idle", 60000), rec(CS)?.state);

// заголовок виден в spec, когда файл разговора уже есть (claude пишет его на первом ходу)
check("session.spec после update и хода: заголовок", (await req({ type: "session.spec", callsign: CS })).result?.title === "Проверка");

// --- файлы проекта ---
const files = await req({ type: "session.files", callsign: CS, query: "", limit: 20 });
check("session.files отвечает", files.ok, files.ok ? JSON.stringify(files.result).slice(0, 80) : files.error);

// --- стоп и старт ---
check("session.stop", (await req({ type: "session.stop", callsign: CS })).ok);
check("roster: stopped", await state(CS, "stopped", 60000), rec(CS)?.state);
const pStopped = await req({ type: "session.prompt", callsign: CS, text: "x" });
check("session.prompt в остановленную — stopped", !pStopped.ok && pStopped.error === "stopped", pStopped.error);
check("session.start", (await req({ type: "session.start", callsign: CS })).ok);
await state(CS, "idle");
await req({ type: "session.prompt", callsign: CS, text: "Какую столицу я спрашивал? Одним словом." });
await state(CS, "busy", 60000);
await state(CS, "idle");
check("после стопа и старта разговор цел", /рим|rome|итал/i.test(await text(CS)), await text(CS));

// --- машина ---
const dirs = await req({ type: "machine.dirs", machine, path: "~" });
check("machine.dirs ~", dirs.ok && Array.isArray(dirs.result.dirs) && dirs.result.dirs.length > 0, dirs.ok ? dirs.result.dirs.length : dirs.error);
const nd = `~/sb-mkdir-${Date.now()}/a/b`;
const noDir = await req({ type: "session.open", v: 2, machine, name: `mk-${Date.now()}`, dir: nd });
check("session.open: папки нет, просьбы создать нет — bad_dir", !noDir.ok && noDir.error === "bad_dir", noDir.error);
const madeName = `mk-${Date.now()}`;
const made = await req({ type: "session.open", v: 2, machine, name: madeName, dir: nd, mkdir: true });
check("session.open mkdir: цепочка создана, сессия открыта", made.ok, made.error);
if (made.ok) await req({ type: "session.remove", callsign: made.result.callsign });
const nf = await req({ type: "machine.dirs", machine, path: "~/нет-" + Date.now() });
check("machine.dirs папки нет — not_found", !nf.ok && nf.error === "not_found", nf.error);
const ks = await req({ type: "keeper.state", to: `.keeper@${machine}` });
check("keeper.state: Host машины работает", ks.ok && ks.result.parts.some((p: any) => p.part === "host" && p.state === "running"), ks.ok ? ks.result.parts : ks.error);

// --- журнал машины ---
const j = await req({ type: "machine.journal", v: 2, machine, since: t0, limit: 200 });
check("machine.journal: записи с открытия сессии", j.ok && j.result.records.some((r: any) => r.callsign === CS), j.ok ? j.result.records.length : j.error);
const jk = await req({ type: "machine.journal", v: 2, machine, since: t0, kind: ["refuse"], limit: 200 });
check("machine.journal kind refuse: отказы этого прогона (bad_name, bad_dir, bad_spec, name_taken)", jk.ok && jk.result.records.every((r: any) => r.kind === "refuse") && jk.result.records.some((r: any) => r.word === "name_taken"), jk.ok ? jk.result.records.length : jk.error);
const jb = await req({ type: "machine.journal", v: 2, machine, since: "вчера", limit: 10 });
check("machine.journal since не время — bad_frame", !jb.ok && jb.error === "bad_frame", jb.error);

// --- отказы протокола ---
const un = await req({ type: "nosuch.request", machine });
check("незнакомое имя на машине — unknown_request", !un.ok && un.error === "unknown_request", un.error);
const cm = await l.request({ type: "session.spec", v: 99, callsign: CS } as never);
check("версия запроса не та — contract_mismatch", !cm.ok && (cm as any).error === "contract_mismatch", (cm as any).error);
const off = await req({ type: "session.spec", callsign: "x@nobody" });
check("машины нет — offline", !off.ok && off.error === "offline", off.error);
const noSess = await req({ type: "session.spec", callsign: `nosuch@${machine}` });
check("сессии нет на машине — отказ словом", !noSess.ok, noSess.error);
// клиент пишет session.state — relay не пустит чужой callsign
const raw = new WebSocket(`${url}/m/probe`);
await new Promise((r) => (raw.onopen = r));
const closes: string[] = [];
raw.onclose = (e) => closes.push(`${e.code}:${e.reason}`);
raw.send(JSON.stringify({ type: "hello", proto: 1, key: process.env.FLOW_HOST_KEY }));
await new Promise((r) => setTimeout(r, 1500));
const replies: any[] = [];
raw.onmessage = (e) => replies.push(JSON.parse(e.data as string));
raw.send(JSON.stringify({ type: "message", id: "bf-1", to: `mg@${machine}`, from: "spoof@other", text: "x" }));
raw.send("это не json");
await new Promise((r) => setTimeout(r, 1500));
check("from чужой машины от Host — bad_from", replies.some((f) => f.id === "bf-1" && f.error === "bad_from") || closes.some((c) => c.includes("bad_from")), { replies: replies.filter((f) => f.type === "reply"), closes });
raw.send(JSON.stringify({ type: "hello", proto: 2, key: process.env.FLOW_HOST_KEY }));
const raw2 = new WebSocket(`${url}/m/probe`);
await new Promise((r) => (raw2.onopen = r));
const c2: string[] = [];
raw2.onclose = (e) => c2.push(`${e.code}:${e.reason}`);
raw2.send(JSON.stringify({ type: "hello", proto: 99, key: process.env.FLOW_HOST_KEY }));
await wait(() => c2.length > 0, 10000);
check("hello с чужим proto — закрыто contract_mismatch", c2.some((c) => c.includes("contract_mismatch")), c2);
const raw3 = new WebSocket(`${url}/m/probe`);
await new Promise((r) => (raw3.onopen = r));
const c3: string[] = [];
raw3.onclose = (e) => c3.push(`${e.code}:${e.reason}`);
raw3.send("не json до hello");
await wait(() => c3.length > 0, 10000);
check("не кадр до hello — закрыто bad_frame", c3.some((c) => c.includes("bad_frame")), c3);
raw.close();

// --- уборка ---
const rm = await req({ type: "session.remove", callsign: CS });
check("session.remove", rm.ok, rm.error ?? rm.result);
await wait(() => !rec(CS), 15000);
check("roster: сессии нет после remove", !rec(CS));
l.close(1000, "done");
console.log(fails.length ? `sessions: ${fails.length} провалов` : "sessions: ok");
process.exit(fails.length ? 1 : 0);
