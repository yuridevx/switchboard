// Живые флоу с несколькими аккаунтами на одной машине. env: FLOW_CLIENT_KEY, FLOW_MACHINE,
// FLOW_A (аккаунт с запасом), FLOW_B (второй аккаунт с запасом), FLOW_SPENT (аккаунт с исчерпанным лимитом).
import { link, type Roster } from "@switchboard/relay";

const machine = process.env.FLOW_MACHINE!;
const [A, B, SPENT] = [process.env.FLOW_A!, process.env.FLOW_B!, process.env.FLOW_SPENT!];
const questions: Array<Record<string, any>> = [];
const l = link({
  url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev",
  key: process.env.FLOW_CLIENT_KEY!,
  onFrame: (f) => void (f.type === "question" && questions.push(f)),
});
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 260)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
};
const idle = (cs: string, ms = 180000) => wait(() => rec(cs)?.state === "idle", ms);
const lastText = async (cs: string) => {
  const h = await req({ type: "session.history", callsign: cs, before: null, limit: 8 });
  return ((JSON.stringify(h).match(/"text":"([^"]{1,120})"/g) ?? []).slice(-1)[0] ?? "").slice(8, -1);
};
async function turn(cs: string, text: string) {
  await req({ type: "session.prompt", callsign: cs, text });
  await wait(() => ["busy", "waiting"].includes(rec(cs)?.state), 60000);
  await idle(cs);
  return lastText(cs);
}

await wait(() => l.state === "open", 15000);
const S1 = `sa@${machine}`;
const S2 = `sb@${machine}`;
for (const cs of [S1, S2]) await req({ type: "session.remove", callsign: cs });

// два слота — два аккаунта
check("slot.set s1 → " + A, (await req({ type: "slot.set", machine, slot: "s1", order: [A] })).result?.account === A);
check("slot.set s2 → " + B, (await req({ type: "slot.set", machine, slot: "s2", order: [B] })).result?.account === B);
for (const [cs, slot] of [[S1, "s1"], [S2, "s2"]] as const) {
  const o = await req({ type: "session.open", machine, name: cs.split("@")[0], dir: "~", model: "claude-haiku-4-5", slot });
  check(`session.open ${cs} в слоте ${slot}`, o.ok, o.ok ? undefined : o.error);
}
await Promise.all([idle(S1), idle(S2)]);
check("roster: сессии на разных аккаунтах", rec(S1)?.account === A && rec(S2)?.account === B, { [S1]: rec(S1)?.account, [S2]: rec(S2)?.account });

// одновременные ходы на двух аккаунтах
const [r1, r2] = await Promise.all([turn(S1, "Запомни слово «кит». Ответь: ок."), turn(S2, "Запомни слово «ёж». Ответь: ок.")]);
check("ходы одновременно на двух аккаунтах", /ок/i.test(r1) && /ок/i.test(r2), { r1, r2 });

// переписка между сессиями разных аккаунтов
const mark = "метка-" + Math.random().toString(36).slice(2, 6);
await turn(S1, `Отправь сессии ${S2} инструментом fleet (send) ровно такой текст: «${mark}». Больше ничего не делай.`);
check("переписка: сессия аккаунта " + A + " → сессия аккаунта " + B, await wait(async () => JSON.stringify(await req({ type: "session.history", callsign: S2, before: null, limit: 20 })).includes(mark), 120000));
await idle(S2);

// вопрос человеку от сессии второго аккаунта
await req({ type: "session.prompt", callsign: S2, text: "Спроси меня инструментом AskUserQuestion: «Какой фрукт?» с вариантами «яблоко» и «груша». Получив ответ, напиши его одним словом." });
const gotQ = await wait(() => questions.some((q) => q.from === S2), 120000);
const q = questions.find((x) => x.from === S2);
if (gotQ && q) {
  const a = await req({ type: "answer", callsign: S2, question: q.question, answers: { [q.questions[0].question]: "груша" } });
  check("вопрос от сессии аккаунта " + B + " пришёл и принят ответ", a.ok, a.error);
  await idle(S2);
  check("модель получила ответ", /груш/i.test(await lastText(S2)));
} else check("вопрос от сессии аккаунта " + B, false, "кадр question не пришёл");

// перенос живой сессии в другой слот: другой аккаунт, разговор цел
const mv = await req({ type: "session.slot", callsign: S1, slot: "s2" });
check("session.slot " + S1 + " → s2 (перезапуск)", mv.ok, mv.ok ? mv.result : mv.error);
await wait(() => rec(S1)?.account === B, 60000);
await idle(S1);
check("после переноса сессия на аккаунте " + B, rec(S1)?.account === B, rec(S1)?.account);
check("разговор цел после смены аккаунта", /кит/i.test(await turn(S1, "Какое слово я просил запомнить? Одним словом.")));

// Remote Control: ссылка у сессий слотов
check("Remote Control: у сессий есть ссылка claude.ai", [S1, S2].every((cs) => /claude\.ai/.test(JSON.stringify(rec(cs)?.remote ?? ""))), { [S1]: rec(S1)?.remote, [S2]: rec(S2)?.remote });

// слот, где все аккаунты за порогом: ждёт сброса
const w = await req({ type: "slot.set", machine, slot: "s3", order: [SPENT] });
const slots = await req({ type: "machine.slots", machine });
check("слот только с исчерпанным аккаунтом — отказ или ожидание сброса", !w.ok || !!slots.result?.slots?.s3?.wait, w.ok ? slots.result?.slots?.s3 : w.error);

// аккаунт, занятый слотом, не удаляется
const rm = await req({ type: "machine.account_remove", machine, account: B });
check("machine.account_remove аккаунта в слоте — отказ in_slot", !rm.ok && rm.error === "in_slot", rm.error ?? rm.result);

// уборка
for (const cs of [S1, S2]) await req({ type: "session.remove", callsign: cs });
for (const slot of ["s1", "s2", "s3"]) await req({ type: "slot.set", machine, slot, order: [] });
const after = await req({ type: "machine.slots", machine });
check("уборка: временные слоты удалены", !["s1", "s2", "s3"].some((s) => after.result?.slots?.[s]), Object.keys(after.result?.slots ?? {}));
l.close(1000, "done");
console.log(fails.length ? `slots: ${fails.length} провалов` : "slots: ok");
process.exit(fails.length ? 1 : 0);
