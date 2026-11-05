// Леса границы «как сессией управляют на машине», кроме шеллов: manage, fleet, remote, machine.
// Снаружи — SDK, держатели, relay и часы стенда, вход и профиль (поддельные), служба настроек (поддельная). Настоящие соседи: chat и push.
// Только входы контракта и наблюдаемый исход: ответ со словом и причиной, кадр, query(), поле roster, текст инструмента, файл, журнал.
// Номер — эталон-источник; свойства без пометки — чьё: код.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import managePkg, { make as makeManage } from "../contract.ts";
import fleetPkg, { make as makeFleet, prompt } from "../../fleet/contract.ts";
import remotePkg, { make as makeRemote } from "../../remote/contract.ts";
import machinePkg, { make as makeMachine } from "../../machine/contract.ts";
import { make as makeChat, task, wrap } from "../../chat/contract.ts";
import push from "../../push/contract.ts";

const { FakeHolders, FakeRelay, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;
type Blocks = { content: Array<{ text: string }>; isError?: boolean };

const manifestOf = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", name, "module.json"), "utf8")) as Manifest;
const later = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const temp = (name = "switchboard-sessions-") => mkdtempSync(join(tmpdir(), name));
const OWNER = "panel-desk~owner@example.com";

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(async () => {
  timers.splice(0).forEach(clearInterval);
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

/** Вход и профиль снаружи границы: поддельные, что им пришло — в seen. */
type World = {
  seen: Array<[string, Record<string, unknown>]>;
  /** слот, который машина выбирает сама, когда запрос его не назвал */
  autoSlot?: string;
  account: () => string | undefined;
  slotReply: () => unknown;
  /** отказ модуля входа или профиля при открытии */
  opening: (f: Record<string, unknown>) => void;
};
const world = (o: Partial<World> = {}): World => ({ seen: [], account: () => undefined, slotReply: () => ({ restart: false }), opening: () => {}, ...o });

/** Host с настоящими manage, chat, fleet и machine; remote и push — по просьбе. */
async function bench(o: { machine?: string; stateHome?: string; home?: string; holders?: stand.FakeHolders; holdRoster?: boolean; remote?: string; push?: boolean; w?: World } = {}) {
  const w = o.w ?? world();
  const home = o.home ?? temp();
  const fleet = makeFleet();
  const logins = module(
    "host-logins",
    {
      fields: {
        slot: (s) => {
          const slot = s.store<{ slot?: string }>().get()?.slot;
          return slot ? { name: slot } : undefined;
        },
        account: () => w.account(),
      },
      opening: (s, f) => {
        w.seen.push(["slot", f]);
        const slot = typeof f.slot === "string" ? f.slot : w.autoSlot;
        if (slot) s.store().set({ slot });
      },
      requests: { "session.slot": (r) => (w.seen.push(["session.slot", r]), w.slotReply() as never) },
    },
    { provides: { "session.slot": 1, slot: 1, account: 1 } },
  );
  const profiles = module("host-profiles", {
    opening: (_s, f) => {
      w.seen.push(["profile", f]);
      w.opening(f);
    },
  });
  const relay = new FakeRelay();
  relay.holdRoster = !!o.holdRoster;
  const st = await standHost({
    machine: o.machine,
    home: o.stateHome,
    holders: o.holders,
    relayStand: relay,
    modules: [
      logins,
      profiles,
      ...(o.push ? [{ manifest: manifestOf("push"), module: push }] : []),
      { manifest: manifestOf("manage"), module: makeManage({ home }) },
      { manifest: manifestOf("chat"), module: makeChat() },
      { manifest: manifestOf("fleet"), module: fleet.module },
      { manifest: manifestOf("machine"), module: makeMachine({ home }) },
      ...(o.remote ? [{ manifest: manifestOf("remote"), module: makeRemote({ claudeDir: o.remote }) }] : []),
    ],
  });
  stands.push(st);
  expect(st.startError).toBeNull();
  /** Вызов инструмента MCP сессии me — как его зовёт SDK. */
  const call = async (me: string, name: string, args: Record<string, unknown> = {}) => (await fleet.tools(me).find((t) => t.name === name)!.handler(args as never, {})) as Blocks;
  const req = (f: Record<string, unknown>) => st.relay.request({ v: 1, ...f } as Frame & { type: string });
  /** поле roster сессии в последнем session.state */
  const field = (cs: string, k: string) => st.states(cs).at(-1)?.[k];
  return { st, w, home, call, req, field, fleet };
}

const text = (r: Blocks) => r.content[0].text;
const toolText = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Ответ relay на запрос type, ушедший с этого Host. */
async function replyTo(st: Stand, type: string, r: Record<string, unknown>, i = 0) {
  const f = await until(() => st.relay.frames(type)[i]);
  st.relay.deliver({ type: "reply", id: f.id as string, ...r } as Frame);
  return f;
}

describe("контракт: пакеты и вклад в query()", () => {
  it("пакет каждого модуля отдаёт объект модуля, набор проходит гейт; вклад в query(): сервер MCP fleet, позывной в системном промпте, межсессионная переписка Claude Code выключена (устав, слово 1 нояб.)", async () => {
    for (const m of [managePkg, fleetPkg, remotePkg, machinePkg]) expect(typeof m).toBe("object");
    const { st } = await bench({ remote: temp() });
    await st.open("site@laptop");
    const o = st.query("site@laptop").options as { mcpServers: Record<string, { type: string; name: string }>; systemPrompt: { append?: string }; env: Record<string, string> };
    expect(o.mcpServers.fleet).toMatchObject({ type: "sdk", name: "fleet" });
    expect(o.systemPrompt.append).toContain(prompt("site@laptop"));
    expect(o.env.CLAUDE_CODE_HARBOR_KITE).toBe("0");
  });

  it("текст для модели: системный промпт и инструменты слово в слово — их читает модель", () => {
    expect(prompt("me@pc")).toBe(
      'Ты во флоте как me@pc. Кто на связи — fleet.list; написать сессии или человеку — fleet.send. ' +
        'Открыть сессию с задачей — fleet.open: она твоя дочь, итог каждого её хода, начатого тобой, придёт сам тегом <fleet-message from="…">. ' +
        "Проект сессии — параметр project у fleet.open и fleet.update, имя в интерфейсе — fleet.label. Что делала сессия — fleet.history; модель, усилие, заголовок — fleet.update; закрыть — fleet.remove (без callsign — себя, после этого хода). " +
        'Сообщения флота приходят во ввод тегом <fleet-message from="…">; вопрос другой сессии — тегом <fleet-question>, ответ на него — fleet.answer. ' +
        "Если тебя открыла другая сессия, итог твоего хода, начатого ею, уйдёт ей сам — отвечать ей отдельно не нужно.",
    );
    const tools = makeFleet().tools("me@pc") as Array<{ name: string; description: string; inputSchema: Record<string, { description?: string }> }>;
    const params = (t: (typeof tools)[number]) => Object.fromEntries(Object.entries(t.inputSchema).map(([k, v]) => [k, v.description ?? null]));
    expect(tools.map((t) => [t.name, t.description, params(t)])).toEqual([
      ["list", "Кто на связи: сессии флота с состоянием, родителем, моделью, именем и проектом; машины с именами; проекты; клиенты (телефон, пульт).", {}],
      ["send", "Написать сессии флота (callsign имя@машина) или человеку: всем его устройствам ~email или одному устройство~email. Ответа адресата не ждёт.", { to: "callsign сессии, ~email человека или устройство~email", text: "текст сообщения" }],
      ["answer", "Ответить на вопрос другой сессии (тег <fleet-question>), которой эта сессия дала задачу.", { to: "callsign сессии, задавшей вопрос", question: "id вопроса из тега", answers: "текст вопроса → ответ; несколько вариантов — через запятую" }],
      [
        "open",
        "Открыть сессию с задачей на любой машине флота. Она твоя дочь: итог каждого её хода, начатого тобой, придёт сам. Без параметра slot: на машине один слот — он, слотов нет — общий вход, а без него слот main из вошедших аккаунтов (их нет — отказ), два и больше — отказ со списком слотов.",
        {
          name: "имя сессии: буквы, цифры, . _ -",
          dir: "папка: от ~ или полный путь",
          text: "задача — первое сообщение сессии",
          machine: "машина; по умолчанию — твоя",
          profile: "профиль сессии",
          model: null,
          effort: null,
          slot: "имя слота машины",
          project: "имя проекта: сессия встанет в его конец, нет такого — создастся; без него — в проект открывшей",
        },
      ],
      ["history", "Что делала сессия: последние записи разговора — ввод, ответы, вызванные инструменты.", { callsign: null, limit: "сколько записей; по умолчанию 20" }],
      [
        "update",
        "Сменить сессии слот, модель, усилие, заголовок разговора или проект. Живой сессии модель и усилие — сразу, слот — перезапуском между ходами. Слот меняется первым: его отказ не меняет остального.",
        { callsign: null, slot: "имя слота машины этой сессии", model: null, effort: null, title: null, project: "имя проекта: конец его списка, нет такого — создастся; пустая строка — без проекта" },
      ],
      ["label", "Имя в интерфейсе: сессии (site@laptop) или машины (@laptop); адрес остаётся адресом. Пустой текст снимает имя.", { to: "callsign сессии или @машина", text: "имя; пустое — снять" }],
      ["remove", "Закрыть сессию: она забыта, разговор остаётся на диске машины. Другую — сразу; без callsign — себя, после этого хода.", { callsign: null }],
    ]);
  });
});

describe("session.open", () => {
  it("87 · с профилем и слотом без модели: один запрос открытия доходит до модулей; ответ называет слот; журнал флота называет его; в разделе manage только родитель", async () => {
    // источник: принятый дизайн: значение «до старта» едет запросом открытия; чьё: код — профиль и слот у своих владельцев
    const { st, w, home, req } = await bench();
    const dir = mkdtempSync(join(home, "d-"));
    const r = await req({ type: "session.open", machine: "laptop", name: "board", dir, profile: "team/profiles/ops", slot: "main" });
    expect(r).toMatchObject({ ok: true, result: { callsign: "board@laptop", slot: "main" } });
    expect(w.seen.map((x) => x[0]).sort()).toEqual(["profile", "slot"]);
    expect(w.seen[0][1]).toMatchObject({ name: "board", profile: "team/profiles/ops", slot: "main", from: OWNER });
    const part = st.query("board@laptop").options as Record<string, unknown>;
    expect(part).toMatchObject({ enableFileCheckpointing: true, title: "board" });
    expect(part.model).toBeUndefined();
    expect(st.session("host-manage", "board@laptop")!.store().get()).toEqual({ parent: OWNER });
    expect(st.relay.frames("ledger.add")).toEqual([expect.objectContaining({ to: ".ledger", ev: "session.opened", by: OWNER, machine: "laptop", callsign: "board@laptop", text: `board@laptop создана · ${dir} · слот main` })]);
  });

  it("87 · от ~: ответ после initialize; spec — папка от ~ и заголовок из файла разговора; родитель в roster; слот в ответе null", async () => {
    const { st, home, req, field } = await bench();
    mkdirSync(join(home, "Projects", "switchboard"), { recursive: true });
    const r = await req({ type: "session.open", machine: "laptop", name: "board", dir: "~/Projects/switchboard" });
    expect(r).toMatchObject({ ok: true, result: { callsign: "board@laptop", slot: null } });
    expect(st.query("board@laptop").options).toMatchObject({ cwd: join(home, "Projects", "switchboard"), title: "board", enableFileCheckpointing: true });
    expect(st.relay.frames("ledger.add")).toEqual([expect.objectContaining({ text: "board@laptop создана · ~/Projects/switchboard" })]);
    const asked: unknown[] = [];
    st.sdk.functions = { getSessionInfo: async (...a: unknown[]) => (asked.push(a[0]), { summary: "о чём", customTitle: "Заголовок" }) };
    expect(await req({ type: "session.spec", callsign: "board@laptop" })).toMatchObject({ ok: true, result: { dir: "~/Projects/switchboard", model: null, effort: null, title: "Заголовок" } });
    st.sdk.functions = { getSessionInfo: async () => ({ summary: "о чём" }) };
    expect(await req({ type: "session.spec", callsign: "board@laptop" })).toMatchObject({ result: { title: "о чём" } });
    expect(asked[0]).toBe((r.result as { session_id: string }).session_id);
    await until(() => field("board@laptop", "parent") === OWNER);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["имя с пробелом", { name: "a b", dir: "~/p" }, "bad_name", 'session.open: имя "a b"'],
    ["имени нет", { dir: "~/p" }, "bad_name", "session.open: имя undefined"],
    ["number не флаг", { name: "x", dir: "~/p", number: "да" }, "bad_spec", "session.open x: number"],
    ["папка не от ~ (правило ядра clientPath)", { name: "x", dir: "p" }, "bad_dir", 'session.open x@laptop: папка "p" не от ~ и не полная'],
    ["папки нет", { name: "x", dir: "~/нет" }, "bad_dir", "session.open x@laptop: папки ~/нет нет"],
    ["mkdir не флаг", { name: "x", dir: "~/p", mkdir: "да" }, "bad_spec", "session.open x@laptop: mkdir"],
    ["усилие не того вида", { name: "x", dir: "~/p", effort: "ultra" }, "bad_spec", 'session.open x: effort = "ultra"'],
    ["модель пустая", { name: "x", dir: "~/p", model: "" }, "bad_spec", 'session.open x: model = ""'],
    ["fast не флаг", { name: "x", dir: "~/p", fast: 1 }, "bad_spec", "session.open x: fast = 1"],
    ["стиль пустой", { name: "x", dir: "~/p", style: "" }, "bad_spec", 'session.open x: style = ""'],
    ["thinking не флаг", { name: "x", dir: "~/p", thinking: "да" }, "bad_spec", 'session.open x: thinking = "да"'],
    ["заголовок пустой", { name: "x", dir: "~/p", title: "" }, "bad_spec", 'session.open x: title = ""'],
    ["resume не строка", { name: "x", dir: "~/p", resume: 1 }, "bad_spec", "session.open x@laptop: resume"],
    ["fork не флаг", { name: "x", dir: "~/p", fork: "да" }, "bad_spec", "session.open x@laptop: fork"],
    ["point не число", { name: "x", dir: "~/p", point: "3" }, "bad_spec", "session.open x@laptop: point"],
    ["имя занято", { name: "site", dir: "~/p" }, "name_taken", "session.open: site@laptop уже есть"],
  ])("вход отклонён, сессии нет: %s", async (_n, f, word, why) => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    await st.open("site@laptop");
    expect(await req({ type: "session.open", machine: "laptop", ...f })).toMatchObject({ ok: false, error: word, why });
    expect([...st.kernel.sessions.keys()]).toEqual(["site@laptop"]);
    expect(st.journal().find((l) => l.ev === "request" && l.word === word)?.why).toContain(why);
  });

  it("незнакомое поле — не ошибка; модель и флаги — в query() и разделе; повторный старт без заголовка (3034)", async () => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    expect(await req({ type: "session.open", machine: "laptop", name: "site", dir: "~/p", color: "red", model: "m", effort: "high", fast: true, style: "s", thinking: true })).toMatchObject({ ok: true });
    const first = st.query("site@laptop").options as Record<string, any>;
    expect(first).toMatchObject({ model: "m", effort: "high", enableFileCheckpointing: true, title: "site", settings: { fastMode: true, outputStyle: "s", alwaysThinkingEnabled: true } });
    expect(first.settings.effortLevel).toBeUndefined();
    expect(first.hooks?.PostModelSwitch).toBeDefined();
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "m", effort: "high", fast: true, style: "s", thinking: true, parent: OWNER });
    const s = st.session("host-manage", "site@laptop")!;
    await s.stop();
    await s.start();
    const again = st.query("site@laptop").options as Record<string, any>;
    expect(again).toMatchObject({ model: "m", effort: "high", enableFileCheckpointing: true });
    expect(again.title).toBeUndefined();
  });

  it("6203 · mkdir строит весь путь; без просьбы папка не появляется; занятое и неверное имя пути не создают", async () => {
    const { st, home, req } = await bench();
    await st.open("site@laptop");
    expect(await req({ type: "session.open", machine: "laptop", name: "a", dir: "~/new/deep/path" })).toMatchObject({ ok: false, error: "bad_dir" });
    expect(await req({ type: "session.open", machine: "laptop", name: "site", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: false, error: "name_taken" });
    expect(await req({ type: "session.open", machine: "laptop", name: "a b", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: false, error: "bad_name" });
    expect(existsSync(join(home, "new"))).toBe(false);
    expect(await req({ type: "session.open", machine: "laptop", name: "a", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: true, result: { callsign: "a@laptop" } });
    expect(st.query("a@laptop").options.cwd).toBe(join(home, "new", "deep", "path"));
  });

  it("6204 · mkdir: на месте файл или файл в родителях — bad_dir словом, модуль жив; существующая папка — обычное открытие; полный путь — как есть (3118)", async () => {
    const { st, home, req } = await bench();
    writeFileSync(join(home, "file"), "x");
    expect(await req({ type: "session.open", machine: "laptop", name: "a", dir: "~/file", mkdir: true })).toMatchObject({ ok: false, error: "bad_dir" });
    expect(await req({ type: "session.open", machine: "laptop", name: "a", dir: "~/file/sub", mkdir: true })).toMatchObject({ ok: false, error: "bad_dir" });
    mkdirSync(join(home, "p"));
    expect(await req({ type: "session.open", machine: "laptop", name: "a", dir: "~/p", mkdir: true })).toMatchObject({ ok: true });
    expect(await req({ type: "session.open", machine: "laptop", name: "y", dir: join(home, "p") })).toMatchObject({ ok: true });
    expect(st.query("y@laptop").options.cwd).toBe(join(home, "p"));
  });

  it("процесс вышел до initialize — open_failed, повтора нет; запись остаётся у ядра, журнал флота не пишется, имя занято", async () => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    st.holders.failInitNext = 1;
    const pr = req({ type: "session.open", machine: "laptop", name: "x", dir: "~/p" });
    await until(() => st.holders.procs.get("x@laptop"));
    st.proc("x@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed", why: expect.stringMatching(/^x@laptop: /) });
    expect(st.journal().some((l) => l.ev === "request" && l.word === "open_failed" && String(l.why).includes("x@laptop"))).toBe(true);
    expect(st.kernel.sessions.has("x@laptop")).toBe(true);
    expect(st.relay.frames("ledger.add").filter((f) => f.ev === "session.opened")).toHaveLength(0);
    expect(await req({ type: "session.open", machine: "laptop", name: "x", dir: "~/p" })).toMatchObject({ ok: false, error: "name_taken" });
  });

  it("320 · отказ владельца при открытии (нет профиля): слово и причина наружу, сессии, процесса и новой папки нет; без профиля имя свободно", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Нет папки или профиля типа — … no_profile, причина в журнале; сессии нет»; имя свободно — чьё: код
    const w = world({ opening: (f) => {
      if (f.profile) throw refuse("no_profile", `нет профиля ${String(f.profile)}`);
    } });
    const { st, home, req } = await bench({ w });
    expect(await req({ type: "session.open", machine: "laptop", name: "board", dir: "~", profile: "you/profiles/missing" })).toMatchObject({ ok: false, error: "no_profile", why: "нет профиля you/profiles/missing" });
    expect(st.journal().some((l) => l.ev === "request" && l.word === "no_profile")).toBe(true);
    expect(st.kernel.sessions.has("board@laptop")).toBe(false);
    const fresh = join(home, "new-folder");
    expect(await req({ type: "session.open", machine: "laptop", name: "board", dir: fresh, mkdir: true, profile: "you/profiles/missing" })).toMatchObject({ ok: false, error: "no_profile" });
    expect(existsSync(fresh)).toBe(false);
    expect(st.sdk.queries.length).toBe(0);
    expect(await req({ type: "session.open", machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop", slot: null } });
  });

  it("number: первый свободный номер; два сразу — разные; убранный номер снова свободен; заголовок с номером", async () => {
    const { st, home, req } = await bench();
    const dir = join(home, "ops");
    mkdirSync(dir);
    const open = () => req({ type: "session.open", machine: "laptop", name: "disk-full", number: true, dir });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-1@laptop" } });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-2@laptop" } });
    const both = await Promise.all([open(), open()]);
    expect(both.map((r) => (r.result as { callsign: string }).callsign).sort()).toEqual(["disk-full-3@laptop", "disk-full-4@laptop"]);
    await req({ type: "session.remove", callsign: "disk-full-1@laptop" });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-1@laptop" } });
    expect(st.query("disk-full-2@laptop").options.title).toBe("disk-full-2");
  });

  it("3028 · resume — session_id прежний, старт resume; fork — новый разговор от прежнего", async () => {
    const { st, req } = await bench();
    const sid = "11111111-2222-4333-8444-555555555555";
    const r = await req({ type: "session.open", machine: "laptop", name: "r", dir: "~", resume: sid });
    expect(r).toMatchObject({ ok: true, result: { callsign: "r@laptop", session_id: sid } });
    expect(st.session("host-manage", "r@laptop")!.info.start).toBe("resume");
    expect(st.query("r@laptop").options.resume).toBe(sid);
    const f = await req({ type: "session.open", machine: "laptop", name: "f", dir: "~", resume: sid, fork: true });
    expect((f.result as { session_id: string }).session_id).not.toBe(sid);
    expect(st.query("f@laptop").options).toMatchObject({ resume: sid, forkSession: true });
  });

  it("321 · журнал флота не отвечает: open и remove исполнены, заметка ledger.add offline в журнале Host", async () => {
    // источник: устав — прямой запрос к Worker'у не прошёл — отказ словом; заметка без очереди — чьё: код (клиент флота onLost)
    const { st, req } = await bench();
    st.relay.workersDown = true;
    expect(await req({ type: "session.open", machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop" } });
    expect(await req({ type: "session.remove", callsign: "board@laptop" })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("board@laptop")).toBe(false);
    const notes = await until(() => {
      const n = st.journal().filter((l) => l.ev === "ledger.add" && l.word === "offline");
      return n.length === 2 && n;
    });
    expect(notes.map((l) => String(l.why).split(" ")[0])).toEqual(["ledger.add", "ledger.add"]);
  });
});

describe("session.call: открытые методы query()", () => {
  it("84 · ответ SDK как есть; close — unknown_method словами, не вызван; процесс жив", async () => {
    const { st, req } = await bench();
    await st.open("site@laptop");
    const usage = { totalTokens: 41210, maxTokens: 200000, percentage: 21, categories: [{ name: "messages", tokens: 30000 }] };
    const q = st.query("site@laptop") as unknown as Record<string, unknown>;
    q.getContextUsage = async () => usage;
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "getContextUsage", args: [] })).toMatchObject({ ok: true, result: usage });
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "close" })).toMatchObject({ ok: false, error: "unknown_method", why: "session.call site@laptop: close — нет в списке открытых" });
    expect(st.query("site@laptop").calls.map((c) => c.name)).not.toContain("close");
    expect(st.proc("site@laptop").alive).toBe(true);
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
  });

  it("7000 · все открытые методы: аргументы и ответ SDK как есть; список закреплён — вне его unknown_method", async () => {
    // источник: устав — Switchboard заменяет claude-fleet, все его функции (слово пользователя 31 окт.), исключение устава 4 нояб.; цель 3 нояб.: «со всеми фичами claude»
    const { st, req } = await bench();
    await st.open("site@laptop");
    const q = st.query("site@laptop") as unknown as Record<string, unknown>;
    const table: Array<[string, unknown[], unknown]> = [
      ["interrupt", [], { still_queued: [] }],
      ["getContextUsage", [], { percentage: 1 }],
      ["supportedCommands", [], ["/x"]],
      ["supportedModels", [], ["m"]],
      ["supportedAgents", [], ["a"]],
      ["mcpServerStatus", [], []],
      ["toggleMcpServer", ["github", false], true],
      ["reconnectMcpServer", ["github"], true],
      ["rewindFiles", ["u1"], true],
      ["stopTask", ["t1"], true],
      ["backgroundTasks", [], []],
      ["reloadPlugins", [], true],
      ["askSideQuestion", ["что?"], { response: "ответ", synthetic: false }],
      ["getTaskOutput", ["t1"], { output: "хвост", total_bytes: 5, truncated: false }],
      ["cancelAsyncMessage", ["u1"], true],
      ["mcpAuthenticate", ["github"], { authUrl: "https://example.com/login" }],
      ["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", [{ skipBehaviors: true }], { session: { total_cost_usd: 1 } }],
      ["getStatus", [], { sections: [] }],
      ["getHooksListing", [], { hooks: [] }],
      ["setPermissionMode", ["plan"], true],
      ["listPermissionRules", [], { state: { rules: [{ rule: "Bash(echo:*)" }] } }],
    ];
    for (const [method, args, result] of table) {
      let got: unknown[] = [];
      q[method] = async (...a: unknown[]) => ((got = a), result);
      expect(await req({ type: "session.call", callsign: "site@laptop", method, args }), method).toMatchObject({ ok: true, result });
      expect(got, method).toEqual(args);
    }
    for (const method of ["setModel", "applyFlagSettings", "close", "renameSession", "enableRemoteControl", 7]) expect(await req({ type: "session.call", callsign: "site@laptop", method }), String(method)).toMatchObject({ ok: false, error: "unknown_method" });
  });

  it("7001 · метода нет у SDK или он отказал — sdk_error с причиной, модуль и сессия живы; args не массив — bad_spec; остановленной — stopped", async () => {
    // источник: устав — система ловит: отказ словом и причина в журнале; часть методов есть только во время исполнения SDK
    const { st, req } = await bench();
    await st.open("site@laptop");
    const q = st.query("site@laptop") as unknown as Record<string, unknown>;
    q.askSideQuestion = undefined;
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "askSideQuestion", args: ["что?"] })).toMatchObject({ ok: false, error: "sdk_error", why: expect.stringMatching(/^site@laptop: askSideQuestion — /) });
    q.toggleMcpServer = async () => {
      throw new Error("нет сервера github");
    };
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "toggleMcpServer", args: ["github", false] })).toMatchObject({ ok: false, error: "sdk_error", why: "site@laptop: toggleMcpServer — нет сервера github" });
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "supportedModels" })).toMatchObject({ ok: true });
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "interrupt", args: "x" })).toMatchObject({ ok: false, error: "bad_spec", why: "session.call site@laptop: args не массив" });
    await st.kernel.sessions.get("site@laptop")!.stop();
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "supportedModels" })).toMatchObject({ ok: false, error: "stopped", why: "session.call site@laptop: supportedModels — сессия stopped" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });
});

