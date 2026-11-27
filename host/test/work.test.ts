// Эталоны «дать работу»: служба «Фабрика» отдаёт сессии тикет; ход, кончившийся без вердикта, пока тикет в работе у сессии, возвращается
// один раз, кончился снова — тикету «стоп»; на границе тикетов разговор очищается или сжимается.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { make as work } from "../src/modules/work/work.ts";
import { FakeHolders, stand, until, type FakeProc, type Stand } from "../stand/index.ts";

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
/** Ход взял ввод: процесс называет номера взятых сообщений на ответе модели; метка процесса пришла — ядро прочло событие раньше хука. */
const take = async (p: FakeProc) => {
  p.send({ type: "assistant", uuid: "a" + p.inputs.length, message: { role: "assistant", content: [{ type: "text", text: "беру" }] }, user_message_uuids: [p.inputs.at(-1)!.uuid] });
  await p.settle();
};
const reminded = (out: unknown[]) => out.filter((o) => (o as { decision?: string } | undefined)?.decision === "block") as { reason: string }[];
const lines = (s: Stand) => s.journal().filter((l) => l.msg === "work");
/** Тикеты проекта site у служб: ticket.list отвечает, как настоящие службы, — по номеру либо по проекту, сессии и состоянию;
 *  ticket.set принимает вердикт. */
const ticketsAre = (s: Stand, ...ts: Array<{ id: string; state: string; session?: string }>) => {
  s.services.handlers["ticket.list"] = (f) => ({
    tickets: ts
      .filter((t) => (f.ticket === undefined || t.id === f.ticket) && (f.project === undefined || f.project === "site") && (f.session === undefined || t.session === f.session) && (f.state === undefined || t.state === f.state))
      .map((t) => ({ project: "site", title: "Шапка", text: "", by: "~yuri@example.com", returns: 0, since: 1, moved: 1, ...t })),
  });
  s.services.handlers["ticket.set"] = (f) => ({ id: f.ticket, state: f.verdict === "stop" ? "stop" : "work" });
};
/** Сессия поста — в проекте site: тикеты в работе у неё службы называют по проекту. */
const post = (s: Stand, name: string) => {
  s.services.handlers["people.list"] = () => ({ people: [], projects: [{ id: "site", name: "Сайт", members: [] }] });
  return s.open(name, { project: "site" });
};

const FABLE = "claude-fable-5-2";
/** Ответ модели в основном разговоре: размер разговора — как его называет Claude (так же в эталонах кэша). */
const answer = (size: number) => ({
  type: "assistant", uuid: `a-${size}-${Math.random()}`, parent_tool_use_id: null,
  message: { model: FABLE, content: [{ type: "text", text: "готово" }], usage: { input_tokens: 2, cache_read_input_tokens: size - 6402, cache_creation_input_tokens: 6400, cache_creation: { ephemeral_1h_input_tokens: 6400, ephemeral_5m_input_tokens: 0 } } },
});
/** Стенд с хозяином пары: размер разговора сессии знает модуль аккаунтов. */
async function paired(): Promise<Stand> {
  const s = await stand({ modules: [chat(), accounts(), work()], start: false });
  s.services.handlers["keys.list"] = () => ({ keys: [] });
  s.services.handlers["keys.models"] = () => ({ models: [{ id: FABLE, window: 1_000_000, protocol: "claude" }] });
  await s.kernel.start();
  return s;
}
/** Тексты ввода процесса с n-го. */
const inputsFrom = (p: FakeProc, n: number) => p.inputs.slice(n).map((i) => ({ text: String(i.message.content), priority: i.priority }));

