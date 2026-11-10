// Откат разговора в той же сессии, инструменты и вести ведущей, разговоры папки, поля вопроса, время живых событий.
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const CS = "site@laptop";
const user = (uuid: string, content: unknown) => ({ type: "user", uuid, message: { role: "user", content } });
const bot = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
/** Разговор из 6 записей: три реплики человека и три ответа. */
const SIX = [user("h1", "Почини меню"), bot("a1", "починил"), user("h2", "Теперь подвал"), bot("a2", "сделал"), user("h3", "И шапку"), bot("a3", "готово")];

/** Стенд с разговором: функции SDK отвечают этими записями и этим списком разговоров папки. */
function withTalk(s: Stand, said: unknown[], listed: unknown[] = []): void {
  const calls = s.sdk.fnCalls;
  (s.sdk as any).functions = new Proxy({}, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      calls.push({ name, args });
      return name === "getSessionMessages" ? said : name === "listSessions" ? listed : {};
    },
  });
}
const events = (s: Stand) => s.link.of("session.events").flatMap((f) => f.events as any[]);

describe("откат разговора", () => {
  it("показ: уйдёт 4 записи и текст сообщения; разговор, процесс и файлы не тронуты", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    withTalk(st, SIX);
    const r = await st.request("session.rewind", { to: CS, upto: "h2", dry: true }, PULT);
    expect(r.result).toEqual({ cut: 4, text: "Теперь подвал" });
    expect(st.sdk.of(CS)).toHaveLength(1);
    expect(q.calls.filter((c) => c.name === "rewindFiles" || c.name === "interrupt" || c.name === "close")).toEqual([]);
  });

  it("только разговор: та же сессия поднята на разговоре, обрезанном до последней оставшейся записи; файлы не трогались; в ленте и в истории — след отката", async () => {
    st = await stand({ modules: [chat()] });
    const { q, s } = await st.open("site");
    const id = s.rec.sessionId;
    withTalk(st, SIX);
    await st.request("session.watch", { to: CS }, PULT);
    const r = await st.request("session.rewind", { to: CS, upto: "h2" }, PULT);
    expect(r.result).toEqual({ cut: 4, text: "Теперь подвал" });
    // то же окно: позывной и разговор те же, процесс — новый, запущен с обрезкой
    expect(st.kernel.sessions.get(CS)).toBe(s);
    expect(st.sdk.of(CS)).toHaveLength(2);
    expect(st.sdk.last(CS)!.options).toMatchObject({ resume: id, resumeSessionAt: "a1" });
    expect(s.state).toBe("idle");
    expect(q.calls.some((c) => c.name === "rewindFiles")).toBe(false);
    const mark = await until(() => events(st!).find((e) => e.type === "conversation_reset"), 5000, "след отката в ленте");
    expect(mark).toMatchObject({ text: "Откат к «Теперь подвал»", after: "a1" });
    const h = (await st.request("session.history", { to: CS }, PULT)).result as { events: any[] };
    expect(h.events.map((e) => e.uuid ?? e.type).slice(0, 3)).toEqual(["h1", "a1", mark.uuid]);
  });

  it("обрезка держится до первого ответа после отката: упавший до него процесс поднимается с ней же, после ответа — без неё", async () => {
    st = await stand({ modules: [chat()] });
    const { s } = await st.open("site");
    withTalk(st, SIX);
    await st.request("session.rewind", { to: CS, upto: "h2" }, PULT);
    expect(s.rec.upto).toBe("a1");
    st.proc(CS).exit(1, "упал");
    await until(() => st!.sdk.of(CS).length === 3 && s.state === "idle", 5000, "resume после сбоя");
    expect((st.sdk.last(CS)!.options as any).resumeSessionAt).toBe("a1");
    st.proc(CS).send(bot("a9", "продолжаю"));
    await until(() => s.rec.upto === undefined, 5000, "обрезка снята");
    await s.restart();
    expect((st.sdk.last(CS)!.options as any).resumeSessionAt).toBeUndefined();
  });

  it("разговор и файлы: сначала показ, потом файлы возвращены у живого процесса, потом перезапуск; в следе — число файлов", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    withTalk(st, SIX);
    (q as any).rewindFiles = async (...args: unknown[]) => (q.calls.push({ name: "rewindFiles", args }), { canRewind: true, filesChanged: ["/w/a.ts", "/w/b.ts", "/w/c.css"], insertions: 41, deletions: 17 });
    await st.request("session.watch", { to: CS }, PULT);
    const r = await st.request("session.rewind", { to: CS, upto: "h2", files: true }, PULT);
    expect(r.result).toMatchObject({ cut: 4, files: ["/w/a.ts", "/w/b.ts", "/w/c.css"], plus: 41, minus: 17 });
    const order = q.calls.map((c) => (c.name === "rewindFiles" ? `files:${(c.args[1] as any).dryRun}` : c.name)).filter((n) => n.startsWith("files") || n === "close");
    expect(order).toEqual(["files:true", "files:false", "close"]);
    expect(q.calls.find((c) => c.name === "rewindFiles")!.args[0]).toBe("h2");
    const mark = await until(() => events(st!).find((e) => e.type === "conversation_reset"), 5000, "след");
    expect(mark.text).toBe("Откат к «Теперь подвал» · файлы возвращены: 3");
  });

  it("снимка файлов нет — отказ no_checkpoint, разговор и процесс прежние", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    withTalk(st, SIX);
    (q as any).rewindFiles = async () => ({ canRewind: false, error: "no checkpoint" });
    // показ называет причину и не отказывает: разговор откатить можно и без файлов
    expect((await st.request("session.rewind", { to: CS, upto: "h2", files: true, dry: true }, PULT)).result).toEqual({ cut: 4, text: "Теперь подвал", nofiles: "no checkpoint" });
    expect(await st.request("session.rewind", { to: CS, upto: "h2", files: true }, PULT)).toMatchObject({ ok: false, error: "no_checkpoint" });
    expect(st.sdk.of(CS)).toHaveLength(1);
    expect(q.closed).toBe(false);
  });

  it("идущий ход прерывается до отката", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    withTalk(st, SIX);
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => s.state === "busy", 5000, "ход");
    expect((await st.request("session.rewind", { to: CS, upto: "h3" }, PULT)).ok).toBe(true);
    expect(proc.interrupts).toBe(1);
    expect(st.sdk.last(CS)!.options).toMatchObject({ resumeSessionAt: "a2" });
  });

  it("без сообщения — очистка: в сессию ушёл ввод /clear; разговор сессии — новый; в ленте «Разговор очищен»", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    withTalk(st, SIX);
    await st.request("session.watch", { to: CS }, PULT);
    expect((await st.request("session.rewind", { to: CS }, PULT)).result).toEqual({ cut: 6 });
    await until(() => proc.inputs.some((i) => i.message.content === "/clear"), 5000, "ввод /clear");
    expect(st.sdk.of(CS)).toHaveLength(1);
    proc.send({ type: "conversation_reset", new_conversation_id: "11111111-2222-4333-8444-555555555555", trigger: "clear" });
    const mark = await until(() => events(st!).find((e) => e.type === "conversation_reset"), 5000, "сброс в ленте");
    expect(mark.text).toBe("Разговор очищен");
    expect(s.rec.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("сообщения с таким номером нет — not_found; номер ответа инструмента — bad_input; сессия работает дальше", async () => {
    st = await stand({ modules: [chat()] });
    const { s } = await st.open("site");
    withTalk(st, [...SIX, user("t1", [{ type: "tool_result", tool_use_id: "x", content: "ok" }])]);
    expect(await st.request("session.rewind", { to: CS, upto: "нет" }, PULT)).toMatchObject({ ok: false, error: "not_found" });
    expect(await st.request("session.rewind", { to: CS, upto: "t1" }, PULT)).toMatchObject({ ok: false, error: "bad_input" });
    expect(s.state).toBe("idle");
    expect(st.sdk.of(CS)).toHaveLength(1);
  });
});