describe("режим разрешений", () => {
  const inPlan = async (st: Stand) => {
    await st.open("site@laptop");
    st.proc("site@laptop").send({ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "u1", session_id: "s" });
    await until(() => st.states("site@laptop").at(-1)?.mode === "plan");
  };

  it("7120 · поле roster mode — режим из кадров SDK status и init, по умолчанию bypassPermissions", async () => {
    // источник: цель пользователя 4 нояб. «чат со всеми фичами»; настоящий процесс: кадр status и init несут permissionMode
    const { st } = await bench();
    await st.open("site@laptop");
    const mode = () => st.states("site@laptop").at(-1)?.mode;
    await until(() => mode() === "bypassPermissions");
    st.proc("site@laptop").send({ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "u1", session_id: "s" });
    await until(() => mode() === "plan");
    st.proc("site@laptop").send({ type: "system", subtype: "init", permissionMode: "bypassPermissions", uuid: "u2", session_id: "s" });
    await until(() => mode() === "bypassPermissions");
  });

  it("7200 · режим переживает новый процесс: процесс умер — resume с тем же режимом", async () => {
    // источник: цель пользователя 4 нояб.: режим, выбранный человеком, не сбрасывается сам в «без вопросов»
    const { st } = await bench();
    await inPlan(st);
    expect(st.query("site@laptop").options.permissionMode).toBe("bypassPermissions");
    st.proc("site@laptop").exit(1, "boom");
    await until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
    expect(st.query("site@laptop").options.permissionMode).toBe("plan");
  });

  it("7201 · режим переживает session.stop и session.start", async () => {
    const { st, req } = await bench();
    await inPlan(st);
    await req({ type: "session.stop", callsign: "site@laptop" });
    expect(await req({ type: "session.start", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(st.query("site@laptop").options.permissionMode).toBe("plan");
  });

  it("7202 · режим переживает перезапуск Host: новый Host поднимает сессию с тем же режимом", async () => {
    const home = temp();
    const a = await bench({ home });
    await inPlan(a.st);
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    const { st } = await bench({ home, stateHome: a.st.home });
    await until(() => st.kernel.sessions.get("site@laptop")?.state === "idle");
    expect(st.query("site@laptop").options.permissionMode).toBe("plan");
  });

  it("7203 · новая сессия и сессия в «без вопросов»: query() с bypassPermissions — режим устава", async () => {
    // источник: устав «Режим „разрешено всё“» (слово пользователя 4 нояб.)
    const { st, req } = await bench();
    await st.open("site@laptop");
    expect(st.query("site@laptop").options.permissionMode).toBe("bypassPermissions");
    await until(() => st.states("site@laptop").at(-1)?.mode === "bypassPermissions");
    await req({ type: "session.stop", callsign: "site@laptop" });
    await req({ type: "session.start", callsign: "site@laptop" });
    expect(st.query("site@laptop").options.permissionMode).toBe("bypassPermissions");
  });
});

describe("session.update", () => {
  it("85 · посреди хода: setModel и applyFlagSettings сразу, ход не прерван; после resume query() с новой моделью и усилием", async () => {
    const { st, req } = await bench();
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "busy");
    expect(await req({ type: "session.update", callsign: "site@laptop", model: "sonnet", effort: "medium" })).toMatchObject({ ok: true, result: { now: ["model", "effort"] } });
    expect(st.query("site@laptop").calls).toEqual([
      { name: "setModel", args: ["sonnet"] },
      { name: "applyFlagSettings", args: [{ effortLevel: "medium" }] },
    ]);
    expect(p.interrupts).toBe(0);
    p.exit(1, "упал");
    await until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
    expect(st.query("site@laptop").options).toMatchObject({ model: "sonnet", effort: "medium", resume: st.kernel.sessions.get("site@laptop")!.rec.session_id });
  });

  it("живой: флаги ответа — applyFlagSettings ключами settings; roster узнаёт модель и усилие сразу", async () => {
    const { st, req, field } = await bench();
    await st.open("site@laptop");
    expect(await req({ type: "session.update", callsign: "site@laptop", effort: "high", fast: true, style: "s", thinking: false, model: "m" })).toMatchObject({ result: { now: ["model", "effort", "fast", "style", "thinking"] } });
    expect(st.query("site@laptop").calls).toContainEqual({ name: "applyFlagSettings", args: [{ effortLevel: "high", fastMode: true, outputStyle: "s", alwaysThinkingEnabled: false }] });
    await until(() => field("site@laptop", "model") === "m" && field("site@laptop", "effort") === "high");
  });

  it("остановленной: спецификация записана, методов нет; start — query() с новой моделью и флагами", async () => {
    const { st, req } = await bench();
    const s = await st.open("site@laptop");
    await s.stop();
    expect(await req({ type: "session.update", callsign: "site@laptop", model: "haiku", style: "Explanatory", thinking: false })).toMatchObject({ ok: true, result: { now: [] } });
    await s.start();
    expect(st.query("site@laptop").options).toMatchObject({ model: "haiku", settings: { outputStyle: "Explanatory", alwaysThinkingEnabled: false } });
    expect(st.query("site@laptop").options.title).toBeUndefined();
  });

  it("237 · заголовок: остановленной — функция SDK, живой — метод query; раздел manage заголовка не хранит", async () => {
    const { st, req } = await bench();
    const docs = await st.open("docs@laptop");
    await docs.stop();
    expect(await req({ type: "session.update", callsign: "docs@laptop", title: "Документы" })).toMatchObject({ ok: true, result: { now: ["title"] } });
    expect(st.sdk.fnCalls.filter((c) => c.name === "renameSession")).toEqual([{ name: "renameSession", args: [docs.info.session_id, "Документы", { dir: docs.info.cwd }] }]);
    expect(st.session("host-manage", "docs@laptop")!.store().get()).toBeUndefined();
    await st.open("site@laptop");
    await req({ type: "session.update", callsign: "site@laptop", title: "Сайт" });
    expect(st.query("site@laptop").calls).toContainEqual({ name: "renameSession", args: ["Сайт", expect.any(String)] });
  });

  it("324 · усилие не того вида — bad_spec с причиной в журнале; SDK не вызван, в roster усилия нет", async () => {
    // источник: устав — ошибки словами; слово bad_spec — чьё: код (контракт manage)
    const { st, req } = await bench();
    await st.open("docs@laptop");
    expect(await req({ type: "session.update", callsign: "docs@laptop", effort: "turbo" })).toMatchObject({ ok: false, error: "bad_spec", why: 'session.update docs@laptop: effort = "turbo"' });
    expect(st.journal().some((l) => l.word === "bad_spec" && String(l.why).includes("effort"))).toBe(true);
    expect(st.query("docs@laptop").calls).toEqual([]);
    expect(st.states("docs@laptop").at(-1)!.effort).toBeUndefined();
  });

  it("325 · SDK отказал setModel или getSessionInfo — sdk_error, причина в журнале; manage не выключен (3030)", async () => {
    // источник: устав — ошибки словами; «отказ SDK — слово sdk_error, причина в журнале; модуль не выключается» — чьё: код
    const { st, req } = await bench();
    await st.open("docs@laptop");
    (st.query("docs@laptop") as unknown as Record<string, unknown>).setModel = async () => {
      throw new Error("модели нет");
    };
    expect(await req({ type: "session.update", callsign: "docs@laptop", model: "sonnet" })).toMatchObject({ ok: false, error: "sdk_error", why: "docs@laptop: setModel — модели нет" });
    expect(st.journal().some((l) => l.word === "sdk_error" && String(l.why).includes("модели нет"))).toBe(true);
    st.sdk.functions = {
      getSessionInfo: async () => {
        throw new Error("файла нет");
      },
    };
    expect(await req({ type: "session.spec", callsign: "docs@laptop" })).toMatchObject({ ok: false, error: "sdk_error", why: "docs@laptop: getSessionInfo — файла нет" });
    expect(st.states("docs@laptop").every((f) => !f.failed)).toBe(true);
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("PostModelSwitch: модель сменили в claude.ai — спецификация и поле берут новую; source resume — не трогает; без requested_model — выбор снят (3035)", async () => {
    const { st } = await bench();
    const s = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    await p.hook("PostModelSwitch", { from_model: "a", to_model: "claude-opus-5", requested_model: "opus", source: "command" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    await p.hook("PostModelSwitch", { requested_model: "sonnet", source: "resume" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    s.input("x");
    turn(p);
    await until(() => st.states("site@laptop").at(-1)?.model === "opus");
    await p.hook("PostModelSwitch", { requested_model: null, source: "command" });
    await s.stop();
    await s.start();
    expect(st.query("site@laptop").options.model).toBeUndefined();
  });
});

describe("session.stop, start, remove", () => {
  it("86 · stop посреди команды: interrupt, result, close(); stopped и сама не поднимается; start — resume с тем же session_id", async () => {
    const { st, req } = await bench();
    const s = await st.open("site@laptop");
    const sid = s.info.session_id;
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    expect(await req({ type: "session.stop", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(p.interrupts).toBe(1);
    expect(st.query("site@laptop").calls.map((c) => c.name)).toEqual(["interrupt", "close"]);
    expect(st.states("site@laptop").at(-1)?.state).toBe("stopped");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(await req({ type: "session.start", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
    expect(st.query("site@laptop").options.resume).toBe(sid);
    expect(s.info.session_id).toBe(sid);
    expect(s.state).toBe("idle");
  });

  it("3031 · session.start поднимает сессию failed", async () => {
    // источник: слово пользователя (устав: «второй сбой до готовности — failed», дальше решает агент)
    const { st, req } = await bench();
    const s = await st.open("site@laptop");
    st.holders.failInitNext = 1;
    st.proc("site@laptop").exit(1, "первый");
    await until(() => st.sdk.of("site@laptop").length === 2 && st.holders.procs.get("site@laptop")?.initializes === 1);
    st.proc("site@laptop").exit(1, "второй");
    await until(() => s.state === "failed");
    expect(await req({ type: "session.start", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(s.state).toBe("idle");
  });

  it("3032 · session.start: не поднялась — open_failed; point не число — bad_spec; из точки — старт point с номером (3033)", async () => {
    const { st, req } = await bench();
    const s = await st.open("site@laptop");
    await s.stop();
    expect(await req({ type: "session.start", callsign: "site@laptop", point: "3" })).toMatchObject({ ok: false, error: "bad_spec", why: "session.start site@laptop: point" });
    st.holders.failInitNext = 1;
    const pr = req({ type: "session.start", callsign: "site@laptop" });
    await until(() => st.sdk.of("site@laptop").length === 2);
    st.proc("site@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed", why: expect.stringMatching(/^site@laptop: /) });
    await s.stop();
    expect(await req({ type: "session.start", callsign: "site@laptop", point: 3 })).toMatchObject({ ok: true });
    expect([s.info.start, s.info.point]).toEqual(["point", 3]);
  });

  it("remove: запись убрана, раздел стёрт; ledger.add session.removed с тем, кто просил; больше не отвечает", async () => {
    const { st, req } = await bench();
    await st.open("wiki@laptop");
    await req({ type: "session.update", callsign: "wiki@laptop", model: "opus" });
    expect(await req({ type: "session.remove", callsign: "wiki@laptop" })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(false);
    expect(st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", text: "wiki@laptop забыта", callsign: "wiki@laptop", by: OWNER });
    expect(await req({ type: "session.spec", callsign: "wiki@laptop" })).toMatchObject({ ok: false, error: "offline" });
  });

  it("remove с after_turn посреди хода: ответ after_turn, ход не прерван, сессия убрана после конца; журнал — от того, кто просил; простаивающая — сразу", async () => {
    const { st, req } = await bench();
    const s = await st.open("wiki@laptop");
    const p = st.proc("wiki@laptop");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    expect(await req({ type: "session.remove", callsign: "wiki@laptop", after_turn: true, from: "lead@laptop" })).toMatchObject({ ok: true, result: { after_turn: true } });
    expect(p.interrupts).toBe(0);
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(true);
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => !st.kernel.sessions.has("wiki@laptop"));
    expect(p.interrupts).toBe(0);
    expect(st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: "lead@laptop" });
    await st.open("docs@laptop");
    expect(await req({ type: "session.remove", callsign: "docs@laptop", after_turn: true })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("docs@laptop")).toBe(false);
  });

  it("322 · remove after_turn посреди хода, Host перезапущен, ход кончился у держателя — новый Host убирает сессию; session.removed в журнале флота", async () => {
    // источник: устав — после перезапуска Host модуль поднимает своё из хранилища; принятый дизайн — «убрать после конца идущего хода»
    const k = new FakeHolders();
    keepers.push(k);
    const home = temp();
    const a = await bench({ holders: k, home });
    const s = await a.st.open("wiki@laptop");
    const p = k.procs.get("wiki@laptop")!;
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    expect(await a.req({ type: "session.remove", callsign: "wiki@laptop", after_turn: true })).toMatchObject({ ok: true, result: { after_turn: true } });
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await until(() => p.sock === null);
    p.send(msg.result({ result: "готово" }));
    p.send(msg.state("idle"));
    const b = await bench({ holders: k, home, stateHome: a.st.home });
    await until(() => !b.st.kernel.sessions.has("wiki@laptop"));
    expect(p.interrupts).toBe(0);
    expect(b.st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: OWNER });
  });

  it("323 · remove с after_turn не true — bad_spec, сессия на месте", async () => {
    // источник: устав — ошибки словами; слово bad_spec — чьё: код (контракт manage)
    const { st, req } = await bench();
    await st.open("wiki@laptop");
    expect(await req({ type: "session.remove", callsign: "wiki@laptop", after_turn: "yes" })).toMatchObject({ ok: false, error: "bad_spec", why: "session.remove wiki@laptop: after_turn" });
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(true);
  });
});

describe("machine.dirs", () => {
  async function pc() {
    const b = await bench({ machine: "pc" });
    mkdirSync(join(b.home, "Projects"));
    for (const d of ["wiki", "poe2", "switchboard", "site"]) mkdirSync(join(b.home, "Projects", d));
    writeFileSync(join(b.home, "Projects", "README.md"), "#");
    writeFileSync(join(b.home, "Projects", "todo.txt"), "-");
    const dirs = (path?: unknown) => b.req({ type: "machine.dirs", machine: "pc", ...(path === undefined ? {} : { path }) });
    return { ...b, dirs };
  }

  it("90 · ~/Projects: только папки по имени, файлов нет; сессии и процессы не тронуты; ~ и полный путь; папка на точку отдаётся", async () => {
    const { st, home, dirs } = await pc();
    expect(await dirs("~/Projects")).toMatchObject({ type: "reply", ok: true, result: { path: "~/Projects", dirs: ["poe2", "site", "switchboard", "wiki"] } });
    expect(st.holders.ops).toEqual([]);
    expect(st.kernel.sessions.size).toBe(0);
    mkdirSync(join(home, ".claude"));
    expect(await dirs("~")).toMatchObject({ ok: true, result: { dirs: [".claude", "Projects"] } });
    expect(await dirs(join(home, "Projects"))).toMatchObject({ ok: true, result: { path: join(home, "Projects") } });
  });

  it("91 · опечатка — not_found, путь не от ~ и пути нет — bad_frame; строки refuse с путём и отправителем; ничего не создано", async () => {
    const { st, home, dirs } = await pc();
    expect(await dirs("~/Projets")).toMatchObject({ ok: false, error: "not_found", why: `machine.dirs «~/Projets» от ${OWNER}: ENOENT` });
    expect(await dirs("Projects")).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «Projects» от ${OWNER}: путь не от ~ и не полный` });
    expect(await dirs()).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «undefined» от ${OWNER}: нет пути` });
    expect(st.journal().filter((l) => l.kind === "refuse" && l.ev === "request").map((l) => l.word)).toEqual(["not_found", "bad_frame", "bad_frame"]);
    expect(readdirSync(home)).toEqual(["Projects"]);
  });

  it("6201 · имя в 300 знаков и путь-файл — not_found, machine не выключен (факт: опыт на Linux, ENAMETOOLONG)", async () => {
    const { dirs } = await pc();
    expect(await dirs(`~/${"x".repeat(300)}`)).toMatchObject({ ok: false, error: "not_found" });
    expect(await dirs("~/Projects/todo.txt")).toMatchObject({ ok: false, error: "not_found" });
    expect(await dirs("~/Projects")).toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("3015 · нет доступа — no_access; модуль жив", async () => {
    const { home, dirs } = await pc();
    const p = join(home, "locked");
    mkdirSync(p);
    chmodSync(p, 0);
    expect(await dirs(p)).toMatchObject({ ok: false, error: "no_access" });
    expect(await dirs("~")).toMatchObject({ ok: true });
  });

  it("3016 · незнакомая ошибка ОС — ошибка модуля, machine выключен на машине", async () => {
    // источник: слово пользователя (устав: «ошибка модуля — модуль выключен»)
    const { st, dirs } = await pc();
    expect(await dirs("~/a\u0000b")).toMatchObject({ ok: false, error: "module_error" });
    expect(await dirs("~")).toMatchObject({ ok: false, error: "module_error" });
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-machine")).toBe(true);
  });
});

describe("fleet: переписка", () => {
  it("10 · две сессии в одном Host: api пишет docs, docs отвечает", async () => {
    const { st, call } = await bench();
    await st.open("api@laptop");
    await st.open("docs@laptop");
    expect(await call("api@laptop", "send", { to: "docs@laptop", text: "Сколько будет 17*3?" })).toEqual(toolText("доставлено: docs@laptop"));
    await until(() => st.proc("docs@laptop").inputs.length === 1);
    expect(st.proc("docs@laptop").inputs[0].message.content).toBe(wrap("api@laptop", "Сколько будет 17*3?"));
    expect(text(await call("docs@laptop", "send", { to: "api@laptop", text: "17*3 = 51" }))).toBe("доставлено: api@laptop");
    await until(() => st.proc("api@laptop").inputs.length === 1);
    expect(st.proc("api@laptop").inputs[0].message.content).toBe('<fleet-message from="docs@laptop">\n17*3 = 51\n</fleet-message>');
  });

  it("70 · send на другую машину, её нет: relay отвечает offline — ошибка инструмента, сообщение нигде не осталось", async () => {
    const { st, call } = await bench();
    await st.open("site@laptop");
    const pending = call("site@laptop", "send", { to: "wiki@pc", text: "Обнови оглавление" });
    const f = await replyTo(st, "message", { ok: false, error: "offline" });
    expect(f).toMatchObject({ type: "message", v: 1, from: "site@laptop", to: "wiki@pc", text: "Обнови оглавление" });
    expect(await pending).toEqual(toolText("Не доставлено: wiki@pc не на связи (offline)", true));
    expect(st.relay.frames("message")).toHaveLength(1);
  });

  it.each([
    ["устройству", "phone~owner@example.com"],
    ["человеку, всем его устройствам (3024)", "~owner@example.com"],
  ])("send %s: кадр message без id; пуш запросом push.send с заголовком отправителя", async (_n, to) => {
    // источник: устав — «достают до телефона»; слово пользователя 2 нояб. «пушить всем»; текст ответа — чьё: код
    const { st, call } = await bench({ push: true });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await st.open("site@laptop");
    expect(await call("site@laptop", "send", { to, text: "Готово" })).toEqual(toolText(`отправлено: ${to}`));
    expect(st.relay.frames("message")).toEqual([{ type: "message", v: 1, from: "site@laptop", to, text: "Готово" }]);
    const p = await until(() => st.relay.frames("push.send")[0]);
    expect(p).toMatchObject({ v: 1, to: ".push", push: { to, type: "message", from: "site@laptop", notify: { title: "site@laptop", body: "Готово" } } });
    expect((p.push as { skip?: unknown }).skip).toBeUndefined();
  });

  it("335 · связи с relay нет: сессии — «Доставка не подтверждена», человеку — то же", async () => {
    // источник: устав — соединение оборвалось — клиенты переподключаются; ошибки словами; текст — чьё: код
    const { st, call } = await bench();
    await st.open("site@laptop");
    st.relay.drop();
    await until(() => st.kernel.relay?.state !== "open");
    const no = toolText("Доставка не подтверждена: нет связи с relay (disconnected)", true);
    expect(await call("site@laptop", "send", { to: "wiki@pc", text: "x" })).toEqual(no);
    expect(await call("site@laptop", "send", { to: "~owner@example.com", text: "x" })).toEqual(no);
  });

  it("fleet.answer на вопрос другой машины — запрос answer через relay от отвечающей сессии; модели — «принято»", async () => {
    // источник: устав — AskUserQuestion получает тот, кто дал задачу; первый ответ выигрывает
    const { st, call } = await bench();
    await st.open("site@laptop");
    const pending = call("site@laptop", "answer", { to: "profiles@pc", question: "toolu_01Hq", answers: { "Какую базу мигрировать первой?": "стенд" } });
    const a = await replyTo(st, "answer", { ok: true });
    expect(a).toMatchObject({ type: "answer", v: 1, callsign: "profiles@pc", question: "toolu_01Hq", from: "site@laptop", answers: { "Какую базу мигрировать первой?": "стенд" } });
    expect(text(await pending)).toBe("принято");
  });
});

describe("fleet: сессия ведёт другие сессии", () => {
  it("296 · open дочери на другой машине — session.open от родителя, затем задача message от него; ответ — callsign", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const pending = call("lead@win", "open", { name: "fix-auth", machine: "wsl", dir: "~/app", text: "Почини вход: токен истекает через минуту" });
    const o = await replyTo(st, "session.open", { ok: true, result: { callsign: "fix-auth@wsl", session_id: "s1" } });
    expect(o).toMatchObject({ type: "session.open", v: 1, machine: "wsl", name: "fix-auth", dir: "~/app", from: "lead@win" });
    const m = await replyTo(st, "message", { ok: true });
    expect(m).toMatchObject({ type: "message", v: 1, to: "fix-auth@wsl", text: "Почини вход: токен истекает через минуту", from: "lead@win" });
    expect(text(await pending)).toBe("открыта: fix-auth@wsl; задача во вводе, итог хода придёт сам");
  });

  it("297 · open на своей машине — parent lead@win, не @win; тот же отправитель в журнале флота; задача с подсказкой про итог", async () => {
    const { st, call, home, field } = await bench({ machine: "win" });
    await st.open("lead@win");
    expect(text(await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README", profile: "p", model: "m", effort: "low" }))).toBe("открыта: docs@win; задача во вводе, итог хода придёт сам");
    await until(() => field("docs@win", "parent") === "lead@win");
    expect(st.query("docs@win").options).toMatchObject({ model: "m", effort: "low" });
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.opened")).toMatchObject({ by: "lead@win", callsign: "docs@win" });
    await until(() => st.proc("docs@win").inputs.length === 1);
    // живой прогон 1 нояб.: без подсказки дочь отвечала fleet.send
    expect(st.proc("docs@win").inputs[0].message.content).toBe(task("lead@win", "Обнови README"));
  });

  it("298 · remove другой сессии — убрана из списка и roster; журнал флота от родителя", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "x" });
    expect(text(await call("lead@win", "remove", { callsign: "docs@win" }))).toBe("закрыта: docs@win");
    expect(st.kernel.sessions.has("docs@win")).toBe(false);
    expect(st.relay.sent.filter((f) => f.type === "session.state" && f.callsign === "docs@win").at(-1)).toMatchObject({ state: null });
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.removed")).toMatchObject({ by: "lead@win", callsign: "docs@win" });
  });

  it("299 · remove себя посреди хода — ход не прерван; после его конца сессия убрана", async () => {
    const { st, call } = await bench({ machine: "win" });
    const s = await st.open("lead@win");
    const p = st.proc("lead@win");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    expect(text(await call("lead@win", "remove"))).toBe("закроюсь после этого хода");
    expect(p.interrupts).toBe(0);
    expect(st.kernel.sessions.has("lead@win")).toBe(true);
    p.send(msg.result({ result: "готово" }));
    p.send(msg.state("idle"));
    await until(() => !st.kernel.sessions.has("lead@win"));
    expect(p.interrupts).toBe(0);
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.removed")).toMatchObject({ by: "lead@win", callsign: "lead@win" });
  });

  it("300 · update model у живой дочери — setModel сразу, в roster новое значение; остановленной — «сразу: —», со следующего старта (3027)", async () => {
    const { st, call, home, field, req } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "x" });
    expect(text(await call("lead@win", "update", { callsign: "docs@win", model: "sonnet" }))).toBe("сразу: model");
    expect(st.query("docs@win").calls).toContainEqual({ name: "setModel", args: ["sonnet"] });
    await until(() => field("docs@win", "model") === "sonnet");
    await st.session("host-fleet", "docs@win")!.stop();
    expect(text(await call("lead@win", "update", { callsign: "docs@win", model: "haiku" }))).toBe("сразу: —");
    expect(await req({ type: "session.start", callsign: "docs@win" })).toMatchObject({ ok: true });
    expect(st.query("docs@win").options).toMatchObject({ model: "haiku" });
  });

  it("301 · history другой машины — запрос session.history через relay; ввод, ответы и инструменты строками; система пропущена; по умолчанию 20; пусто — «записей нет»", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const pending = call("lead@win", "history", { callsign: "fix-auth@wsl", limit: 3 });
    const messages = [
      { type: "user", uuid: "u1", message: { role: "user", content: "Добавь тест на logout" } },
      { type: "assistant", uuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "Добавил test/logout.test.ts" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "system", uuid: "u3", subtype: "init" },
    ];
    const h = await replyTo(st, "session.history", { ok: true, result: { messages, more: true } });
    expect(h).toMatchObject({ type: "session.history", v: 1, callsign: "fix-auth@wsl", limit: 3, before: null, from: "lead@win" });
    expect(text(await pending)).toBe("user: Добавь тест на logout\nassistant: Добавил test/logout.test.ts\ntool: Bash");
    const empty = call("lead@win", "history", { callsign: "fix-auth@wsl" });
    expect(await replyTo(st, "session.history", { ok: true, result: { messages: [] } }, 1)).toMatchObject({ limit: 20 });
    expect(text(await empty)).toBe("записей нет");
  });

  it("311 · дочь кончила ход, начатый родителем: родителю message с текстом result; дочь send не звала; отправитель ввода родителя прежний", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    st.session("host-fleet", "lead@win")!.input("Наведи порядок в документации", { from: "phone~owner@example.com" });
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    turn(kid, "работаю", { result: "README обновлён: раздел установки" });
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 2);
    expect(lead.inputs[1]).toMatchObject({ priority: "next", message: { content: wrap("docs@win", "README обновлён: раздел установки") } });
    expect(st.session("host-fleet", "lead@win")!.info.from).toBe("phone~owner@example.com");
  });

  it("313 · Host дочери перезапустился посреди хода: итог — родителю сразу после подключения, без roster", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const home = temp();
    const a = await bench({ machine: "win", holders: k, home });
    await a.st.open("lead@win");
    await a.call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = k.procs.get("docs@win")!;
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => a.st.kernel.sessions.get("docs@win")?.state === "busy");
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await until(() => kid.sock === null);
    kid.send(msg.assistant("работаю"));
    kid.send(msg.result({ result: "README обновлён" }));
    kid.send(msg.state("idle"));
    // relay нового Host ещё не прислал roster: родитель — только от manage этой машины
    await bench({ machine: "win", holders: k, home, stateHome: a.st.home, holdRoster: true });
    const lead = k.procs.get("lead@win")!;
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0]).toMatchObject({ priority: "next", message: { content: wrap("docs@win", "README обновлён") } });
  });

  it("312 · ход дочери начал человек — родителю ничего", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    st.session("host-fleet", "docs@win")!.input("Добавь тест на logout", { from: "phone~owner@example.com" });
    turn(kid, "работаю", { result: "тест добавлен" });
    await later();
    expect(st.proc("lead@win").inputs).toHaveLength(0);
  });

  it("326 · open, history, remove: машины нет на связи — «Не доставлено … (offline)»; после отказа open задача не уходит", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Адресата нет на связи: send, open, history — Отказ offline словом… Повторов нет»
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const o = call("lead@win", "open", { name: "fix-auth", machine: "wsl", dir: "~/app", text: "Почини вход" });
    await replyTo(st, "session.open", { ok: false, error: "offline" });
    expect(await o).toEqual(toolText("Не доставлено: fix-auth@wsl не на связи (offline)", true));
    const h = call("lead@win", "history", { callsign: "fix-auth@wsl" });
    await replyTo(st, "session.history", { ok: false, error: "offline" });
    expect(text(await h)).toBe("Не доставлено: fix-auth@wsl не на связи (offline)");
    const r = call("lead@win", "remove", { callsign: "fix-auth@wsl" });
    await replyTo(st, "session.remove", { ok: false, error: "offline" });
    expect(text(await r)).toBe("Не доставлено: fix-auth@wsl не на связи (offline)");
    expect(st.relay.frames("message")).toHaveLength(0);
  });

  it("327 · open: имя занято — «Не выполнено: docs@win — name_taken» с причиной; задача не уходит, новой сессии нет", async () => {
    // источник: устав — ошибки словами; слово — чьё: код (manage), текст — чьё: код (fleet)
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    await until(() => st.proc("docs@win").inputs.length === 1);
    expect(await call("lead@win", "open", { name: "docs", dir: home, text: "Ещё раз" })).toEqual(toolText("Не выполнено: docs@win — name_taken. session.open: docs@win уже есть", true));
    await later(20);
    expect(st.proc("docs@win").inputs).toHaveLength(1);
    expect([...st.kernel.sessions.keys()].sort()).toEqual(["docs@win", "lead@win"]);
  });

  it("328 · update: усилие не того вида — текст с причиной; SDK дочери не вызван", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "x" });
    expect(await call("lead@win", "update", { callsign: "docs@win", effort: "huge" })).toEqual(toolText('Не выполнено: docs@win — bad_spec. session.update docs@win: effort = "huge"', true));
    expect(st.query("docs@win").calls.filter((c) => c.name === "applyFlagSettings" || c.name === "setModel")).toEqual([]);
  });

  it("329 · дочь закрыла себя в ходе, начатом родителем, — итог у родителя, затем дочь убрана", async () => {
    // источник: принятый дизайн, remove — «без позывного — себя, после конца этого хода: ответ успевает уйти»
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README и закройся" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("docs@win")!.state === "busy");
    expect(text(await call("docs@win", "remove"))).toBe("закроюсь после этого хода");
    kid.send(msg.result({ result: "Готово, закрываюсь" }));
    kid.send(msg.state("idle"));
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0]).toMatchObject({ message: { content: wrap("docs@win", "Готово, закрываюсь") } });
    await until(() => !st.kernel.sessions.has("docs@win"));
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["330 · ошибка без текста — слово сбоя", { subtype: "error_during_execution", is_error: true }, "ход кончился: error_during_execution"],
    ["E14 · успех по типу и признак ошибки — текст ошибки (отчёт 4 нояб.)", { subtype: "success", is_error: true, result: "Not logged in · Please run /login" }, "ход кончился ошибкой: Not logged in · Please run /login"],
    ["успех без текста — пустой итог", { subtype: "success", result: undefined }, ""],
  ])("итог хода родителю: %s", async (_n, result, want) => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    kid.send(msg.result(result));
    kid.send(msg.state("idle"));
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0].message.content).toBe(wrap("docs@win", want));
  });

  it("331 · процесс дочери умер посреди хода — один resume, итога нет: родителю ничего", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("docs@win")!.state === "busy");
    kid.exit(1, "умер");
    await until(() => st.sdk.of("docs@win").length === 2 && st.kernel.sessions.get("docs@win")!.state === "idle");
    await later();
    expect(st.proc("lead@win").inputs).toHaveLength(0);
  });

  it("332 · родителя нет на связи, когда пришёл итог, — строка журнала report с offline на машине дочери, повторов нет", async () => {
    const { st, call, home, req } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    expect(await req({ type: "session.remove", callsign: "lead@win" })).toMatchObject({ ok: true });
    turn(kid, "работаю", { result: "README обновлён" });
    const line = await until(() => st.journal().find((l) => l.ev === "report"));
    expect(line).toMatchObject({ kind: "note", word: "offline", callsign: "docs@win", why: "итог хода родителю lead@win не доставлен: offline" });
    await later();
    expect(st.journal().filter((l) => l.ev === "report")).toHaveLength(1);
  });

  it("333 · родитель отвечает на вопрос дочери: вопрос во вводе родителя; fleet.answer — у модели дочери; answered от родителя; у родителя прежний, кто дал задачу", async () => {
    // источник: принятый дизайн, инструменты модели — «answer — ответ на вопрос дочери»; устав — первый ответ выигрывает
    const { st, call, home } = await bench({ machine: "win", push: true });
    await st.open("lead@win");
    st.session("host-fleet", "lead@win")!.input("Наведи порядок в документации", { from: "phone~owner@example.com" });
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    const asked = kid.ask("AskUserQuestion", { questions: [{ question: "Какой README?" }] }, "toolu_k1");
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ from: "docs@win", to: ["lead@win"], question: "toolu_k1" });
    st.relay.deliver(q);
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 2);
    expect(lead.inputs[1].message.content).toContain('<fleet-question from="docs@win" question="toolu_k1">');
    expect(text(await call("lead@win", "answer", { to: "docs@win", question: "toolu_k1", answers: { "Какой README?": "корневой" } }))).toBe("принято");
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какой README?": "корневой" } } });
    expect(st.relay.frames("answered")).toEqual([expect.objectContaining({ from: "docs@win", question: "toolu_k1", by: "lead@win" })]);
  });

  it("334 · вопрос уже закрыт ответом человека — fleet.answer родителя: текст с already_answered; у модели дочери ответ человека", async () => {
    const { st, call, home, req } = await bench({ machine: "win", push: true });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    const asked = kid.ask("AskUserQuestion", { questions: [{ question: "Какой README?" }] }, "toolu_k2");
    await until(() => st.relay.frames("question")[0]);
    expect(await req({ type: "answer", callsign: "docs@win", question: "toolu_k2", answers: { "Какой README?": "в docs" }, from: "phone~owner@example.com" })).toMatchObject({ ok: true });
    expect(await call("lead@win", "answer", { to: "docs@win", question: "toolu_k2", answers: { "Какой README?": "корневой" } })).toEqual(toolText("Не выполнено: docs@win — already_answered. toolu_k2: на вопрос уже ответили", true));
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какой README?": "в docs" } } });
    expect(st.relay.frames("answered")).toEqual([expect.objectContaining({ question: "toolu_k2", by: "phone~owner@example.com" })]);
  });

  it("3025 · open: сессия открыта, задача не доставлена — текст «открыта: …, но задача не доставлена — offline»", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const o = call("lead@win", "open", { name: "fix", machine: "wsl", dir: "~/app", text: "Почини" });
    await replyTo(st, "session.open", { ok: true, result: { callsign: "fix@wsl", session_id: "s1" } });
    await replyTo(st, "message", { ok: false, error: "offline" });
    expect(await o).toEqual(toolText("открыта: fix@wsl, но задача не доставлена — offline", true));
  });

  it("3026 · history и remove сессии, которой нет на этой машине, — offline текстом; chat и manage живы", async () => {
    // источник: дизайн «Предел чтений и слоты»: запрос о сессии, которой нет, — offline, обработчик не вызван
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    await st.open("docs@win");
    const no = toolText("Не доставлено: nope@win не на связи (offline)", true);
    expect(await call("lead@win", "history", { callsign: "nope@win" })).toEqual(no);
    expect(await call("lead@win", "remove", { callsign: "nope@win" })).toEqual(no);
    st.sdk.functions = { getSessionInfo: async () => ({}), importSessionToStore: async () => {}, getSessionMessages: async () => [{ type: "user", uuid: "u1", message: { content: "привет" } }] };
    expect(text(await call("lead@win", "history", { callsign: "docs@win" }))).toBe("user: привет");
    expect(text(await call("lead@win", "remove", { callsign: "docs@win" }))).toBe("закрыта: docs@win");
  });

  it("list до первого roster — ошибка инструмента со словом disconnected", async () => {
    const { call } = await bench({ machine: "win", holdRoster: true });
    expect(await call("site@win", "list")).toEqual(toolText("Нет связи с relay (disconnected): список сессий неизвестен", true));
  });
});

