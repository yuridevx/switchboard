// Живой сценарий: пуш вопроса, когда давшего задачу нет на связи; перенос и откат точек; профили без репозиториев;
// журнал флота; сообщение несуществующим адресатам.
// env: FLOW_CLIENT_KEY, FLOW_PUSH_KEY (ключ клиента с подпиской на пуши), FLOW_FROM_MACHINE, FLOW_TO_MACHINE, FLOW_DIR.
import { link, type Roster } from "@switchboard/relay";

const url = process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev";
const M1 = process.env.FLOW_FROM_MACHINE!;
const M2 = process.env.FLOW_TO_MACHINE!;
const dir = process.env.FLOW_DIR!;
const l = link({ url, key: process.env.FLOW_CLIENT_KEY! });
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 260)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>, via = l) => (await via.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
};
const state = (cs: string, s: string, ms = 120000) => wait(() => rec(cs)?.state === s, ms);
const text = async (cs: string) => {
  const h = await req({ type: "session.history", callsign: cs, before: null, limit: 6 });
  const texts = JSON.stringify(h).match(/"text":"(?:[^"\\]|\\.)*"/g) ?? [];
  return (texts.slice(-1)[0] ?? "").slice(8, -1);
};
async function turn(cs: string, t: string) {
  await req({ type: "session.prompt", callsign: cs, text: t });
  await state(cs, "busy", 60000);
  await state(cs, "idle");
  return text(cs);
}
await wait(() => l.state === "open", 15000);
const t0 = new Date().toISOString();

// --- пуш: давший задачу ушёл со связи, сессия спрашивает ---
const NQ = `nq@${M1}`;
await req({ type: "session.remove", callsign: NQ });
await req({ type: "session.open", machine: M1, name: "nq", dir, model: "claude-haiku-4-5" });
await state(NQ, "idle");
const phone = link({ url, key: process.env.FLOW_PUSH_KEY! });
await wait(() => phone.state === "open", 15000);
const phoneName = process.env.FLOW_PUSH_KEY!.split(".")[1];
await req({ type: "session.prompt", callsign: NQ, text: "Спроси меня инструментом AskUserQuestion: «Чай или кофе?» с вариантами «чай» и «кофе». Получив ответ, напиши его одним словом." }, phone);
phone.close(1000, "away");
await wait(async () => (await req({ type: "question.list", callsign: NQ })).result?.length > 0, 120000);
const jq = await wait(async () => {
  const j = await req({ type: "machine.journal", machine: M1, since: t0, limit: 500 });
  return JSON.stringify(j.result?.records ?? []).includes(`ask → ${phoneName}`);
}, 30000);
check("вопрос ушёл давшему задачу, которого нет на связи", jq);
const jj = await req({ type: "machine.journal", machine: M1, since: t0, limit: 500 });
const pushLines = (jj.result?.records ?? []).filter((r: any) => r.who === "host-push");
check("host-push достал его пушем (в журнале нет «без пуша»)", !pushLines.some((r: any) => /без пуша/.test(r.why ?? "")), pushLines.map((r: any) => r.why));
const ql = await req({ type: "question.list", callsign: NQ });
const q = ql.result[0];
await req({ type: "answer", callsign: NQ, question: q.question, answers: { [q.questions[0].question]: "чай" } });
check("ответ с другого устройства принят, модель его получила", (await state(NQ, "idle")) && /чай/i.test(await text(NQ)), await text(NQ));
await req({ type: "session.remove", callsign: NQ });

