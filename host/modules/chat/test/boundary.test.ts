// Леса границы «разговор с сессией», сторона Host. Снаружи: SDK, держатели, relay, часы стенда; режим и родитель (manage), пуш — подделки.
// Только входы контракта и наблюдаемый исход: ответ, кадр, ввод SDK, ответ SDK, roster, журнал. Номер — эталон-источник; свойства без пометки — чьё: код.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, getSessionMessages, importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import { parts } from "./parts.ts";

const { FakeHolders, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(async () => {
  vi.useRealTimers();
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

const CS = "site@laptop";
const PANEL = "panel-desk~owner@example.com";
const PHONE = "phone~owner@example.com";
const WINDOW_MS = 100; // контракт: пачка за 100 мс
const later = () => new Promise((r) => setTimeout(r, 20));

const ASK = {
  questions: [
    {
      question: "Какую базу мигрировать первой?",
      header: "База",
      multiSelect: false,
      options: [
        { label: "прод", description: "боевая, 2 ТБ" },
        { label: "стенд", description: "копия за неделю" },
      ],
    },
  ],
};
const pick = (label: string) => ({ "Какую базу мигрировать первой?": label });
const REFUSAL = "The user doesn't want to proceed with this tool use.";

type Bench = { st: Stand; notifies: Frame[]; seen: string[]; mode: string | undefined; parent: string | undefined; modules: Array<{ module: Module; manifest: Manifest }> };

async function bench(o: { holders?: stand.FakeHolders; home?: string; mode?: string; pauseMs?: number; machine?: string } = {}): Promise<Bench> {
  const b = { notifies: [] as Frame[], seen: [] as string[], mode: "mode" in o ? o.mode : "bypassPermissions", parent: undefined } as Bench;
  b.modules = await parts();
  const st = await standHost({
    holders: o.holders,
    home: o.home,
    pauseMs: o.pauseMs,
    machine: o.machine,
    modules: [
      module("host-manage", { fields: { mode: () => b.mode, parent: () => b.parent } }, { provides: { "session.open": 1, "session.update": 1, "session.remove": 1 } }),
      module("host-push", { requests: { notify: (req) => (b.notifies.push(req), { pushed: [] }) } }),
      module("host-spy", { on: { event: (_s, m) => void b.seen.push(m.type) } }),
      ...b.modules,
    ],
  });
  stands.push(st);
  b.st = st;
  return b;
}

async function keeper() {
  const k = new FakeHolders();
  keepers.push(k);
  return k;
}

const request = (st: Stand, type: string, o: Record<string, unknown>) => st.relay.request({ type, v: 1, callsign: CS, ...o });
const watch = (st: Stand, from: string, callsign = CS) => request(st, "session.watch", { callsign, from });
const unwatch = (st: Stand, from: string) => request(st, "session.unwatch", { from });
const answer = (st: Stand, from: string, o: Record<string, unknown>) => request(st, "answer", { from, ...o });
const events = (st: Stand) => st.relay.frames("session.events");
const asked = (st: Stand) => st.relay.frames("question");
const closed = (st: Stand) => st.relay.frames("answered");
const conversation = (read: (...a: unknown[]) => Promise<unknown>) => ({ getSessionInfo: async () => ({}), importSessionToStore: async () => {}, getSessionMessages: read });

/** Сессия с задачей от адресата вопросов. */
async function tasked(st: Stand, from = PHONE, callsign = CS) {
  const s = await st.open(callsign);
  s.input("задача", { from });
  return { s, p: st.proc(callsign) };
}

/** Папка сессии с файлами; git — репозиторий с .gitignore. */
function folder(git: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "switchboard-chat-"));
  for (const f of ["src/worker.ts", "test/worker.test.ts", "build/worker.js", "README.md"]) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), "//");
  }
  if (git) {
    writeFileSync(join(d, ".gitignore"), "build/\n");
    execFileSync("git", ["init", "-q"], { cwd: d });
  }
  return d;
}