describe("E13 · слот в инструментах агента", () => {
  const WHY = "Слоты машины: main (ждёт сброса 14:30), bot";
  const OPEN = { name: "job", dir: "~", text: "задача" };
  /** Ответы relay на запросы к другой машине. */
  function serve(st: Stand, answer: (f: Frame) => Record<string, unknown> | undefined) {
    const recv = st.relay.receive.bind(st.relay);
    st.relay.receive = (ws, raw) => {
      recv(ws, raw);
      if (raw === "ping") return;
      const x = JSON.parse(raw) as Frame;
      if (x.type === "hello" || x.type === "reply" || typeof x.id !== "string") return;
      const r = answer(x);
      if (r) queueMicrotask(() => st.relay.deliver({ type: "reply", id: x.id as string, from: "@wsl", ...r } as Frame));
    };
  }
  const opened = (w: World) => w.seen.find((x) => x[0] === "slot")![1];

  it("open без slot: поля нет, слот выбрала машина — он в ответе; слотов нет — в ответе нет", async () => {
    // источник: факт, отчёт об ошибке: у инструмента не было слота; слово пользователя 4 нояб.: один слот — сессия встаёт сама
    const a = await bench({ machine: "win", w: world({ autoSlot: "main" }) });
    expect(await a.call("lead@win", "open", OPEN)).toEqual(toolText("открыта: job@win · слот main; задача во вводе, итог хода придёт сам"));
    expect(opened(a.w)).not.toHaveProperty("slot");
    const b = await bench({ machine: "win" });
    expect(text(await b.call("lead@win", "open", OPEN))).toBe("открыта: job@win; задача во вводе, итог хода придёт сам");
  });

  it("open со slot: имя дошло до открытия", async () => {
    const { call, w } = await bench({ machine: "win" });
    expect(text(await call("lead@win", "open", { ...OPEN, slot: "bot" }))).toBe("открыта: job@win · слот bot; задача во вводе, итог хода придёт сам");
    expect(opened(w)).toMatchObject({ slot: "bot" });
  });

  it("отказ открытия называет слоты: на своей машине и через relay", async () => {
    // источник: слово пользователя 4 нояб.: два слота и больше — отказ со списком; находка архитектора: своя машина теряла why
    const { st, call } = await bench({
      machine: "win",
      w: world({ opening: () => {
        throw refuse("slot_required", WHY);
      } }),
    });
    expect(await call("lead@win", "open", OPEN)).toEqual(toolText(`Не выполнено: job@win — slot_required. ${WHY}`, true));
    serve(st, (f) => (f.type === "session.open" ? { ok: false, error: "slot_required", why: WHY } : undefined));
    expect(await call("lead@win", "open", { ...OPEN, machine: "wsl" })).toEqual(toolText(`Не выполнено: job@wsl — slot_required. ${WHY}`, true));
  });

  it("timeout открытия: исход неизвестен, проверь list", async () => {
    // источник: находка архитектора: сессия могла открыться, повтор получит name_taken
    const { st, call } = await bench({ machine: "win" });
    serve(st, (f) => (f.type === "session.open" ? { ok: false, error: "timeout" } : undefined));
    expect(await call("lead@win", "open", { ...OPEN, machine: "wsl" })).toEqual(toolText("Не выполнено: job@wsl — timeout: исход неизвестен, проверь list", true));
  });

  it("update со slot: перезапуск — текст по ответу модуля; вместе с моделью слот первым", async () => {
    const { st, call, w } = await bench({ machine: "win" });
    await st.open("old@win");
    w.slotReply = () => ({ restart: true });
    expect(await call("lead@win", "update", { callsign: "old@win", slot: "main" })).toEqual(toolText("слот main; перезапуск между ходами"));
    expect(w.seen.filter((x) => x[0] === "session.slot")).toEqual([["session.slot", expect.objectContaining({ callsign: "old@win", slot: "main" })]]);
    w.slotReply = () => ({ restart: false });
    expect(text(await call("lead@win", "update", { callsign: "old@win", slot: "main" }))).toBe("слот main");
    expect(text(await call("lead@win", "update", { callsign: "old@win", slot: "main", model: "haiku" }))).toBe("слот main; сразу: model");
    expect(st.query("old@win").calls).toContainEqual({ name: "setModel", args: ["haiku"] });
  });

  it("update: отказ слота не меняет остального", async () => {
    const { st, call, w } = await bench({ machine: "win" });
    await st.open("old@win");
    w.slotReply = () => {
      throw refuse("no_slot", "Слоты машины: main, bot");
    };
    expect(await call("lead@win", "update", { callsign: "old@win", slot: "night", model: "haiku", project: "сайт" })).toEqual(toolText("Не выполнено: old@win — no_slot. Слоты машины: main, bot", true));
    expect(st.query("old@win").calls).toEqual([]);
    expect(st.relay.frames("prefs.set")).toEqual([]);
  });
});