describe("дать работу сессии", () => {
  // эталон 5 — чьё: факт (у Феникса письма остановленным сессиям терялись, 6 за день 16 ноября: отказ stopped никого не будит)
  it("5 · остановленную — поднять: тикет остановленной сессии запускает её и встаёт ей во ввод тегом вида ticket", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { s } = await st.open("ops");
    expect((await st.request("session.stop", { to: "ops@laptop" })).ok).toBe(true);
    expect(s.state).toBe("stopped");
    // письмо остановленной — отказ; тикет — поднимает
    expect(await st.request("message", { to: "ops@laptop", text: "проверь ферму" }, PULT)).toMatchObject({ ok: false, error: "stopped" });
    expect(await give(st, "ops", "site-1")).toMatchObject({ ok: true, result: { callsign: "ops@laptop" } });
    await until(() => s.state === "idle" || s.state === "busy", "сессия поднята");
    const p = st.proc("ops@laptop");
    await until(() => p.inputs.length > 0, "ввод у процесса");
    expect(lastInput(p)).toBe('<fleet from=".factory" kind="ticket" ticket="site-1">\nТикет site-1: шапка сайта\n</fleet>');
    // шаг — новым ходом: ввод ждёт конца идущего хода
    expect(p.inputs.at(-1)!.priority).toBe("later");
    expect(lines(st)).toMatchObject([{ callsign: "ops@laptop", kind: "given" }]);
  });

  // эталон 3 — чьё: факт (опыт на Haiku, выборка 1: без возврата шаг сдан 0 из 1, с ним — 1 из 1) и слово пользователя (пост говорит с человеком и берёт тикеты)
  it("3 · ход, взявший шаг, без вердикта возвращён один раз; ход с человеком не возвращается; сданный шаг напоминания не получает", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "cto");
    // шаг у сессии, пока тикет в работе у неё — так говорят службы
    ticketsAre(st, { id: "site-7", state: "work", session: "cto@laptop" });
    await give(st, "cto", "site-7");
    await until(() => proc.inputs.length === 1, "шаг во вводе");
    // пока ход шаг не взял, напоминать не о чем
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await take(proc);
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [] }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toContain("site-7");
    expect(blocks[0]!.reason).toContain("ticket_set");
    // что возврат уже был, говорит сам хук: второго нет (тикету — «стоп», это эталон 21)
    expect(reminded(await proc.hook("Stop", { stop_hook_active: true }))).toHaveLength(0);
    await st.turn("cto@laptop");
    // следом посту пишет человек: его ход кончается без напоминания, хотя тикет ещё в работе
    await st.request("message", { to: "cto@laptop", text: "какой прогресс?" }, PULT);
    await until(() => proc.inputs.length === 2, "сообщение человека");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await st.turn("cto@laptop");
    expect(lines(st).map((l) => l.kind)).toEqual(["given", "reminded", "stopped"]);

    // второй шаг: идёт фоновая работа — ход ещё вернётся сам; вердикт ушёл (тикет закрыт) — напоминать не о чем
    ticketsAre(st, { id: "site-7", state: "work", session: "cto@laptop" }, { id: "site-8", state: "work", session: "cto@laptop" });
    await give(st, "cto", "site-8");
    await until(() => proc.inputs.length === 3, "второй шаг");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [{ id: "b1" }] }))).toHaveLength(0);
    ticketsAre(st, { id: "site-7", state: "stop", session: "cto@laptop" }, { id: "site-8", state: "done", session: "cto@laptop" });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
  });

  // эталон 16 — чьё: код (процесс сессии переживает подмену службы машины, ввод у него на руках; что тикет в работе, знают службы)
  it("16 · машина перезапущена посреди шага: шаги у сессий те же, о шагах новый Host на старте не шлёт службам ни одного запроса; ход без вердикта возвращается так же", async () => {
    const holders = new FakeHolders();
    const first = await stand({ holders, modules: [chat(), work()] });
    const a = await post(first, "dev-a");
    const b = await post(first, "dev-b");
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
    // правило конца хода у нового Host то же: тикет в работе у сессии — по ответу служб — ход без вердикта возвращается
    ticketsAre(st, { id: "site-1", state: "work", session: "dev-a@laptop" }, { id: "site-2", state: "work", session: "dev-b@laptop" });
    await take(a.proc);
    const blocks = reminded(await a.proc.hook("Stop", { stop_hook_active: false }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toMatch(/^Тикет не сдан: site-1\./);
  });

  it("работу даёт только служба «Фабрика»; сессии нет — отказ; сбой сессии с шагом на руках — тикету «стоп» с причиной", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc, s } = await post(st, "coder");
    expect(await st.request("work.give", { to: "@laptop", name: "coder", ticket: "site-1", text: "чужой" }, PULT)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await give(st, "ghost", "site-1")).toMatchObject({ ok: false, error: "no_session" });
    // шаг всё ещё у этой сессии — так говорят службы
    ticketsAre(st, { id: "site-3", state: "work", session: "coder@laptop" });
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

  // эталон 19 — чьё: факт — 121 из 218 заметок к тикету в работе не дошли до сессии (история флота 20–21 нояб.): отказ «сдал» с заметками не должен оставить ход без напоминания
  it("19 · отказ «сдал» шаг не снимает: тикет всё ещё в работе у сессии — напоминание с отсрочкой; отложен, передан, закрыт — нет; службы молчат — нет и строка held", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "dev");
    await give(st, "dev", "site-5");
    await until(() => proc.inputs.length === 1, "шаг во вводе");
    await take(proc);
    // «сдал» получил отказ — тикет по-прежнему в работе у этой сессии: ход возвращается, ему названа отсрочка
    ticketsAre(st, { id: "site-5", state: "work", session: "dev@laptop" });
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toContain("site-5");
    expect(blocks[0]!.reason).toContain("усыпи свой: after");
    // шаг отложен, передан другой сессии или закрыт — он уже не у этой сессии
    ticketsAre(st, { id: "site-5", state: "wait", session: "dev@laptop" });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    ticketsAre(st, { id: "site-5", state: "work", session: "dev-2@laptop" });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    ticketsAre(st, { id: "site-5", state: "done", session: "dev@laptop" });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    // службы не ответили — напоминания нет, причина в журнале
    st.services.handlers["ticket.list"] = () => {
      throw new Error("службы недоступны");
    };
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    expect(lines(st).filter((l) => l.kind === "held")).toMatchObject([{ callsign: "dev@laptop" }]);
    expect(lines(st).filter((l) => l.kind === "reminded")).toHaveLength(1);
  });

  // эталон 20 — чьё: код — вердикт шагу даёт та, кто его ведёт
  it("20 · шаг уже не её — «стоп» не уходит: сессия с шагом упала, а тикет в работе у другой сессии", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc, s } = await post(st, "coder");
    ticketsAre(st, { id: "site-3", state: "work", session: "coder-2@laptop" });
    await give(st, "coder", "site-3");
    await until(() => proc.inputs.length === 1, "шаг во вводе");
    await take(proc);
    proc.exit(1, "упал");
    await until(() => st!.holders.procs.get("coder@laptop") !== proc && st!.holders.procs.get("coder@laptop")?.failInit !== undefined, "resume");
    const second = st.holders.procs.get("coder@laptop")!;
    second.failInit = true;
    second.exit(1, "не поднялся");
    await until(() => s.state === "failed", "failed");
    // машина спросила тикет, чей шаг
    await until(() => st!.services.of("ticket.list").length > 0, "вопрос тикету");
    // ещё один запрос туда и обратно — ответ тикета разобран
    expect(await give(st, "coder", "site-4")).toMatchObject({ ok: false, error: "failed" });
    expect(st.services.of("ticket.set")).toEqual([]);
  });

  it("сессии шага ещё нет — машина открывает её по документу из определения: папка создаётся, открыла служба «Фабрика», родителя нет", async () => {
    st = await stand({ modules: [chat(), work()] });
    const cwd = join(st.dir, "line", "site-9");
    expect(existsSync(cwd)).toBe(false);
    const r = await give(st, "site-9-s1", "site-9", { spec: { name: "site-9-s1", cwd, title: "Шапка · сделать" } });
    expect(r).toMatchObject({ ok: true, result: { callsign: "site-9-s1@laptop" } });
    const s = st.kernel.sessions.get("site-9-s1@laptop")!;
    expect(existsSync(cwd)).toBe(true);
    expect(s.rec.by).toBe(".factory");
    expect(s.rec.spec.parent).toBeUndefined();
    const p = st.proc("site-9-s1@laptop");
    await until(() => p.inputs.length === 1, "шаг во вводе");
    expect(lastInput(p)).toContain('kind="ticket" ticket="site-9"');
    // второй шаг той же сессии: она уже есть — документ не нужен, ввод встаёт в тот же разговор
    await give(st, "site-9-s1", "site-9");
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
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Срезы", text: "", state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 0, since: 1, moved: 1, check: { run, for: "30s" } }] });
    st.services.handlers["ticket.set"] = (f) => ({ id: f.ticket, state: "work" });
    const denied = (out: unknown[]) => out.map((o) => (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput).filter((o) => o?.permissionDecision === "deny");
    const done = () => proc.hook("PreToolUse", { tool_name: "mcp__fleet__ticket_set", tool_input: { ticket: "site-5", verdict: "done", note: "готово" } });
    // первый «сдал»: скрипт вернул 1 — вердикт не ушёл, машина записала возврат с выводом скрипта
    const first = denied(await done());
    expect(first).toHaveLength(1);
    expect(first[0]!.permissionDecisionReason).toMatch(/^Тикет не принят: /);
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
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Ревью", text: "", state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 0, since: 1, moved: 1 }] });
    expect(denied(await done())).toHaveLength(0);
    expect(lines(st).filter((l) => l.kind === "checked")).toHaveLength(2);
    // вторая неудача подряд: службы ставят тикет в «стоп» — сессии сказано больше не сдавать
    st.services.handlers["ticket.list"] = (f) => ({ tickets: [{ id: f.ticket, project: "site", title: "Срезы", text: "", state: "work", session: "dev@laptop", by: "~yuri@example.com", returns: 1, since: 1, moved: 1, check: { run: "exit 3", for: "30s" } }] });
    st.services.handlers["ticket.set"] = (f) => ({ id: f.ticket, state: "stop" });
    const stopped = denied(await done())[0]!.permissionDecisionReason!;
    expect(stopped).toMatch(/^Тикет встал: /);
    expect(stopped).toContain("Это второй возврат — больше его не сдавай.");
  }, 60_000);

  // эталон 21 — чьё: слово пользователя 27 нояб. — «фабрика не форсит ответа по тикету, когда воркер останавливается»
  it("21 · второй ход без вердикта — «стоп»: напоминание, ход кончился снова — тикету «стоп» с последними словами сессии, блокировки нет", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "coder");
    ticketsAre(st, { id: "site-7", state: "work", session: "coder@laptop" });
    await give(st, "coder", "site-7");
    await until(() => proc.inputs.length === 1, "тикет во вводе");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, last_assistant_message: "смотрю срезы" }))).toHaveLength(1);
    expect(st.services.of("ticket.set")).toEqual([]);
    // тот же ход кончился снова: о возврате говорит сам хук
    expect(reminded(await proc.hook("Stop", { stop_hook_active: true, last_assistant_message: "жду срез 9" }))).toHaveLength(0);
    const set = st.services.of("ticket.set");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ ticket: "site-7", verdict: "stop" });
    expect(String(set[0]!.note)).toContain("ход кончился без вердикта: жду срез 9");
    expect(lines(st).filter((l) => l.kind === "stopped")).toMatchObject([{ callsign: "coder@laptop" }]);
  });

  // эталон 22 — чьё: факт — 27 нояб. тикет кодера простоял 5,1 ч после хода с отчётом без вердикта
  it("22 · ход после фоновой задачи или побудки проверяется: тот ход — ничего, следующий без вердикта (тикет он не брал) — напоминание", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "coder");
    ticketsAre(st, { id: "site-7", state: "work", session: "coder@laptop" });
    await give(st, "coder", "site-7");
    await until(() => proc.inputs.length === 1, "тикет во вводе");
    await take(proc);
    // фон жив — ход вернётся сам
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [{ id: "b1" }] }))).toHaveLength(0);
    await st.turn("coder@laptop");
    // следующий ход — по итогу фона; ввод тикета взят раньше
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [] }))).toHaveLength(1);
    await st.turn("coder@laptop");
    // то же с побудкой
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, session_crons: [{ id: "c1" }] }))).toHaveLength(0);
    await st.turn("coder@laptop");
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, session_crons: [] }))).toHaveLength(1);
    expect(lines(st).filter((l) => l.kind === "reminded")).toHaveLength(2);
  });

  // эталон 23 — чьё: слово пользователя — пост говорит с человеком и берёт тикеты (действующий эталон)
  it("23 · ход с человеком не трогаем: тикет в работе, ход взял сообщение человека — напоминания нет; следующий ход не человека — напоминание", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "cto");
    ticketsAre(st, { id: "site-7", state: "work", session: "cto@laptop" }, { id: "site-8", state: "work", session: "cto@laptop" });
    await give(st, "cto", "site-7");
    await until(() => proc.inputs.length === 1, "тикет во вводе");
    await take(proc);
    await st.turn("cto@laptop");
    await st.request("message", { to: "cto@laptop", text: "что с шапкой?" }, PULT);
    await until(() => proc.inputs.length === 2, "сообщение человека");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await st.turn("cto@laptop");
    // следующий ход начал тикет, а не человек
    await give(st, "cto", "site-8");
    await until(() => proc.inputs.length === 3, "второй тикет");
    await take(proc);
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toContain("site-7");
  });

  // эталон 24 — чьё: код — тикет встаёт во ввод за идущим ходом
  it("24 · выдан, но не взят — не в счёт: в работе у сессии 12 и 13, ввод 13 ход не взял — напоминание называет только 12", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "coder");
    ticketsAre(st, { id: "site-12", state: "work", session: "coder@laptop" }, { id: "site-13", state: "work", session: "coder@laptop" });
    await give(st, "coder", "site-12");
    await until(() => proc.inputs.length === 1, "тикет 12 во вводе");
    await take(proc);
    await give(st, "coder", "site-13");
    await until(() => proc.inputs.length === 2, "тикет 13 во вводе");
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toMatch(/^Тикет не сдан: site-12\./);
  });

  // эталон 25 — чьё: код — фон и повтор и раньше отсеивались до вопроса тикету
  it("25 · своё — без вопроса службам: при фоне, при побудке и на ходе человека запроса ticket.list нет; на обычном ходе — есть", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await post(st, "cto");
    ticketsAre(st, { id: "site-7", state: "work", session: "cto@laptop" });
    await give(st, "cto", "site-7");
    await until(() => proc.inputs.length === 1, "тикет во вводе");
    await take(proc);
    const asked = () => st!.services.of("ticket.list").length;
    await proc.hook("Stop", { stop_hook_active: false, background_tasks: [{ id: "b1" }] });
    await proc.hook("Stop", { stop_hook_active: false, session_crons: [{ id: "c1" }] });
    expect(asked()).toBe(0);
    await st.turn("cto@laptop");
    await st.request("message", { to: "cto@laptop", text: "что с шапкой?" }, PULT);
    await until(() => proc.inputs.length === 2, "сообщение человека");
    await take(proc);
    await proc.hook("Stop", { stop_hook_active: false });
    expect(asked()).toBe(0);
    await st.turn("cto@laptop");
    // ход начал тикет, фона и побудки нет — вопрос службам
    await give(st, "cto", "site-8");
    await until(() => proc.inputs.length === 3, "второй тикет");
    await take(proc);
    await proc.hook("Stop", { stop_hook_active: false });
    expect(asked()).toBe(1);
  });

  // эталон 26 — чьё: факт — 78 % расхода токенов за неделю — чтение истории; разговоры постов доходят до предела окна
  it("26 · большой разговор сжимается на границе: больше порога — «/compact», потом тикет; меньше — только тикет; с clear — «/clear» и тикет", async () => {
    st = await paired();
    const big = await st.open("site", { key: "claude", model: FABLE });
    const lite = await st.open("lite", { key: "claude", model: FABLE });
    await st.turn("site@laptop", [answer(212_000)]);
    await st.turn("lite@laptop", [answer(120_000)]);
    await give(st, "site", "site-1");
    await until(() => big.proc.inputs.length === 2, "сжатие и тикет");
    expect(inputsFrom(big.proc, 0)).toMatchObject([{ text: "/compact", priority: "later" }, { text: expect.stringContaining('ticket="site-1"'), priority: "later" }]);
    expect(st.journal().filter((l) => l.msg === "edge_compact")).toMatchObject([{ callsign: "site@laptop", size: 212_000 }]);
    await give(st, "lite", "site-2");
    await until(() => lite.proc.inputs.length === 1, "тикет");
    expect(inputsFrom(lite.proc, 0)).toMatchObject([{ text: expect.stringContaining('ticket="site-2"'), priority: "later" }]);
    // «заново»: очистка вместо сжатия
    await give(st, "site", "site-3", { clear: true });
    await until(() => big.proc.inputs.length === 4, "очистка и тикет");
    expect(inputsFrom(big.proc, 2)).toMatchObject([{ text: "/clear", priority: "later" }, { text: expect.stringContaining('ticket="site-3"'), priority: "later" }]);
    expect(big.proc.inputs.filter((i) => i.message.content === "/compact")).toHaveLength(1);
  });

  // эталон 27 — чьё: слово пользователя — пост говорит с человеком и берёт тикеты: ход с человеком не трогают
  it("27 · разговор с человеком граница не трогает: ни «/clear», ни «/compact»; после хода не человека — «/clear»; только что открытой сессии «/clear» нет", async () => {
    st = await paired();
    const { proc } = await st.open("site", { key: "claude", model: FABLE });
    await st.request("message", { to: "site@laptop", text: "посмотри шапку" }, PULT);
    await until(() => proc.inputs.length === 1, "сообщение человека");
    await st.turn("site@laptop", [answer(212_000)]);
    await give(st, "site", "site-1", { clear: true });
    await until(() => proc.inputs.length === 2, "тикет");
    expect(inputsFrom(proc, 1)).toMatchObject([{ text: expect.stringContaining('ticket="site-1"') }]);
    // большой разговор без clear — тоже не сжимается
    await give(st, "site", "site-2");
    await until(() => proc.inputs.length === 3, "второй тикет");
    expect(inputsFrom(proc, 2)).toMatchObject([{ text: expect.stringContaining('ticket="site-2"') }]);
    // ход начал тикет: следующая граница — как обычно
    await st.turn("site@laptop");
    await give(st, "site", "site-3", { clear: true });
    await until(() => proc.inputs.length === 5, "очистка и тикет");
    expect(inputsFrom(proc, 3)).toMatchObject([{ text: "/clear" }, { text: expect.stringContaining('ticket="site-3"') }]);
    // сессию открыла эта выдача: разговора ещё нет
    const r = await give(st, "fresh", "site-4", { clear: true, spec: { name: "fresh", cwd: join(st.dir, "fresh"), key: "claude", model: FABLE } });
    expect(r).toMatchObject({ ok: true, result: { callsign: "fresh@laptop" } });
    const fresh = st.proc("fresh@laptop");
    await until(() => fresh.inputs.length === 1, "тикет новой сессии");
    await st.settle("fresh@laptop");
    expect(inputsFrom(fresh, 0)).toMatchObject([{ text: expect.stringContaining('ticket="site-4"') }]);
    expect(fresh.inputs).toHaveLength(1);
  });
});