/** Настоящие функции чтения SDK на файле разговора: 6 сообщений, граница, сводка, 4 сообщения. */
function compacted(s: Stand, cwd: string) {
  const cfg = mkdtempSync(join(tmpdir(), "switchboard-chat-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const sid = "44444444-4444-4444-8444-444444444444";
  const base = { sessionId: sid, isSidechain: false, timestamp: "2026-11-03T00:00:00.000Z", cwd, version: "2.1.0" };
  const rec = (uuid: string, parentUuid: string | null, type = "user") => ({
    ...base,
    type,
    uuid,
    parentUuid,
    message: type === "user" ? { role: "user", content: uuid } : { id: `m-${uuid}`, role: "assistant", model: "m", content: [{ type: "text", text: uuid }] },
  });
  const records = [
    rec("a0", null), rec("a1", "a0", "assistant"), rec("a2", "a1"), rec("a3", "a2", "assistant"), rec("a4", "a3"), rec("a5", "a4", "assistant"),
    { ...base, type: "system", subtype: "compact_boundary", uuid: "x", parentUuid: null, logicalParentUuid: "a5", compactMetadata: { trigger: "manual", preTokens: 1000 } },
    { ...rec("s", "x"), isCompactSummary: true },
    rec("c0", "s"), rec("c1", "c0", "assistant"), rec("c2", "c1"), rec("c3", "c2", "assistant"),
  ];
  const project = join(cfg, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sid}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // id сессии стенда — не uuid: функции SDK читают файл этого разговора
  s.sdk.functions = {
    getSessionInfo: (_id: string, o: never) => getSessionInfo(sid, o),
    importSessionToStore: (_id: string, store: never, o: never) => importSessionToStore(sid, store, o),
    getSessionMessages: (_id: string, o: never) => getSessionMessages(sid, o),
  } as never;
}

describe("ввод сессии", () => {
  it.each([
    ["простаивает", false],
    ["занята", true],
  ])("15, 3002 · session.prompt, сессия %s: ответ сразу, ввод человека без обёртки, отправитель запомнен", async (_n, busy) => {
    const { st } = await bench();
    const s = await st.open(CS);
    const p = st.proc(CS);
    if (busy) {
      p.send(msg.state("running"));
      await until(() => s.state === "busy");
    }
    expect(await request(st, "session.prompt", { uuid: "9c4d", text: "Почини сборку" })).toMatchObject({ ok: true, result: { uuid: "9c4d" } });
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0]).toMatchObject({ type: "user", priority: "next", uuid: "9c4d", origin: { kind: "human" }, message: { role: "user", content: "Почини сборку" } });
    expect(s.info.from).toBe(PANEL);
  });

  const b64 = (t: string) => Buffer.from(t).toString("base64");
  it.each([
    ["без вложений — строка", "x", [], "x"],
    [
      "82 · картинка и pdf — по порядку одним сообщением",
      "Что на скрине?",
      [{ name: "screen.png", media_type: "image/png", data: "iVBOR" }, { name: "spec.pdf", media_type: "application/pdf", data: "JVBER" }],
      [
        { type: "text", text: "Что на скрине?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
      ],
    ],
    ["текстовый файл без текста — документ с текстом", "", [{ name: "n.txt", media_type: "text/plain", data: b64("заметка") }], [{ type: "document", source: { type: "text", media_type: "text/plain", data: "заметка" } }]],
  ])("вложения во вводе: %s", async (_n, text, attachments, want) => {
    const { st } = await bench();
    await st.open(CS);
    expect(await request(st, "session.prompt", { text, attachments })).toMatchObject({ ok: true });
    const p = st.proc(CS);
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toEqual(want);
  });

  it("3003 · сессия failed — session.prompt словом stopped; session.start поднимает, ввод проходит", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    st.holders.failInitNext = 1;
    st.proc(CS).exit(1, "первый");
    await until(() => st.sdk.of(CS).length === 2 && st.holders.procs.get(CS)?.initializes === 1);
    st.proc(CS).exit(1, "второй");
    await until(() => s.state === "failed");
    expect(await request(st, "session.prompt", { text: "x" })).toMatchObject({ ok: false, error: "stopped" });
    await s.start();
    expect(await request(st, "session.prompt", { text: "x" })).toMatchObject({ ok: true });
    await until(() => st.proc(CS).inputs.length === 1);
  });

  it("остановленная сессия: session.prompt — stopped, message — offline; ввод не тронут", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    const p = st.proc(CS);
    await s.stop();
    expect(await request(st, "session.prompt", { text: "привет" })).toMatchObject({ ok: false, error: "stopped" });
    expect(await request(st, "message", { from: "deploy", to: CS, text: "x" })).toMatchObject({ ok: false, error: "offline" });
    expect(p.inputs).toHaveLength(0);
  });

  it.each([
    ["session.prompt: text не строка (3001)", "session.prompt", { text: 5 }, "bad_frame", null],
    ["session.prompt: тип вложения не годится (82)", "session.prompt", { text: "и это", attachments: [{ name: "build.zip", media_type: "application/zip", data: "UEsDB" }] }, "bad_attachment", "application/zip"],
    ["session.history: без limit (5540)", "session.history", { before: null }, "bad_frame", null],
    ["session.history: нет такой записи (5540)", "session.history", { before: "нет-такой", limit: 4 }, "bad_frame", null],
    ["session.history: сессии нет на машине (5540)", "session.history", { callsign: "ghost@laptop", before: null, limit: 4 }, "offline", null],
    ["session.files: без limit (3006)", "session.files", { query: "a" }, "bad_frame", null],
    ["session.watch: без from (3008)", "session.watch", { from: undefined }, "bad_frame", null],
    ["session.unwatch: без from (3008)", "session.unwatch", { from: undefined }, "bad_frame", null],
    ["session.watch: сессии нет", "session.watch", { callsign: "wiki@laptop", from: PHONE }, "offline", null],
    ["message: без text (336)", "message", { from: "wiki@pc", to: CS }, "bad_frame", null],
    ["message: адресата нет", "message", { from: "deploy", to: "wiki@laptop", text: "x" }, "offline", null],
  ])("вход отклонён словом, причина в журнале, ввод не тронут, разговор работает: %s", async (_n, type, body, word, why) => {
    // источник: устав «ошибки — словами»; слова — чьё: код
    const { st } = await bench();
    await st.open(CS);
    st.sdk.functions = conversation(async () => []);
    expect(await request(st, type, body)).toMatchObject({ ok: false, error: word });
    const line = st.journal().find((l) => l.word === word);
    expect(line).toMatchObject({ kind: "refuse" });
    if (why) expect(line!.why).toContain(why);
    await later();
    const p = st.proc(CS);
    expect(p.inputs).toHaveLength(0);
    expect(await request(st, "session.prompt", { text: "дальше" })).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
  });

  it.each([
    ["3005 · session.history: SDK не прочёл разговор", "session.history"],
    ["3007 · session.files: обход папки не в git упал", "session.files"],
  ])("ошибка модуля словом module_error, журнал и roster failed, другая сессия Host работает: %s", async (_n, type) => {
    // источник: слово пользователя, устав: «ошибка модуля — модуль выключен, в roster failed»
    const { st } = await bench();
    const gone = folder(false);
    await st.open(CS, { cwd: gone });
    await st.open("wiki@laptop", { cwd: folder(true) });
    st.sdk.functions = conversation(async () => { throw new Error("файл разговора не читается"); });
    rmSync(gone, { recursive: true, force: true });
    const r = await request(st, type, type === "session.history" ? { before: null, limit: 5 } : { query: "", limit: 5 });
    expect(r).toMatchObject({ ok: false, error: "module_error" });
    expect(st.journal().find((l) => l.ev === "module_failed")).toMatchObject({ kind: "stop", callsign: CS });
    st.proc(CS).send(msg.state("idle"));
    await until(() => Object.keys(st.states(CS).at(-1)?.failed ?? {}).length > 0);
    expect(await request(st, "session.files", { callsign: "wiki@laptop", query: "worker", limit: 5 })).toMatchObject({ ok: true });
  });

  it("вклад в query(): предложение следующего ввода и частичные сообщения", async () => {
    const { st } = await bench();
    await st.open(CS);
    expect(st.query(CS).options).toMatchObject({ promptSuggestions: true, includePartialMessages: true });
  });
});