describe("fleet: проекты и имена", () => {
  /** Подделка Worker'а prefs: отвечает на кадры области флота; down — слово отказа вместо ответа. */
  function prefs(st: Stand) {
    const svc = { values: {} as Record<string, unknown>, down: "" as string, scopes: new Set<unknown>() };
    const seen = new Set<unknown>();
    timers.push(
      setInterval(() => {
        for (const f of [...st.relay.frames("prefs.get"), ...st.relay.frames("prefs.set")] as Frame[]) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          svc.scopes.add(f.scope);
          if (svc.down) st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: false, error: svc.down } as Frame);
          else if (f.type === "prefs.get") st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: true, result: { values: JSON.parse(JSON.stringify(svc.values)) } } as Frame);
          else {
            svc.values[f.name as string] = f.value;
            st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: true } as Frame);
          }
        }
      }, 2),
    );
    return svc;
  }
  async function meta() {
    const b = await bench({ machine: "win" });
    mkdirSync(join(b.home, "p"));
    const roster = (sessions: object[], clients: string[] = []) => b.st.relay.deliver({ type: "roster", machines: [{ machine: "win", since: 1, proto: 1, contract: {} }], sessions, clients } as Frame);
    return { ...b, svc: prefs(b.st), roster };
  }
  const REC = [{ id: "shop", name: "Магазин", sessions: ["site@win"] }];
  const SESSIONS = [{ callsign: "site@win", state: "busy", model: "m", cost: 1 }, { callsign: "kid@win", state: "idle", parent: "site@win" }, { callsign: "free@win", state: "idle", parent: "pult~a@b.c" }];

  it("302 · 6301 · list: сессии с состоянием, родителем, моделью, именем и проектом; дочерняя — в проекте родителя; машины с именами; проекты; клиенты; область — только флот", async () => {
    const { svc, call, roster } = await meta();
    svc.values["fleet.projects"] = REC;
    svc.values["fleet.labels"] = { sessions: { "site@win": "Витрина" }, machines: { win: "Домашний ПК" } };
    roster(SESSIONS, ["phone~owner@example.com"]);
    await later(10);
    const r = JSON.parse(text(await call("site@win", "list")));
    expect(r).toEqual({
      me: "site@win",
      sessions: [
        { callsign: "site@win", state: "busy", parent: null, model: "m", label: "Витрина", project: "Магазин" },
        { callsign: "kid@win", state: "idle", parent: "site@win", model: null, label: null, project: "Магазин" },
        { callsign: "free@win", state: "idle", parent: "pult~a@b.c", model: null, label: null, project: null },
      ],
      machines: [{ machine: "win", label: "Домашний ПК" }],
      projects: ["Магазин"],
      clients: ["phone~owner@example.com"],
    });
    expect([...svc.scopes]).toEqual(["global"]);
  });

  it("6302 · list: служба настроек не отвечает — сессии приходят, вместо меток слово причины", async () => {
    const { svc, call, roster } = await meta();
    svc.down = "gate_unavailable";
    roster(SESSIONS);
    await later(10);
    const t = await call("site@win", "list");
    expect(t.isError).toBeUndefined();
    const r = JSON.parse(text(t));
    expect(r.sessions).toHaveLength(3);
    expect(r.meta).toBe("имена и проекты недоступны: gate_unavailable");
    expect(r.projects).toEqual([]);
  });

  it("6303 · update project: сессия в конце проекта и ровно в одном месте; нет такого имени — создаётся; пусто — без проекта; службе не записать — слово", async () => {
    const { svc, call } = await meta();
    svc.values["fleet.projects"] = [...REC, { id: "sec", name: "Безопасность", sessions: ["other@win"] }];
    expect(text(await call("me@win", "update", { callsign: "site@win", project: "безопасность" }))).toBe("проект site@win: безопасность");
    expect(svc.values["fleet.projects"]).toEqual([{ id: "shop", name: "Магазин", sessions: [] }, { id: "sec", name: "Безопасность", sessions: ["other@win", "site@win"] }]);
    await call("me@win", "update", { callsign: "site@win", project: "Новый" });
    expect((svc.values["fleet.projects"] as Array<{ id: string; name: string; sessions: string[] }>).at(-1)).toMatchObject({ name: "Новый", sessions: ["site@win"] });
    expect(text(await call("me@win", "update", { callsign: "site@win", project: "" }))).toBe("site@win: без проекта");
    expect((svc.values["fleet.projects"] as Array<{ id: string; sessions: string[] }>).find((r) => r.id === "~")?.sessions).toEqual(["site@win"]);
    expect((svc.values["fleet.projects"] as Array<{ sessions: string[] }>).flatMap((r) => r.sessions).filter((c) => c === "site@win")).toHaveLength(1);
    svc.down = "gate_unavailable";
    expect(await call("me@win", "update", { callsign: "site@win", project: "Магазин" })).toEqual(toolText("Не выполнено: проект site@win — gate_unavailable", true));
  });

  it("update project вместе со слотом и моделью: все части в ответе одним текстом; отказ проекта называет сделанный слот", async () => {
    const { st, svc, call } = await meta();
    svc.values["fleet.projects"] = REC;
    await st.open("old@win");
    expect(text(await call("me@win", "update", { callsign: "old@win", slot: "main", project: "Магазин" }))).toBe("слот main; проект old@win: Магазин");
    expect(text(await call("me@win", "update", { callsign: "old@win", project: "Магазин", model: "m" }))).toBe("проект old@win: Магазин; сразу: model");
    svc.down = "gate_unavailable";
    expect(await call("me@win", "update", { callsign: "old@win", slot: "main", project: "Магазин" })).toEqual(toolText("слот main; Не выполнено: проект old@win — gate_unavailable", true));
  });

  it("6304 · label: имя сессии и машины ставится и снимается, текст ответа; чужой адрес — отказ; службе не записать — слово", async () => {
    const { svc, call } = await meta();
    expect(text(await call("me@win", "label", { to: "site@win", text: "Витрина" }))).toBe("имя site@win: Витрина");
    expect(text(await call("me@win", "label", { to: "@win", text: "Домашний ПК" }))).toBe("имя @win: Домашний ПК");
    expect(svc.values["fleet.labels"]).toEqual({ sessions: { "site@win": "Витрина" }, machines: { win: "Домашний ПК" } });
    expect(text(await call("me@win", "label", { to: "@win", text: "" }))).toBe("имя @win снято");
    expect(svc.values["fleet.labels"]).toEqual({ sessions: { "site@win": "Витрина" }, machines: {} });
    expect(await call("me@win", "label", { to: "~a@b.c", text: "x" })).toEqual(toolText("Не выполнено: ~a@b.c — не сессия и не машина", true));
    svc.down = "gate_unavailable";
    expect(await call("me@win", "label", { to: "@win", text: "x" })).toEqual(toolText("Не выполнено: имя @win — gate_unavailable", true));
  });

  it("6305 · open с проектом: сессия в проекте, задача во вводе; проект не записался — открыта и слово в ответе; без проекта запись не меняется", async () => {
    const { st, svc, call } = await meta();
    svc.values["fleet.projects"] = REC;
    await call("site@win", "open", { name: "a", dir: "~/p", text: "задача", project: "Магазин" });
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions).toEqual(["site@win", "a@win"]);
    const before = JSON.stringify(svc.values["fleet.projects"]);
    await call("site@win", "open", { name: "b", dir: "~/p", text: "задача" });
    expect(JSON.stringify(svc.values["fleet.projects"])).toBe(before);
    svc.down = "gate_unavailable";
    expect(text(await call("site@win", "open", { name: "c", dir: "~/p", text: "задача", project: "Магазин" }))).toBe("открыта: c@win; задача во вводе, итог хода придёт сам; проект не записан: gate_unavailable");
    expect(st.session("host-fleet", "c@win")).toBeTruthy();
  });

  it("6306 · две сессии одной машины ставят проект одновременно: обе правки на месте; остановка Host ждёт записи", async () => {
    const { svc, call, st } = await meta();
    svc.values["fleet.projects"] = REC;
    await Promise.all([call("a@win", "update", { callsign: "a@win", project: "Магазин" }), call("b@win", "update", { callsign: "b@win", project: "Магазин" })]);
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions.sort()).toEqual(["a@win", "b@win", "site@win"]);
    const pending = call("c@win", "update", { callsign: "c@win", project: "Магазин" });
    await st.close();
    await pending;
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions).toContain("c@win");
  });
});