describe("ведущая и ведомый", () => {
  const LEAD = "lead@laptop", WING = "lead-wing@laptop";
  const pair = async () => {
    st = await stand({ modules: [chat()] });
    await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir }, pair: true }, PULT);
    await until(() => st!.kernel.sessions.get(WING)?.state === "idle", 5000, "ведомый готов");
    return st;
  };
  const news = (s: Stand) => s.proc(LEAD).inputs.map((i) => String(i.message.content)).filter((t) => t.includes("Ведомый"));

  it("session.call инструментом: метод из закрытого списка исполнен у ведомого; метод вне списка — отказ словом; странице доступен весь список", async () => {
    const s = await pair();
    const q = s.sdk.last(WING)!;
    expect((await s.request("session.call", { to: WING, method: "mcpReconnect", args: ["github"] }, LEAD)).ok).toBe(true);
    expect(q.calls.find((c) => c.name === "reconnectMcpServer")!.args).toEqual(["github"]);
    expect((await s.request("session.call", { to: WING, method: "interrupt" }, LEAD)).ok).toBe(true);
    expect((await s.request("session.call", { to: WING, method: "compact" }, LEAD)).ok).toBe(true);
    await until(() => s.proc(WING).inputs.some((i) => i.message.content === "/compact"), 5000, "ввод /compact");
    expect(await s.request("session.call", { to: WING, method: "permissionRules" }, LEAD)).toMatchObject({ ok: false, error: "forbidden" });
    expect((await s.request("session.call", { to: WING, method: "permissionRules" }, PULT)).ok).toBe(true);
  });

  it("откат и сжатие ведомого: ведущей — по одному сообщению от ведомого на событие", async () => {
    const s = await pair();
    withTalk(s, SIX);
    await s.request("session.rewind", { to: WING, upto: "h2" }, LEAD);
    await until(() => news(s).some((t) => t.includes("откачен")), 5000, "весть об откате");
    s.proc(WING).send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 68_000, post_tokens: 12_000 } });
    await until(() => news(s).some((t) => t.includes("сжат")), 5000, "весть о сжатии");
    await tick(30);
    expect(news(s).filter((t) => t.includes("откачен"))).toHaveLength(1);
    expect(news(s).filter((t) => t.includes("сжат"))).toEqual([expect.stringContaining("68 К → 12 К")]);
    expect(news(s).find((t) => t.includes("откачен"))).toContain("ушло записей — 4");
  });

  it("ведомый ждёт человека — разрешение: ведущей одна весть на вопрос", async () => {
    const s = await pair();
    await s.request("session.update", { to: WING, patch: { mode: "ask" } }, PULT);
    await until(() => s.kernel.sessions.get(WING)!.state === "idle", 5000, "ведомый после смены режима");
    void s.proc(WING).ask("Bash", { command: "rm -rf dist" }, "toolu_w1");
    await until(() => news(s).some((t) => t.includes("ждёт ответа человека")), 5000, "весть");
    s.kernel.sessions.get(WING)!.sync();
    await tick(30);
    expect(news(s).filter((t) => t.includes("ждёт ответа человека"))).toHaveLength(1);
  });

  it("ведомый задал вопрос самой ведущей: ей одно сообщение — сам вопрос, вести «ждёт человека» нет", async () => {
    const s = await pair();
    // задачу ведомому дала ведущая — вопрос идёт ей
    await s.request("message", { to: WING, text: "найди вызовы" }, LEAD);
    void s.proc(WING).ask("AskUserQuestion", { questions: [{ question: "Какую ветку смотреть?", options: [{ label: "main" }, { label: "release" }] }] }, "toolu_q1");
    await until(() => s.proc(LEAD).inputs.some((i) => String(i.message.content).includes("<fleet-question")), 5000, "вопрос ведущей");
    await tick(30);
    expect(news(s).filter((t) => t.includes("ждёт ответа человека"))).toEqual([]);
    expect(s.proc(LEAD).inputs.filter((i) => String(i.message.content).includes("<fleet-question"))).toHaveLength(1);
  });
});

