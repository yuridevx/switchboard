// Эталоны «дать работу»: служба «Фабрика» отдаёт сессии шаг тикета; ход, взявший шаг, без вердикта возвращается один раз.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { make as work } from "../src/modules/work/work.ts";
import { FakeHolders, stand, tick, until, type FakeProc, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const FACTORY = ".factory";
const PULT = "pult~yuri@example.com";
const give = (s: Stand, name: string, ticket: string, extra: Record<string, unknown> = {}) => s.request("work.give", { to: "@laptop", name, ticket, text: `Тикет ${ticket}: шапка сайта`, ...extra }, FACTORY);
/** Текст последнего ввода процесса. */
const lastInput = (p: FakeProc) => String(p.inputs.at(-1)!.message.content);
/** Ход взял ввод: процесс называет номера взятых сообщений на ответе модели; несколько шагов цикла событий — ядро успевает прочесть событие раньше хука. */
const take = async (p: FakeProc) => {
  p.send({ type: "assistant", uuid: "a" + p.inputs.length, message: { role: "assistant", content: [{ type: "text", text: "беру" }] }, user_message_uuids: [p.inputs.at(-1)!.uuid] });
  await tick(20);
};
const reminded = (out: unknown[]) => out.filter((o) => (o as { decision?: string } | undefined)?.decision === "block") as { reason: string }[];
const lines = (s: Stand) => s.journal().filter((l) => l.msg === "work");

describe("дать работу сессии", () => {
  // эталон 5 — чьё: факт (у Феникса письма остановленным сессиям терялись, 6 за день 16 ноября: отказ stopped никого не будит)
  it("5 · остановленную — поднять: тикет остановленной сессии запускает её и встаёт ей во ввод тегом вида ticket", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { s } = await st.open("ops");
    expect((await st.request("session.stop", { to: "ops@laptop" })).ok).toBe(true);
    expect(s.state).toBe("stopped");
    // письмо остановленной — отказ; тикет — поднимает
    expect(await st.request("message", { to: "ops@laptop", text: "проверь ферму" }, PULT)).toMatchObject({ ok: false, error: "stopped" });
    expect(await give(st, "ops", "site-1", { step: "обход" })).toMatchObject({ ok: true, result: { callsign: "ops@laptop" } });
    await until(() => s.state === "idle" || s.state === "busy", "сессия поднята");
    const p = st.proc("ops@laptop");
    await until(() => p.inputs.length > 0, "ввод у процесса");
    expect(lastInput(p)).toBe('<fleet from=".factory" kind="ticket" ticket="site-1" step="обход">\nТикет site-1: шапка сайта\n</fleet>');
    // шаг — новым ходом: ввод ждёт конца идущего хода
    expect(p.inputs.at(-1)!.priority).toBe("later");
    expect(lines(st)).toMatchObject([{ callsign: "ops@laptop", kind: "given" }]);
  });

  // эталон 3 — чьё: факт (опыт на Haiku, выборка 1: без возврата шаг сдан 0 из 1, с ним — 1 из 1) и слово пользователя (пост говорит с человеком и берёт тикеты)
  it("3 · ход, взявший шаг, без вердикта возвращён один раз; ход с человеком не возвращается; сданный шаг напоминания не получает", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await st.open("cto");
    await give(st, "cto", "site-7");
    await until(() => proc.inputs.length === 1, "шаг во вводе");
    // пока ход шаг не взял, напоминать не о чем
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await take(proc);
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [] }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toContain("site-7");
    expect(blocks[0]!.reason).toContain("ticket_set");
    // что возврат уже был, говорит сам хук: второго нет
    expect(reminded(await proc.hook("Stop", { stop_hook_active: true }))).toHaveLength(0);
    await st.turn("cto@laptop");
    // следом посту пишет человек: его ход кончается без напоминания, хотя тикет ещё не сдан
    await st.request("message", { to: "cto@laptop", text: "какой прогресс?" }, PULT);
    await until(() => proc.inputs.length === 2, "сообщение человека");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await st.turn("cto@laptop");
    expect(lines(st).map((l) => l.kind)).toEqual(["given", "reminded"]);

    // второй шаг: идёт фоновая работа — ход ещё вернётся сам; вердикт ушёл — напоминать не о чем
    await give(st, "cto", "site-8");
    await until(() => proc.inputs.length === 3, "второй шаг");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [{ id: "b1" }] }))).toHaveLength(0);
    await proc.hook("PostToolUse", { tool_name: "mcp__fleet__ticket_set", tool_input: { ticket: "site-8", verdict: "done" } });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
  });

  // эталон 16 — чьё: код (процесс сессии переживает подмену службы машины, ввод у него на руках)
  it("16 · машина перезапущена посреди шага: шаги у сессий те же, о шагах новый Host на старте не шлёт службам ни одного запроса", async () => {
    const holders = new FakeHolders();
    const first = await stand({ holders, modules: [chat(), work()] });
    const a = await first.open("dev-a");
    const b = await first.open("dev-b");
    await give(first, "dev-a", "site-1");
    await give(first, "dev-b", "site-2");
    await until(() => a.proc.inputs.length === 1 && b.proc.inputs.length === 1, "шаги во вводе");
    await first.kernel.shutdown("подмена");
    st = await stand({ holders, home: first.home, modules: [chat(), work()] });
    await until(() => st!.kernel.sessions.get("dev-a@laptop")!.state === "idle" && st!.kernel.sessions.get("dev-b@laptop")!.state === "idle", "attach");
    // процессы те же, ввод у них на руках: второй раз шаг не даётся
    expect(st.proc("dev-a@laptop")).toBe(a.proc);
    expect(a.proc.inputs).toHaveLength(1);
    expect(b.proc.inputs).toHaveLength(1);
    expect(st.services.calls.filter((f) => f.type.startsWith("ticket.") || f.type.startsWith("factory."))).toEqual([]);
    // сессия сдаёт шаг как обычно: новый Host ходу не мешает
    await take(a.proc);
    expect(reminded(await a.proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
  });

  it("работу даёт только служба «Фабрика»; сессии нет — отказ; сбой сессии с шагом на руках — тикету «стоп» с причиной", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc, s } = await st.open("coder");
    expect(await st.request("work.give", { to: "@laptop", name: "coder", ticket: "site-1", text: "чужой" }, PULT)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await give(st, "ghost", "site-1")).toMatchObject({ ok: false, error: "no_session" });
    await give(st, "coder", "site-3");
    await until(() => proc.inputs.length === 1, "шаг во вводе");
    await take(proc);
    // процесс умер, второй не поднялся: сессия failed — машина говорит службе, что шаг встал
    proc.exit(1, "упал");
    await until(() => st!.holders.procs.get("coder@laptop") !== proc && st!.holders.procs.get("coder@laptop")?.failInit !== undefined, "resume");
    const second = st.holders.procs.get("coder@laptop")!;
    second.failInit = true;
    second.exit(1, "не поднялся");
    await until(() => s.state === "failed", "failed");
    const told = await until(() => st!.services.of("ticket.set")[0], "вердикт машины");
    expect(told).toMatchObject({ ticket: "site-3", verdict: "stop" });
    expect(String(told.note)).toContain("сбоем");
    // сессии failed работу не дают
    expect(await give(st, "coder", "site-4")).toMatchObject({ ok: false, error: "failed" });
  });

  it("сессии шага ещё нет — машина открывает её по документу из определения: папка создаётся, открыла служба «Фабрика», родителя нет", async () => {
    st = await stand({ modules: [chat(), work()] });
    const cwd = join(st.dir, "line", "site-9");
    expect(existsSync(cwd)).toBe(false);
    const r = await give(st, "site-9-s1", "site-9", { step: "сделать", spec: { name: "site-9-s1", cwd, title: "Шапка · сделать" } });
    expect(r).toMatchObject({ ok: true, result: { callsign: "site-9-s1@laptop" } });
    const s = st.kernel.sessions.get("site-9-s1@laptop")!;
    expect(existsSync(cwd)).toBe(true);
    expect(s.rec.by).toBe(".factory");
    expect(s.rec.spec.parent).toBeUndefined();
    const p = st.proc("site-9-s1@laptop");
    await until(() => p.inputs.length === 1, "шаг во вводе");
    expect(lastInput(p)).toContain('kind="ticket" ticket="site-9" step="сделать"');
    // второй шаг той же сессии: она уже есть — документ не нужен, ввод встаёт в тот же разговор
    await give(st, "site-9-s1", "site-9", { step: "довести" });
    await until(() => p.inputs.length === 2, "второй шаг во вводе");
    expect(st.kernel.sessions.size).toBe(1);
  });

  // чьё: дизайн «Фабрика», принят словом пользователя 19 нояб. («делай»): вопрос сессии шага идёт создателю тикета — как вопрос дочери идёт родителю
  it("вопрос сессии по шагу идёт тому, кто дал задачу тикетом: сессии-создателю — во ввод видом question, человеку — зовом", async () => {
    st = await stand({ modules: [chat(), work()] });
    await st.open("boss");
    const { proc } = await st.open("dev");
    const boss = st.proc("boss@laptop");
    const question = { questions: [{ question: "Какую ветку брать?", options: [{ label: "main" }, { label: "release" }] }] };
    // тикет создала сессия boss: вопрос исполнителя приходит ей, она отвечает инструментом answer
    await give(st, "dev", "site-3", { asker: "boss@laptop" });
    const asked = proc.ask("AskUserQuestion", question, "q-1");
    await until(() => boss.inputs.some((m) => String(m.message.content).startsWith('<fleet from="dev@laptop" kind="question" ask="q-1">')), "вопрос у создателя тикета");
    expect((await st.request("answer", { to: "dev@laptop", ask: "q-1", answer: "main" }, "boss@laptop")).ok).toBe(true);
    await asked;
    // тикет создал человек: вопрос уходит ему зовом
    await give(st, "dev", "site-4", { asker: PULT });
    void proc.ask("AskUserQuestion", question, "q-2");
    expect(await until(() => st!.services.of("reach.send").find((f) => f.ask === "q-2"), "зов человека")).toMatchObject({ to: "~yuri@example.com", kind: "ask", callsign: "dev@laptop" });
  });

  // эталон 18 — чьё: слово пользователя («серия сессий с приёмкой»): «сдал» шагу с проверкой проходит через скрипт на машине сессии
  it("18 · проверка держит «сдал»: скрипт вернул 1 — вердикт не ушёл, тикету возврат с выводом; вернул 0 — вердикт принят", async () => {
    st = await stand({ modules: [chat(), shell(), work()] });
    const { proc } = await st.open("dev");
    let run = "echo test-7-red; exit 1";
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Срезы", text: "", step: 2, state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 0, since: 1, moved: 1, check: { run, for: "30s" } }] });
    st.services.handlers["ticket.set"] = (f) => ({ id: f.ticket, state: "work", step: 2 });
    const denied = (out: unknown[]) => out.map((o) => (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput).filter((o) => o?.permissionDecision === "deny");
    const done = () => proc.hook("PreToolUse", { tool_name: "mcp__fleet__ticket_set", tool_input: { ticket: "site-5", verdict: "done", note: "готово" } });
    // первый «сдал»: скрипт вернул 1 — вердикт не ушёл, машина записала возврат с выводом скрипта
    const first = denied(await done());
    expect(first).toHaveLength(1);
    expect(first[0]!.permissionDecisionReason).toContain("test-7-red");
    expect(first[0]!.permissionDecisionReason).toContain("Исправь и сдай снова");
    const back = st.services.of("ticket.set");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ ticket: "site-5", verdict: "back" });
    expect(String(back[0]!.note)).toContain("код 1");
    expect(String(back[0]!.note)).toContain("test-7-red");
    // второй «сдал»: скрипт вернул 0 — вердикт идёт службам как есть
    run = "exit 0";
    expect(denied(await done())).toHaveLength(0);
    expect(st.services.of("ticket.set")).toHaveLength(1);
    expect(lines(st).filter((l) => l.kind === "checked")).toHaveLength(2);
    // вердикт не «сдал» и шаг без проверки скрипт не запускают
    await proc.hook("PreToolUse", { tool_name: "mcp__fleet__ticket_set", tool_input: { ticket: "site-5", verdict: "stop", note: "вопрос" } });
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Ревью", text: "", step: 3, state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 0, since: 1, moved: 1 }] });
    expect(denied(await done())).toHaveLength(0);
    expect(lines(st).filter((l) => l.kind === "checked")).toHaveLength(2);
    // вторая неудача подряд: службы ставят тикет в «стоп» — сессии сказано больше не сдавать
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Срезы", text: "", step: 2, state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 1, since: 1, moved: 1, check: { run: "exit 3", for: "30s" } }] });
    st.services.handlers["ticket.set"] = (f) => ({ id: f.ticket, state: "stop", step: 2 });
    expect(denied(await done())[0]!.permissionDecisionReason).toContain("тикет ждёт человека");
  }, 60_000);
});