describe("история разговора", () => {
  it("15 · session.history: записи разговора как есть из файла сессии, чтение с папкой и системными записями; ввод не тронут", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    const rec = [{ type: "user", uuid: "9c4d", message: { role: "user", content: "Почини сборку" } }, { type: "assistant", uuid: "a1", message: {} }];
    const calls: unknown[][] = [];
    st.sdk.functions = conversation(async (...a) => (calls.push(a), rec));
    expect(await request(st, "session.history", { before: null, limit: 50 })).toMatchObject({ ok: true, result: { messages: rec, more: false } });
    expect(calls).toMatchObject([[s.info.session_id, { dir: s.info.cwd, includeSystemMessages: true }]]);
    expect(st.proc(CS).inputs).toHaveLength(0);
  });

  const rec14 = Array.from({ length: 14 }, (_, i) => ({ type: "user", uuid: `u${i + 1}` }));
  it.each([
    ["новая сессия — пустая страница (3004)", [], null, [], false],
    ["последняя страница и есть ещё", rec14, null, ["u9", "u10", "u11", "u12", "u13", "u14"], true],
    ["раньше записи, больше нет", rec14, "u3", ["u1", "u2"], false],
  ])("страницы: %s", async (_n, all, before, want, more) => {
    const { st } = await bench();
    await st.open(CS);
    st.sdk.functions = conversation(async () => all);
    const r = (await request(st, "session.history", { before, limit: 6 })).result as { messages: Array<{ uuid: string }>; more: boolean };
    expect(r.messages.map((m) => m.uuid)).toEqual(want);
    expect(r.more).toBe(more);
  });

  it("5538, 5539, 3004 · через границу сжатия: стык в стык, граница годится как before; у остановленной читается целиком без нового процесса", async () => {
    // источник: факт — опыт 3 нояб. на SDK 0.3.311 с includeSystemMessages: «c0 c1 c2 c3 | a4 a5 x s | a0 a1 a2 a3»
    const { st } = await bench();
    const s = await st.open(CS);
    compacted(st, s.info.cwd);
    const page = async (before: string | null) => (await request(st, "session.history", { before, limit: 4 })).result as { messages: Array<{ uuid: string }>; more: boolean };
    const p1 = await page(null);
    const p2 = await page(p1.messages[0].uuid);
    const p3 = await page(p2.messages[0].uuid);
    expect([p1, p2, p3].map((p) => p.messages.map((m) => m.uuid).join(" "))).toEqual(["c0 c1 c2 c3", "a4 a5 x s", "a0 a1 a2 a3"]);
    expect([p1.more, p2.more, p3.more]).toEqual([true, true, false]);
    expect((await page("x")).messages.map((m) => m.uuid)).toEqual(["a2", "a3", "a4", "a5"]);
    const p = st.proc(CS);
    await s.stop();
    const started = st.sdk.of(CS).length;
    const all = await request(st, "session.history", { before: null, limit: 50 });
    expect((all.result as { messages: Array<{ uuid: string }> }).messages.map((m) => m.uuid)).toContain("a0");
    expect(st.sdk.of(CS)).toHaveLength(started);
    expect(p.inputs).toHaveLength(0);
  });

  it("5547 · остановка Host во время чтения: новый запрос — shutting_down, начатый получает ответ раньше закрытия relay, выход 0", async () => {
    // источник: устав «не принимает новое → доводит текущее → закрывает соединения с причиной → выходит»; слово — чьё: код
    const { st } = await bench();
    await st.open(CS);
    let release = (_m: unknown) => {};
    let reading = false;
    st.sdk.functions = conversation(() => {
      reading = true;
      return new Promise((r) => (release = r));
    });
    const first = request(st, "session.history", { before: null, limit: 4 });
    await until(() => reading);
    const down = st.kernel.shutdown("ввод закрыт");
    expect(await request(st, "session.history", { before: null, limit: 4 })).toMatchObject({ ok: false, error: "shutting_down" });
    let closesAtReply = -1;
    const answered = first.then((r) => ((closesAtReply = st.relay.clientCloses.length), r));
    release([{ type: "user", uuid: "u1" }]);
    expect(await answered).toMatchObject({ ok: true, result: { messages: [{ uuid: "u1" }], more: false } });
    await down;
    expect(closesAtReply).toBe(0);
    expect(st.relay.clientCloses.at(-1)).toEqual({ code: 1000, reason: "shutting_down" });
    expect(st.exits).toEqual([0]);
  });
});

describe("файлы для «@»", () => {
  it.each([
    ["83 · в git: без скрытого .gitignore", true, "worker", 20, ["src/worker.ts", "test/worker.test.ts"]],
    ["папка не в git: все файлы, без учёта регистра", false, "WORKER", 20, ["build/worker.js", "src/worker.ts", "test/worker.test.ts"]],
    ["limit клиента", false, "worker", 2, null],
  ])("session.files: %s", async (_n, git, query, limit, want) => {
    const { st } = await bench();
    await st.open(CS, { cwd: folder(git) });
    const r = (await request(st, "session.files", { query, limit })).result as string[];
    if (want) expect(r.sort()).toEqual(want);
    else expect(r).toHaveLength(limit);
  });

  it("83 · ссылка @файл идёт во ввод как текст, без client_composed", async () => {
    const { st } = await bench();
    await st.open(CS);
    await request(st, "session.prompt", { text: "Сравни с @src/worker.ts" });
    const p = st.proc(CS);
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toBe("Сравни с @src/worker.ts");
    expect(JSON.stringify(p.inputs[0])).not.toContain("client_composed");
  });
});