describe("лента и вопросы", () => {
  it("живое событие ленты несёт время машины; запись со своим временем не трогается", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    const t0 = Date.now();
    proc.send({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "ищу" } }] } });
    proc.send({ type: "user", uuid: "u1", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: "из файла" } });
    const got = await until(() => (events(st!).length >= 2 ? events(st!) : undefined), 5000, "события");
    expect(got[0].at).toBeGreaterThanOrEqual(t0);
    expect(got[0].at).toBeLessThanOrEqual(Date.now());
    expect(got[1].at).toBeUndefined();
  });

  it("вопрос о разрешении несёт правило, путь и причину; событие ответа несёт сам вопрос", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site", { mode: "ask" });
    await st.request("session.watch", { to: CS }, PULT);
    const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist *" }], behavior: "allow", destination: "localSettings" }];
    void proc.askWith("Bash", { command: "rm -rf dist" }, { suggestions: SUGGEST, blockedPath: "~/projects/site/dist", decisionReason: "папка вне правил проекта" }, "toolu_p1");
    const row = await until(() => (st!.link.rows(CS).at(-1)?.row as any)?.ask, 5000, "вопрос в строке");
    expect(row).toMatchObject({ kind: "permission", rule: "Bash(rm -rf dist *)", blocked: "~/projects/site/dist", notes: "папка вне правил проекта" });
    await st.request("answer", { to: CS, ask: "toolu_p1", answer: { action: "allow" } }, PULT);
    const done = await until(() => events(st!).find((e) => e.type === "ask.answered"), 5000, "ответ в ленте");
    expect(done).toMatchObject({ by: PULT, answer: { action: "allow" }, q: { id: "toolu_p1", kind: "permission", rule: "Bash(rm -rf dist *)" } });
    expect(typeof done.at).toBe("number");
  });
});

describe("разговоры папки", () => {
  it("три разговора, новые раньше; у занятого — позывной сессии; папки нет — отказ", async () => {
    st = await stand({ modules: [chat()] });
    const { s } = await st.open("site");
    withTalk(st, [], [
      { sessionId: "old", summary: "Старое", lastModified: 100, fileSize: 10 },
      { sessionId: s.rec.sessionId, summary: "s", firstPrompt: "Почини меню", lastModified: 300, fileSize: 30 },
      { sessionId: "mid", summary: "s", customTitle: "Названный", lastModified: 200 },
    ]);
    const r = await st.request("machine.conversations", { to: "@laptop", cwd: st.dir }, PULT);
    expect(r.result).toEqual({ conversations: [
      { id: s.rec.sessionId, title: "Почини меню", at: 300, size: 30, live: CS },
      { id: "mid", title: "Названный", at: 200, size: 0 },
      { id: "old", title: "Старое", at: 100, size: 10 },
    ] });
    expect(st.sdk.fnCalls.find((c) => c.name === "listSessions")!.args).toEqual([{ dir: st.dir }]);
    expect(await st.request("machine.conversations", { to: "@laptop", cwd: st.dir + "/нет" }, PULT)).toMatchObject({ ok: false, error: "bad_dir" });
  });
});