describe("remote: Remote Control у каждой сессии", () => {
  const proto = stand.FakeQuery.prototype as unknown as Record<string, unknown>;
  const original = proto.enableRemoteControl;
  /** Ответ поддельного query на enableRemoteControl: n — номер вызова. */
  let rc: (n: number) => unknown;
  let rcCalls = 0;
  beforeEach(() => {
    rcCalls = 0;
    rc = (n) => ({ session_url: `https://claude.ai/code/session_0${n}Jai`, bridge_session_id: `session_0${n}Jai` });
    proto.enableRemoteControl = async function (this: stand.FakeQuery, ...args: unknown[]) {
      this.calls.push({ name: "enableRemoteControl", args });
      return rc(++rcCalls);
    };
  });
  afterEach(() => {
    proto.enableRemoteControl = original;
  });

  type RW = { who: { main: string }; claudeDir: string };
  async function make(o: { machine?: string; holders?: stand.FakeHolders; stateHome?: string; rw?: RW; broken?: () => boolean } = {}) {
    const rw = o.rw ?? { who: { main: "infirex" }, claudeDir: temp("switchboard-claude-") };
    const w = world({
      account: () => {
        if (o.broken?.()) throw new Error("slots упал");
        return rw.who.main;
      },
    });
    const b = await bench({ machine: o.machine, holders: o.holders, stateHome: o.stateHome, remote: rw.claudeDir, w });
    return { st: b.st, rw };
  }
  /** Файл разговора, как его ведёт claude: строки разговора и привязка к сессии claude.ai. */
  function transcript(rw: RW, sid: string, bridge: string): string {
    const d = join(rw.claudeDir, "projects", "D--Projects-site");
    mkdirSync(d, { recursive: true });
    const f = join(d, `${sid}.jsonl`);
    writeFileSync(
      f,
      [
        { type: "user", message: { role: "user", content: "привет" }, sessionId: sid },
        { type: "bridge-session", sessionId: sid, bridgeSessionId: bridge, lastSequenceNum: 4, ownerAccountUuid: "acc-infirex" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "APPLE" }] }, sessionId: sid },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    return f;
  }
  /** Последняя запись привязки в файле — так её прочитает claude. */
  function lastBridge(f: string) {
    return readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; bridgeSessionId?: string }).filter((x) => x.type === "bridge-session").at(-1);
  }
  const rcOf = (st: Stand, cs: string) => st.query(cs).calls.filter((c) => c.name === "enableRemoteControl");
  const rec = (st: Stand, cs: string) => st.session("host-remote", cs)!.store<Record<string, unknown>>().get();
  const field = (st: Stand, cs: string) => st.kernel.sessions.get(cs)!.record().remote;
  const unbinds = (st: Stand) => st.journal().filter((l) => l.ev === "unbind");
  const failedRemote = (st: Stand) => st.journal().some((l) => l.ev === "module_failed" && l.module === "host-remote");

  it("230 · новая сессия: один enableRemoteControl(true) без имени; в roster url; в разделе bridge и аккаунт; журнал; привязку не снимает", async () => {
    const { st } = await make();
    await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    expect(rcOf(st, "site@laptop")).toEqual([{ name: "enableRemoteControl", args: [true] }]);
    expect(field(st, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai" });
    expect(rec(st, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai", bridge: "session_01Jai", account: "infirex" });
    expect(st.journal().find((l) => l.ev === "remote")?.why).toBe("Remote Control включён: https://claude.ai/code/session_01Jai · infirex");
    expect(unbinds(st)).toEqual([]);
  });

  it("вне слотов: аккаунта нет — журнал «вход машины»", async () => {
    const { st, rw } = await make();
    rw.who.main = undefined as never;
    await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    expect(rec(st, "site@laptop")).toMatchObject({ account: null });
    expect(st.journal().find((l) => l.ev === "remote")?.why).toBe("Remote Control включён: https://claude.ai/code/session_01Jai · вход машины");
  });

  it("231 · процесс упал, resume, в слоте тот же: файл байт в байт прежний, после initialize — включение", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    const before = readFileSync(f);
    st.proc("site@laptop").exit(1, "упал");
    await until(() => st.sdk.of("site@laptop").length === 2 && rcOf(st, "site@laptop").length === 1);
    expect(readFileSync(f)).toEqual(before);
    expect(rcOf(st, "site@laptop")).toEqual([{ name: "enableRemoteControl", args: [true] }]);
  });

  it("232 · закрыт ради resume, в слоте другой аккаунт: до query() — снятие привязки, затем включение; аккаунт новый; строка журнала (3071)", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    rw.who.main = "y0902";
    await s.restart();
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "", lastSequenceNum: 0 });
    expect(lines).toHaveLength(4);
    await until(() => rcOf(st, "site@laptop").length === 1 && rec(st, "site@laptop")?.account === "y0902");
    expect(unbinds(st).map((l) => l.why)).toEqual(["привязка снята: infirex → y0902 · session_01Jai"]);
  });

  it("233 · подмена при живом процессе, Host перезапущен — attach: файл не тронут, включение, url прежний, аккаунт прежний", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const { st, rw } = await make({ holders: k });
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    const before = readFileSync(f);
    rw.who.main = "y0902";
    st.crash();
    rc = () => ({ session_url: "https://claude.ai/code/session_01Jai", bridge_session_id: "session_01Jai" });
    const { st: st2 } = await make({ holders: k, stateHome: st.home, rw });
    await until(() => rcOf(st2, "site@laptop").length === 1 && st2.journal().some((l) => l.ev === "remote" && l.callsign === "site@laptop"));
    expect(st2.session("host-remote", "site@laptop")!.info.start).toBe("attach");
    expect(readFileSync(f)).toEqual(before);
    expect(rec(st2, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai", bridge: "session_01Jai", account: "infirex" });
  });

  it("234 · раздела нет, файл пришёл с другой машины с привязкой; старт из точки: снятие, включение, новый bridge", async () => {
    const { st, rw } = await make({ machine: "pc" });
    const s = await st.open("site@pc");
    await until(() => rec(st, "site@pc"));
    await s.stop();
    st.session("host-remote", "site@pc")!.store().set(undefined);
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    await s.start({ point: 318 });
    expect(lastBridge(f)).toEqual({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "", lastSequenceNum: 0 });
    await until(() => rec(st, "site@pc")?.bridge === "session_02Jai");
    expect(rec(st, "site@pc")).toMatchObject({ account: "infirex" });
  });

  it("235 · claude отказал во включении: по одному вызову на старт, remote { error }, строка stop; повторов нет", async () => {
    rc = () => {
      throw new Error("Remote Control requires a claude.ai subscription");
    };
    const { st } = await make();
    const s = await st.open("site@laptop");
    await until(() => st.journal().some((l) => l.ev === "remote" && l.kind === "stop"));
    expect(field(st, "site@laptop")).toEqual({ error: "Remote Control requires a claude.ai subscription" });
    await s.restart();
    await until(() => st.journal().filter((l) => l.ev === "remote" && l.kind === "stop").length === 2);
    await later();
    expect(rcCalls).toBe(2);
    expect(st.journal().filter((l) => l.kind === "stop" && l.ev === "remote").map((l) => l.why)).toEqual(["Remote Control requires a claude.ai subscription", "Remote Control requires a claude.ai subscription"]);
  });

  it("отказ, затем успешный старт: remote снова { url }", async () => {
    rc = (n) => {
      if (n === 1) throw new Error("нет подписки");
      return { session_url: "https://claude.ai/code/x", bridge_session_id: "x" };
    };
    const { st } = await make();
    const s = await st.open("site@laptop");
    await until(() => (field(st, "site@laptop") as { error?: string } | undefined)?.error);
    await s.restart();
    await until(() => (field(st, "site@laptop") as { url?: string } | undefined)?.url === "https://claude.ai/code/x");
  });

  it.skipIf(process.platform === "linux" && process.getuid?.() === 0)("236 · файл только на чтение, снять нужно: ошибка модуля — failed в roster, включения нет, остальные модули работают", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    rw.who.main = "y0902";
    chmodSync(f, 0o444);
    try {
      st.proc("site@laptop").exit(1, "упал");
      await until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
      expect(Object.keys(st.kernel.sessions.get("site@laptop")!.record().failed as object)).toEqual(["host-remote"]);
      expect(rcOf(st, "site@laptop")).toEqual([]);
      const before = st.proc("site@laptop").inputs.length;
      st.session("host-fleet", "site@laptop")!.input("ещё");
      await until(() => st.proc("site@laptop").inputs.length === before + 1);
    } finally {
      chmodSync(f, 0o644);
    }
  });

  it("239 · откат: файл из точки, start — point: снятие «старт из точки», новый bridge; второй прогон тем же аккаунтом по resume — файл прежний", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    await s.stop();
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    await s.start({ point: 300 });
    expect(lastBridge(f)?.bridgeSessionId).toBe("");
    expect(unbinds(st).map((l) => l.why)).toEqual(["привязка снята: старт из точки · session_01Jai"]);
    await until(() => rec(st, "site@laptop")?.bridge === "session_02Jai");
    expect(rec(st, "site@laptop")).toMatchObject({ account: "infirex" });
    // claude завёл новую сессию claude.ai и записал привязку
    appendFileSync(f, JSON.stringify({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "session_02Jai", lastSequenceNum: 0 }) + "\n");
    const before = readFileSync(f);
    st.proc("site@laptop").exit(1, "упал");
    await until(() => st.sdk.of("site@laptop").length === 3 && rec(st, "site@laptop")?.bridge === "session_03Jai");
    expect(st.session("host-remote", "site@laptop")!.info.start).toBe("resume");
    expect(readFileSync(f)).toEqual(before);
  });

  it("resume без привязки в файле и без файла — снимать нечего; записи нет, а привязка есть — снять; недописанная строка — не запись", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    st.proc("site@laptop").exit(1);
    await until(() => st.sdk.of("site@laptop").length === 2 && rcOf(st, "site@laptop").length === 1);
    expect(unbinds(st)).toEqual([]);
    st.session("host-remote", "site@laptop")!.store().set(undefined);
    const f = transcript(rw, s.info.session_id, "session_02Jai");
    appendFileSync(f, '{"type":"bridge-session","sessionId');
    st.proc("site@laptop").exit(1);
    await until(() => st.sdk.of("site@laptop").length === 3);
    expect(unbinds(st).at(-1)?.why).toBe("привязка снята: записи нет · session_02Jai");
  });

  it.each([
    ["3068 · при открытии", false],
    ["3070 · процесс закрыт и поднят", true],
  ])("slots выключен: %s — мост всё равно включён, remote жив", async (_n, later_) => {
    // источник: host/core/contract.ts «отказ словом … не ошибка модуля»; находка бэклога (module_failed host-remote)
    let broken = !later_;
    const { st } = await make({ broken: () => broken });
    const s = await st.open("site@laptop");
    await until(() => rcOf(st, "site@laptop").length === 1 || failedRemote(st));
    if (later_) {
      await until(() => rec(st, "site@laptop"));
      broken = true;
      await s.stop();
      await s.start();
      await later(20);
    }
    expect(failedRemote(st)).toBe(false);
    expect(rcOf(st, "site@laptop")).toHaveLength(1);
    expect(st.states("site@laptop").at(-1)?.failed?.["host-remote"]).toBeUndefined();
  });

  it("3069 · остановка Host, пока сессия идёт в idle: не ошибка модуля", async () => {
    // источник: факт (журнал wsl 1 нояб.: module_failed host-remote «machine.slots: shutting_down»)
    const { st } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    const done = st.kernel.shutdown("тест");
    p.send(msg.result());
    p.send(msg.state("idle"));
    await done;
    await later(20);
    expect(failedRemote(st)).toBe(false);
  });

  it("3072 · перезапуск Host без живого процесса — первое решение о привязке по нынешнему слоту", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop")?.account === "infirex");
    const f = transcript(rw, s.info.session_id, "session_01Jai");
    await st.close();
    stands.splice(stands.indexOf(st), 1);
    rw.who.main = "y0902";
    const { st: st2 } = await make({ stateHome: st.home, rw });
    await until(() => st2.kernel.sessions.get("site@laptop")?.state === "idle");
    expect(lastBridge(f)?.bridgeSessionId).toBe("");
    expect(unbinds(st2).map((l) => l.why)).toEqual(["привязка снята: infirex → y0902 · session_01Jai"]);
  });
});