describe("живая лента", () => {
  it("14 · смотрит ход: пачки раз в 100 мс по порядку; до watch и после unwatch — ни кадра", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    await st.open(CS);
    const p = st.proc(CS);
    turn(p, "до");
    await until(() => seen.length === 4);
    vi.advanceTimersByTime(WINDOW_MS * 5);
    expect(events(st)).toHaveLength(0);

    expect(await watch(st, PANEL)).toMatchObject({ ok: true });
    turn(p, "раз");
    await until(() => seen.length === 8);
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(events(st)).toHaveLength(0); // окно ещё открыто
    vi.advanceTimersByTime(1);
    expect(events(st)).toHaveLength(1);
    p.send(msg.state("running"));
    await until(() => seen.length === 9);
    p.send(msg.assistant("два"));
    await until(() => seen.length === 10);
    vi.advanceTimersByTime(WINDOW_MS);
    p.send(msg.result());
    await until(() => seen.length === 11);
    vi.advanceTimersByTime(WINDOW_MS);
    const fr = events(st);
    expect(fr.map((f) => f.seq)).toEqual([1, 2, 3]);
    for (const f of fr) expect(f).toMatchObject({ type: "session.events", v: 1, from: CS, to: [PANEL] });
    expect(fr.map((f) => (f.events as Array<{ type: string }>).map((e) => e.type))).toEqual([
      ["system", "assistant", "result", "system"],
      ["system", "assistant"],
      ["result"],
    ]);

    expect(await unwatch(st, PANEL)).toMatchObject({ ok: true });
    turn(p, "после");
    await until(() => seen.length === 15);
    vi.advanceTimersByTime(WINDOW_MS * 5);
    expect(events(st)).toHaveLength(3);
  });

  it.each([
    ["session.unwatch снял одного (3009)", (st: Stand) => unwatch(st, PHONE), [PANEL]],
    ["roster без него: ушёл с relay (80)", (st: Stand) => st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [PANEL] }), [PANEL]],
  ])("зрители: из двух остался один — лента только ему; повтор watch не дублирует: %s", async (_n, leave, want) => {
    const { st, seen } = await bench();
    await st.open(CS);
    await watch(st, PANEL);
    await watch(st, PHONE);
    await watch(st, PHONE);
    await leave(st);
    await later();
    turn(st.proc(CS));
    await until(() => seen.length === 4);
    const fr = await until(() => events(st)[0]);
    expect(fr.to).toEqual(want);
  });

  it("80 · ушли все зрители посреди пачки — кадра нет; сессия идёт дальше", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    const s = await st.open(CS);
    await watch(st, PHONE);
    st.proc(CS).send(msg.state("running"));
    await until(() => seen.length === 1);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(events(st)).toHaveLength(1);
    st.proc(CS).send(msg.state("running"));
    await until(() => seen.length === 2);
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    // окно поддельное: несколько настоящих проходов, чтобы roster дошёл до модулей
    let spins = 0;
    await until(() => ++spins > 5);
    vi.advanceTimersByTime(WINDOW_MS * 3);
    expect(events(st)).toHaveLength(1);
    expect(s.state).toBe("busy");
  });

  it("81 · Host убит посреди хода, новый подхватил: зрителей в памяти нет, кадров нет; после нового watch кадры идут, seq снова с 1", async () => {
    const k = await keeper();
    const a = await bench({ holders: k });
    await a.st.open(CS);
    await watch(a.st, PANEL);
    const p = a.st.proc(CS);
    p.send(msg.state("running"));
    p.send(msg.assistant("шаг 1"));
    await until(() => events(a.st).length === 1);
    a.st.crash();
    await until(() => p.sock === null);
    p.send(msg.assistant("шаг 2"));
    p.send(msg.result());
    p.send(msg.state("idle"));
    const b = await bench({ holders: k, home: a.st.home });
    await until(() => b.seen.includes("result"));
    await new Promise((r) => setTimeout(r, WINDOW_MS * 2));
    expect(events(b.st)).toHaveLength(0);
    await watch(b.st, PANEL);
    p.send(msg.assistant("шаг 3"));
    const fr = await until(() => events(b.st)[0]);
    expect(fr).toMatchObject({ to: [PANEL], seq: 1, from: CS });
  });

  it("штатная остановка досылает открытую пачку", async () => {
    // источник: устав — graceful shutdown: сохраняет и отдаёт текущее
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    await st.open(CS);
    await watch(st, PANEL);
    st.proc(CS).send(msg.state("running"));
    await until(() => seen.length === 1);
    await st.close();
    stands.splice(stands.indexOf(st), 1);
    expect(events(st)).toHaveLength(1);
    expect((events(st)[0] as Frame).events).toHaveLength(1);
  });

  it("3010 · нет связи — пачка пропадает; после связи seq с разрывом: клиент добирает историей", async () => {
    const { st, seen } = await bench({ pauseMs: WINDOW_MS * 4 });
    await st.open(CS);
    await watch(st, PANEL);
    const p = st.proc(CS);
    p.send(msg.state("running"));
    await until(() => events(st).length === 1);
    st.relay.drop();
    await until(() => st.kernel.relay?.state !== "open");
    p.send(msg.assistant("без связи"));
    await until(() => seen.length === 2);
    await new Promise((r) => setTimeout(r, WINDOW_MS * 2));
    await until(() => st.kernel.relay?.state === "open");
    p.send(msg.result());
    const fr = await until(() => events(st)[1]);
    expect(events(st)).toHaveLength(2);
    expect(fr.seq).toBe(3);
    expect((fr.events as Array<{ type: string }>).map((e) => e.type)).toEqual(["result"]);
  });

  it("3011 · две сессии — свои пачки и свои seq", async () => {
    const { st, seen } = await bench();
    await st.open(CS);
    await st.open("wiki@laptop");
    await watch(st, PANEL, CS);
    await watch(st, PHONE, "wiki@laptop");
    turn(st.proc(CS));
    turn(st.proc("wiki@laptop"));
    await until(() => seen.length === 8);
    await until(() => events(st).length === 2);
    const byFrom = Object.fromEntries(events(st).map((f) => [f.from, f]));
    expect(byFrom[CS]).toMatchObject({ seq: 1, to: [PANEL] });
    expect(byFrom["wiki@laptop"]).toMatchObject({ seq: 1, to: [PHONE] });
    expect((byFrom[CS].events as unknown[]).length).toBe(4);
  });
});