// --- перенос сессии между машинами и откат ---
const PM = `pm@${M1}`;
const PM2 = `pm@${M2}`;
for (const cs of [PM, PM2]) await req({ type: "session.remove", callsign: cs });
await req({ type: "session.open", machine: M1, name: "pm", dir, model: "claude-haiku-4-5" });
await state(PM, "idle");
await turn(PM, "Повтори дословно одно слово: «маяк». Ничего не сохраняй в память.");
const mark = await req({ type: "session.r2", callsign: PM, on: true });
check("пометка «в R2» — первая точка", mark.ok && typeof mark.result.point === "number", mark.result ?? mark.error);
const p1 = mark.result.point as number;
await turn(PM, "Повтори дословно одно слово: «волна». Ничего не сохраняй в память.");
const sv = await req({ type: "points.save", callsign: PM, stop: true });
check("points.save со стопом", sv.ok && rec(PM)?.state === "stopped", sv.result ?? sv.error);
const fleet = await req({ type: "points.list", to: ".points" });
const sid = (fleet.result.sessions as any[]).find((s) => s.callsign === PM)?.sid;
const dry = await req({ type: "points.raise", machine: M2, sid, point: sv.result.point, dir: "~/sb-move", dryRun: true });
check("points.raise dryRun на другой машине", dry.ok, dry.result ?? dry.error);
const mv = await req({ type: "points.raise", machine: M2, sid, point: sv.result.point, dir: "~/sb-move", files: "point" });
check("перенос сессии на другую машину", mv.ok, mv.result ?? mv.error);
const moved = mv.result?.callsign as string;
await wait(() => !rec(PM) && rec(moved)?.state === "idle", 120000);
check("на прежней машине сессии нет, на новой — есть", !rec(PM) && !!rec(moved), { old: rec(PM)?.state, new: rec(moved)?.state });
check("после переноса разговор цел", /волна|маяк/i.test(await turn(moved, "Какие слова ты повторял в этом разговоре? Через запятую.")));
const own = await req({ type: "points.list", to: ".points" });
check("хозяин сессии в реестре — новая машина", (own.result.sessions as any[]).find((s) => s.sid === sid)?.owner === M2, (own.result.sessions as any[]).find((s) => s.sid === sid));
// откат на той же машине к первой точке (файлы папки не трогаем)
await req({ type: "points.save", callsign: moved, stop: true });
const rb = await req({ type: "points.raise", machine: M2, sid, point: p1, dir: "~/sb-move", files: "keep" });
check("откат к первой точке", rb.ok, rb.result ?? rb.error);
await state(moved, "idle");
const after = await turn(moved, "Какие слова ты повторял в этом разговоре? Через запятую, ничего не придумывай.");
check("после отката разговор — до второго слова", /маяк/i.test(after) && !/волна/i.test(after), after);
const off = await req({ type: "session.r2", callsign: moved, on: false });
check("снятие пометки удаляет точки из R2", off.ok && off.result.deleted > 0, off.result ?? off.error);
await req({ type: "session.remove", callsign: moved });

// --- профили без репозиториев ---
const pr = await req({ type: "machine.profiles", machine: M1 });
check("machine.profiles без репозиториев", pr.ok && typeof pr.result.profiles === "object", pr.result ?? pr.error);
const PF = `pf@${M1}`;
await req({ type: "session.remove", callsign: PF });
await req({ type: "session.open", machine: M1, name: "pf", dir, model: "claude-haiku-4-5" });
await state(PF, "idle");
const np = await req({ type: "session.profile", callsign: PF, profile: "nosuch" });
check("session.profile неизвестного профиля — no_profile", !np.ok && np.error === "no_profile", np.error ?? np.result);
await req({ type: "session.remove", callsign: PF });

// --- журнал флота ---
const led = await req({ type: "ledger.read", to: ".ledger", limit: 1000 });
const evs = new Set((led.result?.events ?? []).map((e: any) => e.ev));
check("журнал флота: открытие, удаление, перенос, подмена слота", ["session.opened", "session.removed", "session.moved", "slot.swapped"].every((e) => evs.has(e)), [...evs]);
const flt = await req({ type: "ledger.read", to: ".ledger", limit: 20, machine: M2 });
check("ledger.read с фильтром машины", flt.ok && (flt.result.events as any[]).every((e) => e.machine === M2), flt.ok ? flt.result.events.length : flt.error);

// --- сообщения несуществующим адресатам ---
const m1 = await req({ type: "message", to: `nosuch@${M1}`, text: "x" });
check("message сессии, которой нет на машине — отказ словом", !m1.ok, m1.error);
const m2 = await req({ type: "message", to: "nosuch@gone", text: "x" });
check("message на машину не на связи — offline", !m2.ok && m2.error === "offline", m2.error);
const m3 = await req({ type: "message", to: "no-such-client~owner@example.com", text: "x" });
check("message клиенту не на связи — offline", !m3.ok && m3.error === "offline", m3.error);

l.close(1000, "done");
console.log(fails.length ? `more: ${fails.length} провалов` : "more: ok");
process.exit(fails.length ? 1 : 0);
