// Живые ветки сбоев на машине Windows (процессы убиваются по pid): claude умер — один resume; умер снова до
// готовности — failed и session.start; Host упал посреди хода — keeper поднимает Host один раз, Host подключается
// к держателям, ход доходит; второе падение Host — failed в keeper.state, агент поднимает его чистым перезапуском
// через план; ждущий вопрос переживает перезапуск Host; ждущий запрос получает disconnected, когда Host уходит.
// env: FLOW_CLIENT_KEY, FLOW_MACHINE, FLOW_DIR.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const machine = process.env.FLOW_MACHINE!;
const dir = process.env.FLOW_DIR!;
const questions: Array<Record<string, any>> = [];
const l = client(process.env.FLOW_CLIENT_KEY!, {
  onFrame: (f) => void (f.type === "question" && questions.push(f)),
});
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 240)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const since = () => (l.roster as Roster | null)?.machines.find((m) => m.machine === machine)?.since;
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
// pid процесса claude — из файла его держателя на этой машине
const claudePid = async (cs: string) => {
  const f = join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "procs", `${cs}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).pid as number) : undefined;
};
const hostPid = () =>
  Number(execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*\\.switchboard\\parts\\host\\*' -and $_.CommandLine -notlike '*sbkeeper*' } | Select-Object -First 1).ProcessId"`, { timeout: 30_000 }).toString().trim());
const kill = (pid: number) => execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore", timeout: 10_000 });

const hostPart = async () => ((await req({ type: "keeper.state", to: `.keeper@${machine}` })).result?.parts ?? []).find((p: any) => p.part === "host");
/** Чистый перезапуск Host агентом: план on: false, затем on: true; ждать новый hello машины. */
async function cleanRestart(): Promise<boolean> {
  const b = since();
  await req({ type: "releases.set", to: ".releases", machine, part: "host", on: false });
  await req({ type: "releases.set", to: ".releases", machine, part: "host", on: true });
  return wait(() => !!since() && since() !== b, 120000);
}

await wait(() => l.state === "open", 15000);
const CS = `fx@${machine}`;
await req({ type: "session.remove", callsign: CS });
await req({ type: "session.open", v: 2, machine, name: "fx", dir, model: "claude-haiku-4-5" });
await state(CS, "idle");
await req({ type: "session.prompt", callsign: CS, text: "Запомни число 4711. Ответь: ок." });
await state(CS, "busy", 60000);
await state(CS, "idle");

// 1. процесс claude умер — один resume, разговор цел
const p1 = await claudePid(CS);
kill(p1!);
check("claude убит — сессия поднята снова (resume)", await wait(async () => rec(CS)?.state === "idle" && (await claudePid(CS)) !== p1, 90000), rec(CS)?.state);
await req({ type: "session.prompt", callsign: CS, text: "Какое число я просил запомнить? Только число." });
await state(CS, "busy", 60000);
await state(CS, "idle");
check("после resume разговор цел", /4711/.test(await text(CS)), await text(CS));

// 2. умер, и сразу после подъёма умер снова — failed, session.start поднимает
const p2 = await claudePid(CS);
kill(p2!);
await wait(async () => !!(await claudePid(CS)) && (await claudePid(CS)) !== p2, 60000);
const p3 = await claudePid(CS);
if (p3) kill(p3);
// убить «до готовности» по pid не поймать (процесс проходит initialize за доли секунды) — ветку до готовности
// держит эталон ядра 64; здесь: два сбоя подряд не вешают сессию — она failed (session.start поднимает) или снова на ногах
const settled = await wait(() => rec(CS)?.state === "failed" || rec(CS)?.state === "idle", 90000);
check("два сбоя подряд: сессия не зависла (failed или поднята)", settled, rec(CS)?.state);
if (rec(CS)?.state === "failed") check("session.start поднимает failed", (await req({ type: "session.start", callsign: CS })).ok && (await state(CS, "idle", 90000)), rec(CS)?.state);

// 3. Host упал посреди хода — keeper поднимает Host, attach, ход доходит
await req({ type: "session.prompt", callsign: CS, text: "Напиши подряд числа от 1 до 40 через запятую, потом слово «конец»." });
await state(CS, "busy", 60000);
const before = since();
const hp = hostPid();
kill(hp);
check("Host упал — машина вернулась с новым hello", await wait(() => !!since() && since() !== before, 60000));
check("ход, начатый до падения Host, дошёл до конца", (await state(CS, "idle", 180000)) && /конец/i.test(await text(CS)), await text(CS));

// 3b. второе падение Host — failed в keeper.state с причиной; агент поднимает чистым перезапуском
await state(CS, "idle", 60000);
kill(hostPid());
check("второе падение Host — failed в keeper.state", await wait(async () => (await hostPart())?.state === "failed", 60000), await hostPart());
check("агент: set host on: false → on: true — Host снова на связи", await cleanRestart(), await hostPart());
await state(CS, "idle", 120000);

// 4. ждущий вопрос переживает перезапуск Host
questions.length = 0;
await req({ type: "session.prompt", callsign: CS, text: "Спроси меня инструментом AskUserQuestion: «Какой цвет?» с вариантами «красный» и «синий». Получив ответ, напиши его одним словом." });
const gotQ = await wait(() => questions.length > 0, 120000);
check("вопрос пришёл", gotQ);
const before2 = since();
kill(hostPid());
await wait(() => !!since() && since() !== before2, 60000);
const list = await req({ type: "question.list", callsign: CS });
check("после перезапуска Host вопрос всё ещё ждёт (question.list)", list.ok && JSON.stringify(list.result).includes("Какой цвет"), list.result ?? list.error);
const q = (list.result ?? [])[0] ?? questions[0];
const a = await req({ type: "answer", callsign: CS, question: q?.question, answers: { [q?.questions?.[0]?.question ?? "Какой цвет?"]: "синий" } });
check("ответ на вопрос после перезапуска Host принят", a.ok, a.error);
check("модель получила ответ", (await state(CS, "idle", 120000)) && /син/i.test(await text(CS)), await text(CS));

// 5. ждущий запрос — disconnected, когда Host уходит
await req({ type: "session.prompt", callsign: CS, text: "Напиши подряд числа от 1 до 60 через запятую." });
await state(CS, "busy", 60000);
const pending = req({ type: "session.call", callsign: CS, method: "supportedModels" });
kill(hostPid());
const r = await pending;
check("запрос к уходящей машине — ответ или disconnected, без зависания", r.ok || r.error === "disconnected", r.ok ? "ok" : r.error);
// это второе падение после чистого перезапуска — Host failed; агент поднимает его
await wait(async () => (await hostPart())?.state === "failed", 60000);
check("Host поднят после второго падения", await cleanRestart(), await hostPart());
check("ход после перезапусков дошёл", await wait(() => rec(CS)?.state === "idle", 180000), rec(CS)?.state);

await req({ type: "session.remove", callsign: CS });
l.close(1000, "done");
console.log(fails.length ? `failures: ${fails.length} провалов` : "failures: ok");
process.exit(fails.length ? 1 : 0);