describe("вопрос человеку", () => {
  it("11, 7100 · без вопросов: инструмент разрешён сам; AskUserQuestion — кадр давшему задачу, ход ждёт без предела, ответ уходит в SDK", async () => {
    // источник: устав — «разрешено всё; вопросы человеку — наружу»; решение 4 нояб.: таймера на ожидание человека нет
    const { st } = await bench();
    const { p } = await tasked(st);
    expect(await p.ask("Bash", { command: "npm test" })).toMatchObject({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(st.journal().find((l) => l.ev === "allow")).toMatchObject({ callsign: CS, tool: "Bash", why: "режим bypassPermissions" });
    expect(asked(st)).toHaveLength(0);
    let done = false;
    const a = p.ask("AskUserQuestion", ASK, "toolu_01Hq").then((r) => ((done = true), r));
    const q = await until(() => asked(st)[0]);
    expect(q).toMatchObject({ type: "question", from: CS, to: [PHONE], question: "toolu_01Hq", kind: "ask", questions: ASK.questions });
    st.clock.advance(24 * 3600_000);
    await later();
    expect(done).toBe(false);
    expect(await answer(st, PHONE, { question: "toolu_01Hq", answers: pick("стенд") })).toMatchObject({ ok: true });
    expect(await a).toEqual({ behavior: "allow", updatedInput: { ...ASK, answers: pick("стенд") } });
  });

  it.each([
    ["AskUserQuestion", (p: stand.FakeProc) => p.ask("AskUserQuestion", { questions: [{ question: "Цвет?", options: [{ label: "Синий" }] }] }, "id1"), { answers: { "Цвет?": "Синий" } }, { behavior: "allow" }, "bypassPermissions"],
    ["форма MCP (73)", (p: stand.FakeProc) => p.elicit({ serverName: "jira", message: "Данные", mode: "form", requestedSchema: { type: "object", properties: {} } }), { content: { project: "WEB" } }, { action: "accept", content: { project: "WEB" } }, "bypassPermissions"],
    ["запрос разрешения (7105)", (p: stand.FakeProc) => p.ask("Bash", { command: "ls" }, "id1"), { action: "allow" }, { behavior: "allow" }, "default"],
  ])("12 · первый ответ выигрывает, остальным already_answered, адресатам один answered: %s", async (_n, ask, first, want, mode) => {
    const { st } = await bench({ mode });
    const { p } = await tasked(st);
    await watch(st, PANEL);
    const a = ask(p);
    const q = await until(() => asked(st)[0]);
    expect(q.to).toEqual([PHONE, PANEL]);
    expect(await answer(st, PANEL, { question: q.question, ...first })).toMatchObject({ ok: true });
    expect(await answer(st, PHONE, { question: q.question, ...first })).toMatchObject({ ok: false, error: "already_answered" });
    expect(await a).toMatchObject(want);
    expect(closed(st)).toHaveLength(1);
    expect(closed(st)[0]).toMatchObject({ question: q.question, by: PANEL, to: [PHONE, PANEL] });
  });

  it.each([
    ["13 · Host убит", (st: Stand) => (st.crash(), Promise.resolve())],
    ["72 · штатная остановка с причиной upgrade: ни allow, ни deny", (st: Stand) => st.close()],
  ])("ждущий вопрос переживает Host: тот же id новому Host, ответ дошёл до модели: %s", async (_n, end) => {
    const k = await keeper();
    const a = await bench({ holders: k });
    const { p } = await tasked(a.st);
    let settled = false;
    const q = p.ask("AskUserQuestion", ASK, "toolu_x").then((r) => ((settled = true), r));
    await until(() => asked(a.st)[0]);
    await end(a.st);
    stands.splice(stands.indexOf(a.st), 1);
    await until(() => p.sock === null);
    expect(settled).toBe(false);
    expect(p.alive).toBe(true);
    const b = await bench({ holders: k, home: a.st.home });
    expect(await until(() => asked(b.st)[0])).toMatchObject({ question: "toolu_x", to: [PHONE] });
    await answer(b.st, PHONE, { question: "toolu_x", answers: pick("прод") });
    expect(await q).toMatchObject({ behavior: "allow", updatedInput: { answers: pick("прод") } });
  });

  it("74 · Host упал с ждущей формой: новый её не знает — unknown_question в журнале; вопросы дальше работают", async () => {
    const k = await keeper();
    const a = await bench({ holders: k });
    const { p } = await tasked(a.st, PANEL);
    void p.elicit({ serverName: "jira", message: "Данные", mode: "form", requestedSchema: { type: "object", properties: {} } });
    const id = (await until(() => asked(a.st)[0])).question as string;
    a.st.crash();
    stands.splice(stands.indexOf(a.st), 1);
    await until(() => p.sock === null);
    const b = await bench({ holders: k, home: a.st.home });
    await until(() => b.st.kernel.sessions.get(CS)?.state === "idle");
    expect(await answer(b.st, PANEL, { question: id, content: { project: "WEB" } })).toMatchObject({ ok: false, error: "unknown_question" });
    expect(b.st.journal().some((l) => l.word === "unknown_question" && l.kind === "refuse")).toBe(true);
    await watch(b.st, PANEL);
    const next = p.ask("AskUserQuestion", ASK, "toolu_next");
    await until(() => asked(b.st).find((f) => f.question === "toolu_next"));
    await answer(b.st, PANEL, { question: "toolu_next", answers: pick("прод") });
    expect(await next).toMatchObject({ behavior: "allow" });
  });

  it.each([
    ["форма, принята (73)", { serverName: "jira", message: "Данные", mode: "form", requestedSchema: { type: "object", properties: { project: { type: "string" } } } }, { kind: "form", server: "jira", message: "Данные", schema: { type: "object", properties: { project: { type: "string" } } } }, { content: { project: "WEB" } }, { action: "accept", content: { project: "WEB" } }],
    ["ссылка, отклонена (3022)", { serverName: "github", message: "Войти", mode: "url", url: "https://github.com/login" }, { kind: "url", server: "github", url: "https://github.com/login" }, { action: "decline" }, { action: "decline" }],
  ])("форма MCP: %s", async (_n, request, frame, reply, want) => {
    const { st } = await bench();
    const { p } = await tasked(st);
    const r = p.elicit(request);
    const q = await until(() => asked(st)[0]);
    expect(q).toMatchObject({ ...frame, to: [PHONE] });
    expect(await answer(st, PHONE, { question: q.question, ...reply })).toMatchObject({ ok: true });
    expect(await r).toEqual(want);
  });

  it("159 · вопрос двум адресатам: кадр без notify, один notify с кнопками и tag; после ответа — answered и второй notify с тем же tag", async () => {
    const { st, notifies } = await bench();
    const { p } = await tasked(st, PHONE, "profiles@laptop");
    await request(st, "session.watch", { callsign: "profiles@laptop", from: PANEL });
    const a = p.ask("AskUserQuestion", ASK, "toolu_01Hq");
    const q = await until(() => asked(st)[0]);
    expect(q.to).toEqual([PHONE, PANEL]);
    expect(q).not.toHaveProperty("notify");
    await until(() => notifies.length === 1);
    expect(notifies[0]).toMatchObject({
      clients: [PHONE, PANEL],
      frame: {
        type: "question",
        from: "profiles@laptop",
        notify: {
          title: "profiles@laptop спрашивает",
          body: "Какую базу мигрировать первой?",
          actions: [
            { title: "прод", frame: { type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hq", answers: pick("прод") } },
            { title: "стенд", frame: { type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hq", answers: pick("стенд") } },
          ],
          tag: "toolu_01Hq",
        },
      },
    });
    await st.relay.request({ type: "answer", v: 1, callsign: "profiles@laptop", from: PANEL, question: "toolu_01Hq", answers: pick("стенд") });
    await a;
    await until(() => notifies.length === 2);
    expect(notifies[1]).toMatchObject({ clients: [PHONE, PANEL], frame: { type: "answered", notify: { title: "profiles@laptop · ответ принят", body: `${PANEL}: стенд`, tag: "toolu_01Hq" } } });
  });

  it.each([
    ["несколько вопросов", { questions: [ASK.questions[0], { question: "Ещё?", options: [{ label: "да" }] }] }],
    ["multiSelect", { questions: [{ ...ASK.questions[0], multiSelect: true }] }],
  ])("3021 · пуш без кнопок: %s", async (_n, input) => {
    const { st, notifies } = await bench();
    const { p } = await tasked(st);
    void p.ask("AskUserQuestion", input, "toolu_two");
    await until(() => notifies.length === 1);
    expect((notifies[0].frame as { notify: Record<string, unknown> }).notify).not.toHaveProperty("actions");
  });

  it.each([
    ["AskUserQuestion", (p: stand.FakeProc) => p.ask("AskUserQuestion", ASK, "toolu_c"), { answers: pick("прод") }, "bypassPermissions"],
    ["запрос разрешения (7106)", (p: stand.FakeProc) => p.ask("Bash", { command: "ls" }, "toolu_c"), { action: "allow" }, "default"],
  ])("ход прервали: вопрос снят, SDK получает deny cancelled, адресаты — answered cancelled; поздний ответ — already_answered; ответа за человека нет: %s", async (_n, ask, late, mode) => {
    const { st } = await bench({ mode });
    const { p } = await tasked(st);
    const r = ask(p);
    await until(() => asked(st)[0]);
    p.abortAsk("toolu_c");
    expect(await r).toEqual({ behavior: "deny", message: "cancelled" });
    expect(closed(st)[0]).toMatchObject({ question: "toolu_c", cancelled: true, to: [PHONE] });
    expect(closed(st)[0]).not.toHaveProperty("by");
    expect(await answer(st, PHONE, { question: "toolu_c", ...late })).toMatchObject({ ok: false, error: "already_answered" });
  });

  it("3023 · форма: сигнал отмены — cancel и answered cancelled", async () => {
    const b = await bench();
    await tasked(b.st);
    const entry = b.modules.find((m) => m.module.elicit)!;
    const ac = new AbortController();
    const r = entry.module.elicit!(b.st.session(entry.manifest.name, CS)!, { serverName: "jira", message: "Данные", mode: "form", requestedSchema: {} } as never, { signal: ac.signal, requestId: "el_c" });
    await until(() => asked(b.st)[0]);
    ac.abort();
    expect(await r).toEqual({ action: "cancel" });
    expect(closed(b.st)[0]).toMatchObject({ question: "el_c", cancelled: true });
  });

  it("question.list: ждущие сессии; после ответа пусто; 3020: адресатов нет — кадра нет, вопрос ждёт в списке", async () => {
    const { st } = await bench();
    const { p } = await tasked(st, "@laptop");
    const a = p.ask("AskUserQuestion", ASK, "toolu_l");
    await until(() => st.journal().find((l) => l.ev === "question" && l.question === "toolu_l"));
    expect(asked(st)).toHaveLength(0);
    expect(await request(st, "question.list", {})).toMatchObject({ ok: true, result: [{ question: "toolu_l", kind: "ask", questions: ASK.questions }] });
    await answer(st, PHONE, { question: "toolu_l", answers: pick("прод") });
    await a;
    expect(await request(st, "question.list", {})).toMatchObject({ ok: true, result: [] });
  });

  it("337 · вопрос дочери — в ввод родителя тегом fleet-question; следующий вопрос родителя — тому, кто дал ему задачу, а не дочери", async () => {
    // источник: устав — AskUserQuestion получает тот, кто дал задачу; слово пользователя «контроль вложенных как в десктопе»
    const { st } = await bench({ machine: "win" });
    const lead = await st.open("lead@win");
    lead.input("Наведи порядок в документации", { from: PHONE });
    st.relay.deliver({ type: "question", from: "docs@win", to: ["lead@win"], question: "toolu_k1", kind: "ask", questions: ASK.questions });
    const p = st.proc("lead@win");
    await until(() => p.inputs.length === 2);
    const text = p.inputs[1].message.content as string;
    expect(p.inputs[1]).toMatchObject({ priority: "next", origin: { kind: "peer", from: "docs@win" } });
    expect(text).toContain('<fleet-question from="docs@win" question="toolu_k1">');
    expect(text).toContain("· прод — боевая, 2 ТБ");
    expect(text).toContain("fleet.answer");
    void p.ask("AskUserQuestion", { questions: [{ question: "Можно пушить в main?" }] }, "toolu_l1");
    expect(await until(() => asked(st)[0])).toMatchObject({ from: "lead@win", question: "toolu_l1", to: [PHONE] });
  });

  it("3018, 7205, 338, 7204 · задачу дала сессия: AskUserQuestion — ей и зрителю, без пуша ей; разрешение и форма — только клиентам, в её ввод не идут; ответ сессии на разрешение — not_client", async () => {
    // источник: устав «вопросы человеку — наружу»; цель 4 нояб.: разрешение решает человек
    const { st, notifies } = await bench({ mode: "default", machine: "laptop" });
    await st.open("lead@laptop");
    const { p } = await tasked(st, "lead@laptop");
    void p.ask("AskUserQuestion", ASK, "toolu_a");
    expect((await until(() => asked(st)[0])).to).toEqual(["lead@laptop"]);
    await later();
    expect(notifies).toHaveLength(0);
    await watch(st, PANEL);
    const perm = p.ask("Bash", { command: "rm x" }, "toolu_b");
    await until(() => asked(st).length === 2);
    expect(asked(st)[1].to).toEqual([PANEL]);
    void p.elicit({ serverName: "github", message: "Войти", mode: "form", requestedSchema: {} });
    await until(() => asked(st).length === 3);
    expect(asked(st)[2]).toMatchObject({ kind: "form", to: [PANEL] });
    expect(await answer(st, "lead@laptop", { question: "toolu_b", action: "allow" })).toMatchObject({ ok: false, error: "not_client" });
    expect(await answer(st, PANEL, { question: "toolu_b", action: "deny" })).toMatchObject({ ok: true });
    expect(await perm).toMatchObject({ behavior: "deny" });
  });

  it.each([
    ["answer без answers", () => ({ from: PHONE, question: "toolu_b" }), "bad_frame", "bypassPermissions"],
    ["чужой callsign", () => ({ from: PHONE, callsign: "wiki@laptop", question: "toolu_b", answers: pick("прод") }), "unknown_question", "bypassPermissions"],
    ["неизвестное действие на разрешение (7105)", () => ({ from: PHONE, question: "toolu_b", action: "accept" }), "bad_frame", "default"],
  ])("ответ отклонён словом, вопрос ждёт дальше: %s", async (_n, frame, word, mode) => {
    const { st } = await bench({ mode });
    await st.open("wiki@laptop");
    const { p } = await tasked(st);
    const a = mode === "default" ? p.ask("Bash", { command: "ls" }, "toolu_b") : p.ask("AskUserQuestion", ASK, "toolu_b");
    await until(() => asked(st)[0]);
    expect(await request(st, "answer", frame())).toMatchObject({ ok: false, error: word });
    await answer(st, PHONE, mode === "default" ? { question: "toolu_b", action: "allow" } : { question: "toolu_b", answers: pick("прод") });
    expect(await a).toMatchObject({ behavior: "allow" });
  });
});

describe("запрос разрешения и план", () => {
  it.each([
    ["запрос разрешения: режим default (7101)", "default", "Bash", { kind: "perm", tool: "Bash" }],
    ["режима не видно: сам не разрешён (7206)", undefined, "Bash", { kind: "perm", tool: "Bash" }],
    ["AskUserQuestion и в default — вид ask (7107)", "default", "AskUserQuestion", { kind: "ask" }],
    ["план: ExitPlanMode в режиме plan (7110)", "plan", "ExitPlanMode", { kind: "perm", tool: "ExitPlanMode" }],
  ])("вопрос человеку, а не разрешение само: %s", async (_n, mode, tool, frame) => {
    const { st, notifies } = await bench({ mode });
    const { p } = await tasked(st);
    let done = false;
    const input = tool === "AskUserQuestion" ? ASK : tool === "ExitPlanMode" ? { plan: "## План\n\n1. Шаг" } : { command: "npm test", description: "Прогон" };
    void p.ask(tool, input, "toolu_p").then(() => (done = true));
    const q = await until(() => asked(st)[0]);
    expect(q).toMatchObject({ type: "question", from: CS, question: "toolu_p", to: [PHONE], ...frame });
    if (tool !== "AskUserQuestion") expect(q.input).toEqual(input);
    await later();
    expect(done).toBe(false);
    if (tool === "Bash") {
      await until(() => notifies.length > 0);
      expect(notifies.at(-1)).toMatchObject({ frame: { notify: { title: `${CS} просит разрешения` } } });
      expect((await request(st, "question.list", {})).result).toEqual([expect.objectContaining({ question: "toolu_p", kind: "perm", tool: "Bash" })]);
    }
  });

  it("7103 · кадр несёт заголовок, причину, путь и предложения SDK", async () => {
    // источник: настоящий процесс claude 0.3.311: canUseTool приходит с suggestions, blockedPath, title
    const { st } = await bench({ mode: "default" });
    const { p } = await tasked(st);
    const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
    void p.askWith("Bash", { command: "npm test" }, { suggestions: SUGGEST, blockedPath: "C:/x", title: "Claude хочет выполнить npm test", decisionReason: "нет правила" }, "toolu_f");
    expect(await until(() => asked(st)[0])).toMatchObject({ suggestions: SUGGEST, blockedPath: "C:/x", title: "Claude хочет выполнить npm test", reason: "нет правила" });
  });

  const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
  const PLAN = { plan: "## План\n\n1. Шаг" };
  it.each([
    ["«Разрешить» — без постоянных правил (7102)", "default", "Bash", { command: "ls" }, {}, { action: "allow" }, { behavior: "allow", updatedInput: { command: "ls" } }],
    ["«Разрешать всегда» — только предложенное SDK, свои правила клиента не проходят (7103)", "default", "Bash", { command: "npm test" }, { suggestions: SUGGEST }, { action: "allow", always: true, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }] }, { behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: SUGGEST }],
    ["«Отклонить» с причиной (7104)", "default", "Bash", { command: "rm x" }, {}, { action: "deny", message: "не трогай" }, { behavior: "deny", message: `${REFUSAL} Reason: не трогай` }],
    ["«Отклонить» без причины (7104)", "default", "Bash", { command: "rm y" }, {}, { action: "deny" }, { behavior: "deny", message: REFUSAL }],
    ["«Одобрить» план (7111)", "plan", "ExitPlanMode", PLAN, {}, { action: "allow" }, { behavior: "allow", updatedInput: PLAN }],
    ["«Одобрить и разрешать правки» — смена режима в этой сессии (7111)", "plan", "ExitPlanMode", PLAN, {}, { action: "allow", always: true }, { behavior: "allow", updatedInput: PLAN, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }],
    ["«Вернуть с замечаниями» (7112)", "plan", "ExitPlanMode", PLAN, {}, { action: "deny", message: "добавь тест" }, { behavior: "deny", message: `${REFUSAL} Reason: добавь тест` }],
  ])("ответ человека в SDK и кадр answered: %s", async (_n, mode, tool, input, opts, reply, want) => {
    const { st } = await bench({ mode });
    const { p } = await tasked(st);
    const r = p.askWith(tool, input, opts, "toolu_r");
    await until(() => asked(st)[0]);
    expect(await answer(st, PHONE, { question: "toolu_r", ...reply })).toMatchObject({ ok: true });
    expect(await r).toEqual(want);
    expect(closed(st)[0]).toMatchObject({ question: "toolu_r", by: PHONE, action: reply.action });
  });
});

describe("сообщение от другой сессии", () => {
  it.each([
    ["от другой сессии: отправитель становится тем, кто дал задачу (8)", "site@laptop", {}, undefined, '<fleet-message from="site@laptop">\nСтанция собрана\n</fleet-message>', "site@laptop"],
    ["от родителя: задача с подсказкой, что итог уйдёт сам", "lead@pc", {}, "lead@pc", '<fleet-message from="lead@pc">\nСтанция собрана\n</fleet-message>\n(Задача от родителя lead@pc: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)', "lead@pc"],
    ["итог хода дочери (report): тот, кто дал задачу, прежний (311)", "docs@pc", { report: true }, "docs@pc", '<fleet-message from="docs@pc">\nСтанция собрана\n</fleet-message>', PHONE],
  ])("message простаивающей: %s", async (_n, from, extra, parent, content, giver) => {
    const b = await bench({ machine: "pc" });
    const s = await b.st.open("poe-bot@pc");
    const p = b.st.proc("poe-bot@pc");
    s.input("начало", { from: PHONE });
    await until(() => p.inputs.length === 1);
    b.parent = parent;
    const r = await b.st.relay.request({ type: "message", v: 1, from, to: "poe-bot@pc", text: "Станция собрана", ...extra });
    expect(r).toMatchObject({ type: "reply", ok: true });
    expect(r).not.toHaveProperty("result");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1]).toMatchObject({ type: "user", priority: "next", origin: { kind: "peer", from, name: from }, message: { role: "user", content } });
    expect(s.info.from).toBe(giver);
  });

  it("9 · message посреди команды: команда не прервана, сообщение ждёт границы шага во вводе", async () => {
    const { st } = await bench({ machine: "pc" });
    const s = await st.open("poe-bot@pc");
    const p = st.proc("poe-bot@pc");
    p.send(msg.state("running"));
    p.send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] }, parent_tool_use_id: null, session_id: "s" });
    await until(() => s.state === "busy");
    expect(await st.relay.request({ type: "message", v: 1, from: "site@laptop", to: "poe-bot@pc", text: "Прогони эталоны?" })).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].priority).toBe("next");
    expect(p.interrupts).toBe(0);
    expect(s.state).toBe("busy");
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => s.state === "idle");
    expect(p.interrupts).toBe(0);
  });

  it("71 · остановка upgrade посреди хода: новый message — shutting_down; ввод не тронут; новый Host не кладёт сообщение заново", async () => {
    const k = await keeper();
    const a = await bench({ machine: "pc", holders: k });
    await a.st.open("poe-bot@pc");
    const p = a.st.proc("poe-bot@pc");
    expect(await a.st.relay.request({ type: "message", v: 1, from: "deploy", to: "poe-bot@pc", text: "Прогони эталоны" })).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    p.send(msg.state("running"));
    void a.st.kernel.shutdown("upgrade");
    expect(await a.st.relay.request({ type: "message", v: 1, from: "deploy", to: "poe-bot@pc", text: "ещё" })).toMatchObject({ ok: false, error: "shutting_down" });
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    expect(p.interrupts).toBe(0);
    expect(p.alive).toBe(true);
    p.send(msg.result({ user_message_uuids: [p.inputs[0].uuid] }));
    p.send(msg.state("idle"));
    const b = await bench({ machine: "pc", holders: k, home: a.st.home });
    await until(() => b.st.kernel.sessions.get("poe-bot@pc")?.state === "idle");
    await new Promise((r) => setTimeout(r, 30));
    expect(p.inputs).toHaveLength(1);
  });
});
