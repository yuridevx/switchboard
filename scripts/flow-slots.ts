// Живые флоу с несколькими аккаунтами на одной машине. env: FLOW_CLIENT_KEY, FLOW_MACHINE,
// FLOW_A (аккаунт с запасом), FLOW_B (второй аккаунт с запасом), FLOW_SPENT (аккаунт с исчерпанным лимитом).
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const machine = process.env.FLOW_MACHINE!;
const [A, B, SPENT] = [process.env.FLOW_A!, process.env.FLOW_B!, process.env.FLOW_SPENT!];
const questions: Array<Record<string, any>> = [];
const l = client(process.env.FLOW_CLIENT_KEY!, {
  onFrame: (f) => void (f.type === "question" && questions.push(f)),
});
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 260)}`);
  if (!ok) fails.push(n);
};
const V2 = new Set(["machine.accounts", "machine.login", "machine.login_code", "machine.account_remove", "session.slot"]);
const req = async (f: Record<string, unknown>) => (await l.request({ v: V2.has(String(f.type)) ? 2 : 1, ...f } as never)) as { ok: boolean; result?: any; error?: string; why?: string };
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
  // последний текст ассистента целиком: длинный ответ не обрезается
  const texts = JSON.stringify(h).match(/"text":"(?:[^"\\]|\\.)*"/g) ?? [];
  return (texts.slice(-1)[0] ?? "").slice(8, -1);
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
// освободить аккаунты от слотов прошлых прогонов (FLOW_CLEAR — слоты через запятую): их сессии и сами слоты
for (const slot of (process.env.FLOW_CLEAR ?? "").split(",").filter(Boolean)) {
  for (const s of (l.roster as Roster | null)?.sessions ?? []) if (s.callsign.endsWith("@" + machine) && (s as Record<string, any>).slot?.name === slot) await req({ type: "session.remove", callsign: s.callsign });
  await req({ type: "slot.set", machine, slot, order: [] });
}

// два слота — два аккаунта
check("slot.set s1 → " + A, (await req({ type: "slot.set", machine, slot: "s1", order: [A] })).result?.account === A);
check("slot.set s2 → " + B, (await req({ type: "slot.set", machine, slot: "s2", order: [B] })).result?.account === B);
for (const [cs, slot] of [[S1, "s1"], [S2, "s2"]] as const) {
  const o = await req({ type: "session.open", v: 2, machine, name: cs.split("@")[0], dir: "~", model: "claude-haiku-4-5", slot });
  check(`session.open ${cs} в слоте ${slot}`, o.ok, o.ok ? undefined : o.error);
}
await Promise.all([idle(S1), idle(S2)]);

// правило слота при открытии: слотов два и больше — выбор явный, отказ называет слоты машины, сессии нет
const need = await req({ type: "session.open", v: 2, machine, name: "sd", dir: "~", model: "claude-haiku-4-5" });
check("session.open без слота при двух слотах — отказ slot_required со слотами машины", !need.ok && need.error === "slot_required" && /s1/.test(need.why ?? "") && /s2/.test(need.why ?? ""), need.ok ? need.result : [need.error, need.why]);
check("после отказа сессии sd нет", !rec(`sd@${machine}`), rec(`sd@${machine}`));
const none = await req({ type: "session.open", v: 2, machine, name: "sd", dir: "~", slot: "нет-такого" });
check("session.open с несуществующим слотом — отказ no_slot", !none.ok && none.error === "no_slot", none.ok ? none.result : none.error);

check("roster: сессии на разных аккаунтах", rec(S1)?.account === A && rec(S2)?.account === B, { [S1]: rec(S1)?.account, [S2]: rec(S2)?.account });

// одновременные ходы на двух аккаунтах
const [r1, r2] = await Promise.all([turn(S1, "Запомни слово «кит». Ответь: ок."), turn(S2, "Запомни слово «ёж». Ответь: ок.")]);
check("ходы одновременно на двух аккаунтах", /ок|понял/i.test(r1) && /ок|понял/i.test(r2), { r1, r2 });

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
check("Remote Control: у сессий слотов ссылка claude.ai/code", [S1, S2].every((cs) => /https:\/\/claude\.ai\/code\//.test(JSON.stringify(rec(cs)?.remote ?? ""))), { [S1]: rec(S1)?.remote, [S2]: rec(S2)?.remote });
// один аккаунт — в двух слотах: слот — ссылка на папку аккаунта, s4 берёт A, хотя A уже стоит в s1
const S3 = `sc@${machine}`;
await req({ type: "session.remove", callsign: S3 });
const sh = await req({ type: "slot.set", machine, slot: "s4", order: [A] });
check("slot.set s4 с аккаунтом, уже стоящим в s1, — встаёт и в s4", sh.ok && sh.result?.account === A, sh.error ?? sh.result);
const inSlots = ((await req({ type: "machine.accounts", machine })).result?.slots ?? {}) as Record<string, { account: string | null }>;
check(`accounts: ${A} стоит в слотах s1 и s4`, inSlots.s1?.account === A && inSlots.s4?.account === A, inSlots);
const o3 = await req({ type: "session.open", v: 2, machine, name: "sc", dir: "~", model: "claude-haiku-4-5", slot: "s4" });
check(`session.open ${S3} в слоте s4`, o3.ok, o3.ok ? undefined : o3.error);
await idle(S3);
check(`ход в s4 на общем аккаунте ${A}`, /ок/i.test(await turn(S3, "Ответь: ок.")) && rec(S3)?.account === A, rec(S3)?.account);

// горячая подмена живого слота: s2 (сессии sa и sb на B) → A посреди разговора; процессы не перезапускаются
const hs = await req({ type: "slot.swap", machine, slot: "s2", account: A });
check(`slot.swap s2: ${B} → ${A}`, hs.ok && hs.result?.from === B && hs.result?.to === A, hs.error ?? hs.result);
check(`roster: ${S2} на ${A} сразу после подмены`, await wait(() => rec(S2)?.account === A, 30000), rec(S2)?.account);
const slotsNow = (await req({ type: "machine.accounts", machine })).result?.slots ?? {};
check(`${A} сразу после подмены в трёх слотах: s1, s2, s4`, ["s1", "s2", "s4"].every((s) => slotsNow[s]?.account === A), Object.fromEntries(Object.entries(slotsNow).map(([k, v]: [string, any]) => [k, v.account])));
check(`горячая подмена: разговор ${S2} продолжается на ${A}`, /ёж/i.test(await turn(S2, "Какое слово я просил запомнить? Одним словом.")));

// слот, где все аккаунты за порогом: ждёт сброса
const w = await req({ type: "slot.set", machine, slot: "s3", order: [SPENT] });
const slots = await req({ type: "machine.accounts", machine });
check("слот только с исчерпанным аккаунтом — отказ или ожидание сброса", !w.ok || !!slots.result?.slots?.s3?.wait, w.ok ? slots.result?.slots?.s3 : w.error);

// удаление аккаунта без запаса (A — в s1 и s4, других в их порядке нет): отказ со слотом, ничего не тронуто.
// Стирание настоящего входа вживую не проверяем: слово пользователя 4 нояб., его закрепляет эталон на подделках
const held = (await req({ type: "machine.accounts", machine })).result?.slots ?? {};
const rm = await req({ type: "machine.account_remove", machine, account: A });
check("machine.account_remove без запаса — отказ no_reserve с именем слота", !rm.ok && rm.error === "no_reserve" && /s[0-9]:/.test(rm.why ?? ""), rm.ok ? rm.result : [rm.error, rm.why]);
const kept = (await req({ type: "machine.accounts", machine })).result ?? {};
check(`после отказа ${A} на месте: вход и слоты те же`, kept.accounts?.[A]?.login === "ok" && Object.keys(held).every((s) => kept.slots?.[s]?.account === held[s].account), kept.slots);

// уборка
for (const cs of [S1, S2, S3]) await req({ type: "session.remove", callsign: cs });
for (const slot of ["s1", "s2", "s3", "s4"]) await req({ type: "slot.set", machine, slot, order: [] });
const after = await req({ type: "machine.accounts", machine });
check("уборка: временные слоты удалены", !["s1", "s2", "s3", "s4"].some((s) => after.result?.slots?.[s]), Object.keys(after.result?.slots ?? {}));
const accsAfter = (await req({ type: "machine.accounts", machine })).result?.accounts ?? {};
check("уборка: входы аккаунтов на месте", [A, B, SPENT].every((n) => accsAfter[n]?.login === "ok"), Object.fromEntries([A, B, SPENT].map((n) => [n, accsAfter[n]?.login])));
l.close(1000, "done");
console.log(fails.length ? `slots: ${fails.length} провалов` : "slots: ok");
process.exit(fails.length ? 1 : 0);
