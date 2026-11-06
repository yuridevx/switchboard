// Леса границы «как сессией управляют на машине», кроме шеллов: manage, fleet, remote, machine.
// Снаружи — SDK, держатели, relay и часы стенда, вход и профиль (поддельные), служба настроек (поддельная). Настоящие соседи: chat и push.
// Только входы контракта и наблюдаемый исход: ответ со словом и причиной, кадр, query(), поле roster, текст инструмента, файл, журнал.
// Номер — эталон-источник; свойства без пометки — чьё: код.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import managePkg, { make as makeManage } from "../contract.ts";
import fleetPkg, { make as makeFleet, prompt } from "../../fleet/contract.ts";
import { make as makeProfiles } from "../../profiles/contract.ts";
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
async function bench(o: { machine?: string; stateHome?: string; home?: string; holders?: stand.FakeHolders; holdRoster?: boolean; remote?: string; push?: boolean; w?: World; start?: boolean; profiles?: boolean } = {}) {
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
      requests: {
        "session.slot": (r) => (w.seen.push(["session.slot", r]), w.slotReply() as never),
        "machine.accounts": () => ({ accounts: {}, slots: { main: { account: "a@x", order: ["a@x"], wait: null } } }),
      },
    },
    { provides: { "session.slot": 2, slot: 1, account: 2, "machine.accounts": 2 } },
  );
  const profiles = o.profiles
    ? { manifest: manifestOf("profiles"), module: makeProfiles({ git: async () => ({ code: 0, out: "" }) }) }
    : module(
        "host-profiles",
        {
          opening: (_s, f) => {
            w.seen.push(["profile", f]);
            w.opening(f);
          },
          requests: {
            "session.profile": () => ({ restart: false }),
            "machine.profiles": () => ({ profiles: { "team/p/ops": { kind: "piece", about: "серверы", names: [] } }, repos: { "team/p": { state: "ok", dir: "/x/team__p" } } }),
            "profile.view": (r) => ({ pieces: r.profile }),
          },
        },
        { provides: { "session.profile": 2, "machine.profiles": 2, "profile.view": 1, profile: 2 } },
      );
  const relay = new FakeRelay();
  relay.holdRoster = !!o.holdRoster;
  const st = await standHost({
    machine: o.machine,
    home: o.stateHome,
    holders: o.holders,
    start: o.start,
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
  it("текст для модели: системный промпт и инструменты слово в слово — их читает модель", () => {
    expect(prompt("me@pc")).toBe(
      'Ты во флоте как me@pc. Кто на связи — fleet.list; написать сессии или человеку — fleet.send. ' +
        'Открыть сессию с задачей — fleet.open: она твоя дочь, итог каждого её хода, начатого тобой, придёт сам тегом <fleet-message from="…">. ' +
        "Проект сессии — параметр project у fleet.open и fleet.update, имя в интерфейсе — fleet.label. Профиль — параметр profile там же; что в нём, какие кусочки, слоты и ключи есть — fleet.profile; репозитории кусочков — fleet.repos. Что делала сессия — fleet.history; модель, усилие, заголовок — fleet.update; закрыть — fleet.remove (без callsign — себя, после этого хода). " +
        'Сообщения флота приходят во ввод тегом <fleet-message from="…">; вопрос другой сессии — тегом <fleet-question>, ответ на него — fleet.answer. ' +
        "Если тебя открыла другая сессия, итог твоего хода, начатого ею, уйдёт ей сам — отвечать ей отдельно не нужно. " +
          'Человек из Telegram приходит тегом с from="telegram~почта" или, из группы, from="имя~почта" и автором в начале текста; ответ — fleet.send на этот адрес, твой обычный ответ он не увидит. ' +
          "Спрашивая людей в Telegram, задавай в AskUserQuestion один вопрос с вариантами: другие вопросы там не ответить. " +
          "Привязать чат: keys.invite с именем telegram для лички или другим именем для группы, приглашение человек отправляет боту, в группе — /start@бот <приглашение>.",
    );
    const tools = makeFleet().tools("me@pc") as Array<{ name: string; description: string; inputSchema: Record<string, { description?: string }> }>;
    const params = (t: (typeof tools)[number]) => Object.fromEntries(Object.entries(t.inputSchema).map(([k, v]) => [k, v.description ?? null]));
    expect(tools.map((t) => [t.name, t.description, params(t)])).toEqual([
      ["list", "Кто на связи: сессии флота с состоянием, родителем, моделью, профилем, слотом, именем и проектом; машины с именами; проекты; клиенты (телефон, пульт).", {}],
      ["send", "Написать сессии флота (callsign имя@машина) или человеку: всем его устройствам ~email или одному устройство~email, в том числе чату Telegram: telegram~email — личка, имя~email — группа. Текст в Markdown. Ответа адресата не ждёт.", { to: "callsign сессии, ~email человека или устройство~email", text: "текст сообщения" }],
      ["answer", "Ответить на вопрос другой сессии (тег <fleet-question>), которой эта сессия дала задачу.", { to: "callsign сессии, задавшей вопрос", question: "id вопроса из тега", answers: "текст вопроса → ответ; несколько вариантов — через запятую" }],
      [
        "open",
        "Открыть сессию с задачей на любой машине флота. Она твоя дочь: итог каждого её хода, начатого тобой, придёт сам. Без параметра slot: на машине один слот — он, слотов нет — отказ (войдите в аккаунт на машине), два и больше — отказ со списком слотов. wing — открыть пару: вторую сессию на той же машине и в той же папке, задачу ей ставит только эта сессия.",
        {
          name: "имя сессии: буквы, цифры, . _ -",
          dir: "папка: от ~ или полный путь",
          text: "задача — первое сообщение сессии",
          machine: "машина; по умолчанию — твоя",
          profile: "кусочки профиля сессии по порядку: нижний выигрывает",
          model: null,
          effort: null,
          slot: "имя слота машины или ключа флота",
          project: "имя проекта: сессия встанет в его конец, нет такого — создастся; без него — в проект открывшей",
          wing: "настройки ведомого: профиль, модель, усилие, слот",
        },
      ],
      ["history", "Что делала сессия: последние записи разговора — ввод, ответы, вызванные инструменты.", { callsign: null, limit: "сколько записей; по умолчанию 20" }],
      [
        "update",
        "Сменить сессии слот, профиль, модель, усилие, заголовок разговора или проект. Живой сессии модель и усилие — сразу, слот и профиль — перезапуском между ходами, разговор продолжается. Слот меняется первым, профиль вторым: отказ не меняет остального. wing — настройки ведомого этой сессии: нет его — откроет; null — снимет.",
        { callsign: null, slot: "имя слота машины этой сессии или ключа флота", profile: "заменить список кусочков: нижний выигрывает, пустой — без кусочков", model: null, effort: null, title: null, project: "имя проекта: конец его списка, нет такого — создастся; пустая строка — без проекта", wing: "настройки ведомого: профиль, модель, усилие, слот; null — снять ведомого" },
      ],
      [
        "profile",
        "Что получит сессия с этим списком кусочков — тот же ответ, что на экране профилей. Без списка — кусочки и наборы машины, её слоты, ключи флота с моделями и клоны репозиториев. Новый кусочек пишется файлами в клоне: отправит сведение.",
        { machine: "машина; по умолчанию — твоя", profile: "кусочки по порядку" },
      ],
      [
        "repos",
        "Подключить и убрать репозитории кусочков: один список на весь флот. Машины сами клонируют, сводят и убирают клоны. Без параметров — нынешний список.",
        { add: "подключить: владелец/имя", remove: "убрать: владелец/имя" },
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
    const r = await req({ type: "session.open", v: 2, machine: "laptop", name: "board", dir, profile: "team/profiles/ops", slot: "main" });
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
    const r = await req({ type: "session.open", v: 2, machine: "laptop", name: "board", dir: "~/Projects/switchboard" });
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
    ["папка не строка", { name: "x", dir: 1 }, "bad_dir", "session.open x@laptop: папка 1 не от ~ и не полная"],
    ["папки нет", { name: "x", dir: "~/нет" }, "bad_dir", "session.open x@laptop: папки ~/нет нет"],
    ["mkdir не флаг", { name: "x", dir: "~/p", mkdir: "да" }, "bad_spec", "session.open x@laptop: mkdir"],
    ["усилие не того вида", { name: "x", dir: "~/p", effort: "ultra" }, "bad_spec", 'session.open x: effort = "ultra"'],
    ["модель пустая", { name: "x", dir: "~/p", model: "" }, "bad_spec", 'session.open x: model = ""'],
    ["fast не флаг", { name: "x", dir: "~/p", fast: 1 }, "bad_spec", "session.open x: fast = 1"],
    ["resume не строка", { name: "x", dir: "~/p", resume: 1 }, "bad_spec", "session.open x@laptop: resume"],
    ["fork не флаг", { name: "x", dir: "~/p", fork: "да" }, "bad_spec", "session.open x@laptop: fork"],
    ["point не число", { name: "x", dir: "~/p", point: "3" }, "bad_spec", "session.open x@laptop: point"],
    ["имя занято", { name: "site", dir: "~/p" }, "name_taken", "session.open: site@laptop уже есть"],
  ])("вход отклонён, сессии нет: %s", async (_n, f, word, why) => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    await st.open("site@laptop");
    expect(await req({ type: "session.open", v: 2, machine: "laptop", ...f })).toMatchObject({ ok: false, error: word, why });
    expect([...st.kernel.sessions.keys()]).toEqual(["site@laptop"]);
    expect(st.journal().find((l) => l.ev === "request" && l.word === word)?.why).toContain(why);
  });

  it("незнакомое поле — не ошибка; модель и флаги — в query() и разделе; повторный старт без заголовка (3034)", async () => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "site", dir: "~/p", color: "red", model: "m", effort: "high", fast: true, style: "s", thinking: true })).toMatchObject({ ok: true });
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

  it("6203 · 6204 · mkdir строит весь путь; без просьбы папки нет; занятое и неверное имя пути не создают; на месте файл — bad_dir, модуль жив; существующая папка и полный путь — как есть (3118)", async () => {
    const { st, home, req } = await bench();
    await st.open("site@laptop");
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "a", dir: "~/new/deep/path" })).toMatchObject({ ok: false, error: "bad_dir" });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "site", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: false, error: "name_taken" });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "a b", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: false, error: "bad_name" });
    expect(existsSync(join(home, "new"))).toBe(false);
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "a", dir: "~/new/deep/path", mkdir: true })).toMatchObject({ ok: true, result: { callsign: "a@laptop" } });
    expect(st.query("a@laptop").options.cwd).toBe(join(home, "new", "deep", "path"));
    writeFileSync(join(home, "file"), "x");
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "b", dir: "~/file/sub", mkdir: true })).toMatchObject({ ok: false, error: "bad_dir" });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "b", dir: "~/new", mkdir: true })).toMatchObject({ ok: true });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "y", dir: join(home, "new") })).toMatchObject({ ok: true });
    expect(st.query("y@laptop").options.cwd).toBe(join(home, "new"));
  });

  it("процесс вышел до initialize — open_failed, повтора нет; запись остаётся у ядра, журнал флота не пишется, имя занято", async () => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    st.holders.failInitNext = 1;
    const pr = req({ type: "session.open", v: 2, machine: "laptop", name: "x", dir: "~/p" });
    await until(() => st.holders.procs.get("x@laptop"));
    st.proc("x@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed", why: expect.stringMatching(/^x@laptop: /) });
    expect(st.journal().some((l) => l.ev === "request" && l.word === "open_failed" && String(l.why).includes("x@laptop"))).toBe(true);
    expect(st.kernel.sessions.has("x@laptop")).toBe(true);
    expect(st.relay.frames("ledger.add").filter((f) => f.ev === "session.opened")).toHaveLength(0);
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "x", dir: "~/p" })).toMatchObject({ ok: false, error: "name_taken" });
  });

  it("320 · отказ владельца при открытии (нет профиля): слово и причина наружу, сессии, процесса и новой папки нет; без профиля имя свободно", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Нет папки или профиля типа — … no_profile, причина в журнале; сессии нет»; имя свободно — чьё: код
    const w = world({ opening: (f) => {
      if (f.profile) throw refuse("no_profile", `нет профиля ${String(f.profile)}`);
    } });
    const { st, req } = await bench({ w });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "board", dir: "~", profile: "you/profiles/missing" })).toMatchObject({ ok: false, error: "no_profile", why: "нет профиля you/profiles/missing" });
    expect(st.journal().some((l) => l.ev === "request" && l.word === "no_profile")).toBe(true);
    expect(st.kernel.sessions.has("board@laptop")).toBe(false);
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop", slot: null } });
  });

  it("number: первый свободный номер; два сразу — разные; убранный номер снова свободен; заголовок с номером", async () => {
    const { st, home, req } = await bench();
    const dir = join(home, "ops");
    mkdirSync(dir);
    const open = () => req({ type: "session.open", v: 2, machine: "laptop", name: "disk-full", number: true, dir });
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
    const r = await req({ type: "session.open", v: 2, machine: "laptop", name: "r", dir: "~", resume: sid });
    expect(r).toMatchObject({ ok: true, result: { callsign: "r@laptop", session_id: sid } });
    expect(st.session("host-manage", "r@laptop")!.info.start).toBe("resume");
    expect(st.query("r@laptop").options.resume).toBe(sid);
    const f = await req({ type: "session.open", v: 2, machine: "laptop", name: "f", dir: "~", resume: sid, fork: true });
    expect((f.result as { session_id: string }).session_id).not.toBe(sid);
    expect(st.query("f@laptop").options).toMatchObject({ resume: sid, forkSession: true });
  });

  it("321 · журнал флота не отвечает: open и remove исполнены, заметка ledger.add offline в журнале Host", async () => {
    // источник: устав — прямой запрос к Worker'у не прошёл — отказ словом; заметка без очереди — чьё: код (клиент флота onLost)
    const { st, req } = await bench();
    st.relay.workersDown = true;
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop" } });
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
  it("84 · 7000 · все открытые методы: аргументы и ответ SDK как есть; без args — без аргументов; список закреплён — вне его unknown_method, не вызван, процесс жив", async () => {
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
    let args: unknown[] | undefined;
    q.supportedModels = async (...a: unknown[]) => ((args = a), ["m"]);
    await req({ type: "session.call", callsign: "site@laptop", method: "supportedModels" });
    expect(args).toEqual([]);
    for (const method of ["setModel", "applyFlagSettings", "renameSession", "enableRemoteControl", 7]) expect(await req({ type: "session.call", callsign: "site@laptop", method }), String(method)).toMatchObject({ ok: false, error: "unknown_method" });
    expect(await req({ type: "session.call", callsign: "site@laptop", method: "close" })).toMatchObject({ ok: false, error: "unknown_method", why: "session.call site@laptop: close — нет в списке открытых" });
    expect(st.query("site@laptop").calls.map((c) => c.name)).not.toContain("close");
    expect(st.proc("site@laptop").alive).toBe(true);
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

  it("7120 · 7203 · новая сессия — bypassPermissions (режим устава); поле roster mode — режим из кадров SDK status и init", async () => {
    // источник: цель пользователя 4 нояб. «чат со всеми фичами»; устав «Режим „разрешено всё“»; настоящий процесс: кадр status и init несут permissionMode
    const { st } = await bench();
    await st.open("site@laptop");
    expect(st.query("site@laptop").options.permissionMode).toBe("bypassPermissions");
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

  it("живой: флаги ответа — applyFlagSettings ключами settings; только названное: без модели нет setModel, без флагов нет applyFlagSettings; в waiting — как в живой; roster узнаёт модель и усилие сразу", async () => {
    const { st, req, field } = await bench();
    await st.open("site@laptop");
    expect(await req({ type: "session.update", callsign: "site@laptop", effort: "high", fast: true, style: "s", thinking: false, model: "m" })).toMatchObject({ result: { now: ["model", "effort", "fast", "style", "thinking"] } });
    expect(st.query("site@laptop").calls).toContainEqual({ name: "applyFlagSettings", args: [{ effortLevel: "high", fastMode: true, outputStyle: "s", alwaysThinkingEnabled: false }] });
    await until(() => field("site@laptop", "model") === "m" && field("site@laptop", "effort") === "high");
    const q = st.query("site@laptop");
    q.calls.length = 0;
    await req({ type: "session.update", callsign: "site@laptop", effort: "low" });
    expect(q.calls.map((c) => c.name)).toEqual(["applyFlagSettings"]);
    q.calls.length = 0;
    await req({ type: "session.update", callsign: "site@laptop", model: "n" });
    expect(q.calls.map((c) => c.name)).toEqual(["setModel"]);
    q.calls.length = 0;
    st.proc("site@laptop").send(msg.state("requires_action"));
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "waiting");
    expect(await req({ type: "session.update", callsign: "site@laptop", model: "w" })).toMatchObject({ result: { now: ["model"] } });
    expect(q.calls.map((c) => c.name)).toEqual(["setModel"]);
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

  it.each<[string, Record<string, unknown>]>([
    ["setModel", { model: "sonnet" }],
    ["applyFlagSettings", { effort: "low" }],
    ["renameSession", { title: "z" }],
  ])("325 · 3030 · SDK отказал %s — sdk_error, причина в журнале; manage не выключен", async (method, f) => {
    // источник: устав — ошибки словами; «отказ SDK — слово sdk_error, причина в журнале; модуль не выключается» — чьё: код
    const { st, req } = await bench();
    await st.open("docs@laptop");
    (st.query("docs@laptop") as unknown as Record<string, unknown>)[method] = async () => {
      throw new Error("нет");
    };
    expect(await req({ type: "session.update", callsign: "docs@laptop", ...f })).toMatchObject({ ok: false, error: "sdk_error", why: `docs@laptop: ${method} — нет` });
    expect(st.journal().some((l) => l.word === "sdk_error" && String(l.why).includes(method))).toBe(true);
    expect(st.states("docs@laptop").every((x) => !x.failed)).toBe(true);
  });

  it("325 · функции SDK: отказ getSessionInfo и renameSession остановленной — sdk_error; разговора нет на диске — заголовка нет", async () => {
    const { st, req } = await bench();
    const s = await st.open("docs@laptop");
    st.sdk.noFile.add(s.info.session_id);
    expect(await req({ type: "session.spec", callsign: "docs@laptop" })).toMatchObject({ ok: true, result: { title: null } });
    st.sdk.functions = {
      getSessionInfo: async () => {
        throw new Error("файла нет");
      },
      renameSession: async () => {
        throw new Error("нет файла");
      },
    };
    expect(await req({ type: "session.spec", callsign: "docs@laptop" })).toMatchObject({ ok: false, error: "sdk_error", why: "docs@laptop: getSessionInfo — файла нет" });
    await s.stop();
    expect(await req({ type: "session.update", callsign: "docs@laptop", title: "Y" })).toMatchObject({ ok: false, error: "sdk_error", why: "docs@laptop: renameSession — нет файла" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("PostModelSwitch: модель сменили в claude.ai — спецификация и поле берут новую, ответ хука пустой; source resume — не трогает; без requested_model — выбор снят (3035)", async () => {
    const { st } = await bench();
    const s = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    expect(await p.hook("PostModelSwitch", { from_model: "a", to_model: "claude-opus-5", requested_model: "opus", source: "command" })).toEqual([{}]);
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    await p.hook("PostModelSwitch", { requested_model: "sonnet", source: "resume" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    s.input("x");
    turn(p);
    await until(() => st.states("site@laptop").at(-1)?.model === "opus");
    await p.hook("PostModelSwitch", { requested_model: null, source: "command" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({});
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
    const d = await st.open("docs@laptop");
    st.proc("docs@laptop").send(msg.state("requires_action"));
    await until(() => d.state === "waiting");
    expect(await req({ type: "session.remove", callsign: "docs@laptop", after_turn: true })).toMatchObject({ ok: true, result: { after_turn: true } });
    await st.open("idle@laptop");
    expect(await req({ type: "session.remove", callsign: "idle@laptop", after_turn: true })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("idle@laptop")).toBe(false);
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

  it("322 · remove after_turn, пока сессия поднимается после перезапуска Host: идущий ход не прерван, сессия убрана после его конца", async () => {
    // источник: контракт — «after_turn: true посреди хода — убрать после его конца»; вызов инструмента, накопленный держателем, приходит до готовности; состояние starting — чьё: код
    const k = new FakeHolders();
    keepers.push(k);
    const home = temp();
    const a = await bench({ holders: k, home });
    const s = await a.st.open("wiki@laptop");
    const p = k.procs.get("wiki@laptop")!;
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await until(() => p.sock === null);
    p.failInit = true;
    const b = await bench({ holders: k, home, stateHome: a.st.home, start: false });
    void b.st.start();
    await until(() => p.initializes === 2 && b.st.relay.frames("hello").length);
    expect(b.st.kernel.sessions.get("wiki@laptop")!.state).toBe("starting");
    expect(await b.req({ type: "session.remove", callsign: "wiki@laptop", after_turn: true })).toMatchObject({ ok: true, result: { after_turn: true } });
    p.send({ $: "initialized" });
    await until(() => b.st.kernel.sessions.get("wiki@laptop")?.state === "busy");
    expect(p.alive).toBe(true);
    p.send(msg.result({ result: "готово" }));
    p.send(msg.state("idle"));
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

  it.each(["session.update", "session.call", "session.spec", "session.stop", "session.start", "session.remove"])("%s без callsign — bad_spec словом; manage не выключен ни на машине, ни в сессии", async (type) => {
    // источник: устав — ошибки словами; кадр приходит с любого пропуска флота: relay доставляет его по machine или to, поля не читает
    const { st, req } = await bench();
    await st.open("wiki@laptop");
    expect(await req({ type, machine: "laptop", method: "getStatus" })).toMatchObject({ ok: false, error: "bad_spec", why: `${type}: нет callsign` });
    expect(await req({ type, to: "wiki@laptop", method: "getStatus" })).toMatchObject({ ok: false, error: "bad_spec", why: `${type}: нет callsign` });
    expect(await req({ type: "session.spec", callsign: "wiki@laptop" })).toMatchObject({ ok: true });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
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

  it("90 · ~/Projects: только папки, файлов нет, порядок по кодам знаков; сессии и процессы не тронуты; ~ и полный путь; папка на точку отдаётся; ссылка на папку не папка", async () => {
    const { st, home, dirs } = await pc();
    expect(await dirs("~/Projects")).toMatchObject({ type: "reply", ok: true, result: { path: "~/Projects", dirs: ["poe2", "site", "switchboard", "wiki"] } });
    expect(st.holders.ops).toEqual([]);
    expect(st.kernel.sessions.size).toBe(0);
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, "Z"));
    mkdirSync(join(home, "a"));
    symlinkSync(join(home, "Z"), join(home, "link"), "junction");
    expect(await dirs("~/")).toMatchObject({ ok: true, result: { path: "~/", dirs: [".claude", "Projects", "Z", "a"] } });
    expect(await dirs(join(home, "Projects"))).toMatchObject({ ok: true, result: { path: join(home, "Projects") } });
  });

  it("91 · опечатка и путь-файл — not_found, путь не от ~, нет пути и пустой — bad_frame; строки refuse с путём и отправителем; ничего не создано; модуль жив", async () => {
    const { st, home, dirs } = await pc();
    expect(await dirs("~/Projets")).toMatchObject({ ok: false, error: "not_found", why: `machine.dirs «~/Projets» от ${OWNER}: ENOENT` });
    expect(await dirs("~/Projects/todo.txt")).toMatchObject({ ok: false, error: "not_found" });
    expect(await dirs("Projects")).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «Projects» от ${OWNER}: путь не от ~ и не полный` });
    expect(await dirs()).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «undefined» от ${OWNER}: нет пути` });
    expect(await dirs("")).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «» от ${OWNER}: нет пути` });
    expect(await dirs(1)).toMatchObject({ ok: false, error: "bad_frame", why: `machine.dirs «1» от ${OWNER}: нет пути` });
    expect(st.journal().filter((l) => l.kind === "refuse" && l.ev === "request").map((l) => l.word)).toEqual(["not_found", "not_found", "bad_frame", "bad_frame", "bad_frame", "bad_frame"]);
    expect(readdirSync(home)).toEqual(["Projects"]);
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
    const sent = call("site@laptop", "send", { to, text: "Готово" });
    const p = await until(() => st.relay.frames("push.send")[0]);
    st.relay.deliver({ type: "reply", id: p.id as string, from: "push", ok: true } as never);
    expect(await sent).toEqual(toolText(`отправлено: ${to}`));
    expect(st.relay.frames("message")).toEqual([{ type: "message", v: 1, from: "site@laptop", to, text: "Готово" }]);
    expect(p).toMatchObject({ v: 1, to: ".push", push: { to, type: "message", from: "site@laptop", notify: { title: "site@laptop", body: "Готово" } } });
    expect((p.push as { skip?: unknown }).skip).toBeUndefined();
  });

  it("отказ доставки модель видит в ответе send: слово и подсказка", async () => {
    // источник: дизайн «Переписка с человеком» — отказ Telegram доходит до модели; текст — чьё: код
    const { st, call } = await bench({ push: true });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await st.open("site@laptop");
    const pending = call("site@laptop", "send", { to: "telegram~a@b.c", text: "x" });
    const f = await until(() => st.relay.frames("push.send")[0]);
    st.relay.deliver({ type: "reply", id: f.id as string, from: "push", ok: false, error: "rate_limited", why: "предел Telegram, повторить через 37 с" } as never);
    expect(await pending).toEqual(toolText("Не доставлено: telegram~a@b.c — rate_limited. предел Telegram, повторить через 37 с", true));
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

describe("fleet: профиль и репозитории", () => {
  /** Клон на диске Host стенда: настоящий модуль профилей читает папки. */
  function clone(home: string, repo: string, folder: string, files: Record<string, string> = {}) {
    const dir = join(home, "profiles", repo.replace("/", "__"), folder);
    mkdirSync(dir, { recursive: true });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
  }

  it("8023 · инструмент update { profile } живой сессии: перезапуск, разговор продолжается, новый список в записи", async () => {
    const stateHome = temp();
    clone(stateHome, "team/p", "base", { "CLAUDE.md": "база" });
    clone(stateHome, "team/p", "dev", { "CLAUDE.md": "разработка" });
    const { st, call, field, req, home } = await bench({ stateHome, profiles: true });
    const dir = mkdtempSync(join(home, "d-"));
    const opened = (await req({ type: "session.open", v: 2, machine: "laptop", name: "job", dir, profile: ["team/p/base"] })) as Frame & { ok: boolean };
    expect(opened.ok).toBe(true);
    await until(() => field("job@laptop", "state") === "idle");
    const before = st.query("job@laptop").options as { resume?: string; sessionId?: string };
    const r = await call("me@laptop", "update", { callsign: "job@laptop", profile: ["team/p/base", "team/p/dev"] });
    expect(r).toEqual(toolText("профиль сменён; перезапуск между ходами"));
    await until(() => st.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st.holders.procs.get("job@laptop")?.initializes === 1);
    const after = st.query("job@laptop").options as { resume?: string; plugins: Array<{ path: string }> };
    expect(after.resume).toBe(before.sessionId ?? before.resume);
    expect(after.plugins.map((p) => p.path.split(/[\\/]/).at(-1))).toEqual(["base", "dev"]);
    await until(() => JSON.stringify(field("job@laptop", "profile")) === JSON.stringify([{ id: "team/p/base", state: "ok" }, { id: "team/p/dev", state: "ok" }]));
  });

  it("update { profile }: отказ называет слово и не трогает остального", async () => {
    const stateHome = temp();
    const { call, req, home, field } = await bench({ stateHome, profiles: true });
    const dir = mkdtempSync(join(home, "d-"));
    await req({ type: "session.open", v: 2, machine: "laptop", name: "job", dir });
    await until(() => field("job@laptop", "state") === "idle");
    const r = await call("me@laptop", "update", { callsign: "job@laptop", profile: ["team/p/none"], title: "новый" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no_profile");
  });

  it("8028 · fleet.prompt: текст добавки флота с именем-примером", async () => {
    const { req } = await bench();
    expect(await req({ type: "fleet.prompt", machine: "laptop" })).toMatchObject({ ok: true, result: { text: prompt("сессия@laptop") } });
  });

  it("инструмент profile без списка: кусочки, слоты, ключи только с моделями, клоны", async () => {
    const { st, call } = await bench();
    const asked = call("me@laptop", "profile");
    const f = await until(() => st.relay.frames("fleetkeys.list")[0]);
    st.relay.deliver({ type: "reply", id: f.id as string, ok: true, result: { keys: { orca: { env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_DEFAULT_OPUS_MODEL: "orcarouter/auto", CUSTOM: "tajna" }, settings: {} } } } } as Frame);
    const shown = JSON.parse(text(await asked));
    expect(shown).toEqual({
      machine: "laptop",
      pieces: { "team/p/ops": { kind: "piece", about: "серверы" } },
      slots: { main: { account: "a@x", wait: null } },
      keys: { orca: { models: { opus: "orcarouter/auto" } } },
      clones: { "team/p": { state: "ok", dir: "/x/team__p" } },
    });
    expect(text(await Promise.resolve({ content: [{ text: JSON.stringify(shown) }] }))).not.toContain("tajna");
  });

  it("инструмент profile со списком — тот же ответ, что экран: запрос profile.view", async () => {
    const { call } = await bench();
    expect(JSON.parse(text(await call("me@laptop", "profile", { profile: ["team/p/ops"] })))).toEqual({ pieces: ["team/p/ops"] });
  });
});

describe("fleet: сессия ведёт другие сессии", () => {
  it("296 · open дочери на другой машине — session.open от родителя, затем задача message от него; ответ — callsign", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const pending = call("lead@win", "open", { name: "fix-auth", machine: "wsl", dir: "~/app", text: "Почини вход: токен истекает через минуту" });
    const o = await replyTo(st, "session.open", { ok: true, result: { callsign: "fix-auth@wsl", session_id: "s1" } });
    expect(o).toMatchObject({ type: "session.open", v: 2, machine: "wsl", name: "fix-auth", dir: "~/app", from: "lead@win" });
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

  it("repos: добавить и убрать — цикл записей читает сам ключ; не владелец/имя — отказ, запись не идёт; без параметров — список", async () => {
    const { svc, call } = await meta();
    svc.values["fleet.profiles.repos"] = ["team/p", "old/one"];
    expect(JSON.parse(text(await call("site@win", "repos", { add: ["team/notes"], remove: ["old/one"] })))).toEqual(["team/p", "team/notes"]);
    expect(svc.values["fleet.profiles.repos"]).toEqual(["team/p", "team/notes"]);
    expect(JSON.parse(text(await call("site@win", "repos")))).toEqual(["team/p", "team/notes"]);
    const bad = await call("site@win", "repos", { add: ["просто-имя"] });
    expect(bad.isError).toBe(true);
    expect(svc.values["fleet.profiles.repos"]).toEqual(["team/p", "team/notes"]);
  });

  it("repos: ключа ещё нет — первая запись создаёт список", async () => {
    const { svc, call } = await meta();
    expect(JSON.parse(text(await call("site@win", "repos", { add: ["team/p"] })))).toEqual(["team/p"]);
    expect(svc.values["fleet.profiles.repos"]).toEqual(["team/p"]);
  });

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
        { callsign: "site@win", state: "busy", parent: null, model: "m", profile: [], slot: null, label: "Витрина", project: "Магазин" },
        { callsign: "kid@win", state: "idle", parent: "site@win", model: null, profile: [], slot: null, label: null, project: "Магазин" },
        { callsign: "free@win", state: "idle", parent: "pult~a@b.c", model: null, profile: [], slot: null, label: null, project: null },
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
  /** Последняя целая запись привязки: claude пропускает недописанное. */
  function lastBridgeOf(f: string) {
    return readFileSync(f, "utf8").trim().split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l) as { type: string; bridgeSessionId?: string }];
      } catch {
        return [];
      }
    }).filter((x) => x.type === "bridge-session").at(-1);
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

  it("230 · новая сессия: один enableRemoteControl(true) без имени; в roster кадром url; в разделе bridge и аккаунт; журнал; привязку не снимает", async () => {
    const { st } = await make();
    await st.open("site@laptop");
    await until(() => st.states("site@laptop").at(-1)?.remote);
    expect(rcOf(st, "site@laptop")).toEqual([{ name: "enableRemoteControl", args: [true] }]);
    expect(st.states("site@laptop").at(-1)?.remote).toEqual({ url: "https://claude.ai/code/session_01Jai" });
    expect(rec(st, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai", bridge: "session_01Jai", account: "infirex" });
    expect(st.journal().find((l) => l.ev === "remote")?.why).toBe("Remote Control включён: https://claude.ai/code/session_01Jai · infirex");
    expect(unbinds(st)).toEqual([]);
  });

  it("вне слотов: аккаунта нет — в журнале прочерк", async () => {
    const { st, rw } = await make();
    rw.who.main = undefined as never;
    await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    expect(rec(st, "site@laptop")).toMatchObject({ account: null });
    expect(st.journal().find((l) => l.ev === "remote")?.why).toBe("Remote Control включён: https://claude.ai/code/session_01Jai · —");
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
    expect(readFileSync(f, "utf8").endsWith("\n")).toBe(true);
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

  it("235 · claude отказал во включении: по одному вызову на старт, remote { error } кадром, строка stop; повторов нет; следующий старт с успехом — снова { url }", async () => {
    rc = (n) => {
      if (n < 3) throw new Error("Remote Control requires a claude.ai subscription");
      return { session_url: "https://claude.ai/code/x", bridge_session_id: "x" };
    };
    const { st } = await make();
    const s = await st.open("site@laptop");
    await until(() => st.journal().some((l) => l.ev === "remote" && l.kind === "stop"));
    await until(() => st.states("site@laptop").at(-1)?.remote);
    expect(st.states("site@laptop").at(-1)?.remote).toEqual({ error: "Remote Control requires a claude.ai subscription" });
    await s.restart();
    await until(() => st.journal().filter((l) => l.ev === "remote" && l.kind === "stop").length === 2);
    await later();
    expect(rcCalls).toBe(2);
    expect(st.journal().filter((l) => l.kind === "stop" && l.ev === "remote").map((l) => l.why)).toEqual(["Remote Control requires a claude.ai subscription", "Remote Control requires a claude.ai subscription"]);
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

  it("resume без привязки и без файла — снимать нечего; записи нет, а привязка есть — снять; снятая не снимается снова; недописанная строка и слово в тексте разговора — не запись", async () => {
    const { st, rw } = await make();
    const s = await st.open("site@laptop");
    await until(() => rec(st, "site@laptop"));
    st.proc("site@laptop").exit(1);
    await until(() => st.sdk.of("site@laptop").length === 2 && rcOf(st, "site@laptop").length === 1);
    expect(unbinds(st)).toEqual([]);
    st.session("host-remote", "site@laptop")!.store().set(undefined);
    const f = transcript(rw, s.info.session_id, "session_02Jai");
    appendFileSync(f, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "bridge-session" }] }, sessionId: s.info.session_id }) + "\n");
    const crash = async (n: number) => {
      st.session("host-remote", "site@laptop")!.store().set(undefined);
      st.proc("site@laptop").exit(1);
      await until(() => st.sdk.of("site@laptop").length === n && rcOf(st, "site@laptop").length === 1);
    };
    await crash(3);
    expect(unbinds(st).at(-1)?.why).toBe("привязка снята: записи нет · session_02Jai");
    await crash(4);
    expect(unbinds(st)).toHaveLength(1);
    appendFileSync(f, JSON.stringify({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "session_03Jai", lastSequenceNum: 0 }) + '\n{"type":"bridge-session","sessionId');
    await crash(5);
    expect(unbinds(st).at(-1)?.why).toBe("привязка снята: записи нет · session_03Jai");
    // файл кончался обрывком: запись снятия — своей строкой, иначе claude её не прочтёт
    expect(lastBridgeOf(f)).toMatchObject({ bridgeSessionId: "" });
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

// Дописано на втором круге: поведение снято с работающего кода чёрным ящиком до сноса; чьё: код.
describe("формат раздела и поля manage", () => {
  it("раздел: режим лежит только не по умолчанию; remove_after_turn — кто просил; поле model — выбор, иначе модель из init; spec — только выбор", async () => {
    const { st, home, req } = await bench();
    mkdirSync(join(home, "p"));
    await req({ type: "session.open", v: 2, machine: "laptop", name: "a", dir: "~/p", model: "m", effort: "high", fast: false, style: "s", thinking: false });
    const s = st.session("host-manage", "a@laptop")!;
    const base = { model: "m", effort: "high", fast: false, style: "s", thinking: false, parent: OWNER };
    expect(s.store().get()).toEqual(base);
    const p = st.proc("a@laptop");
    p.send({ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "u1", session_id: "s" });
    await until(() => st.states("a@laptop").at(-1)?.mode === "plan");
    expect(s.store().get()).toEqual({ ...base, mode: "plan" });
    p.send({ type: "system", subtype: "status", status: null, permissionMode: "bypassPermissions", uuid: "u2", session_id: "s" });
    await until(() => st.states("a@laptop").at(-1)?.mode === "bypassPermissions");
    expect(s.store().get()).toEqual(base);
    p.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("a@laptop")!.state === "busy");
    await req({ type: "session.remove", callsign: "a@laptop", after_turn: true, from: "lead@laptop" });
    expect(s.store().get()).toEqual({ ...base, remove_after_turn: "lead@laptop" });

    await st.open("b@laptop");
    await until(() => st.states("b@laptop").length);
    expect(st.states("b@laptop").at(-1)?.model).toBeUndefined();
    st.proc("b@laptop").send({ ...msg.init("zz", "claude-init"), permissionMode: "acceptEdits" });
    await until(() => st.states("b@laptop").at(-1)?.model === "claude-init" && st.states("b@laptop").at(-1)?.mode === "acceptEdits");
    expect(st.session("host-manage", "b@laptop")!.store().get()).toEqual({ mode: "acceptEdits" });
    expect(await req({ type: "session.spec", callsign: "b@laptop" })).toMatchObject({ ok: true, result: { model: null, effort: null, title: null } });
  });

  it("пакет каждого модуля отдаёт объект модуля; вклад в query(): у manage чекпоинты и хук; без флагов нет settings; без запроса открытия нет заголовка и раздела; у fleet сервер MCP, позывной в промпте и выключенная переписка Claude Code (устав, слово 1 нояб.)", async () => {
    for (const m of [managePkg, fleetPkg, remotePkg, machinePkg]) expect(typeof m).toBe("object");
    const home = temp();
    const opened = async (entries: Parameters<typeof standHost>[0]) => {
      const st = await standHost(entries);
      stands.push(st);
      await st.open("a@laptop");
      return st.query("a@laptop").options as Record<string, any>;
    };
    const m = await opened({ modules: [{ manifest: manifestOf("manage"), module: makeManage({ home }) }] });
    expect(m.enableFileCheckpointing).toBe(true);
    expect(Object.keys(m.hooks)).toEqual(["PostModelSwitch"]);
    expect(m.env.CLAUDE_CODE_HARBOR_KITE).toBeUndefined();
    expect(m).not.toHaveProperty("settings");
    expect(m).not.toHaveProperty("title");
    for (const [name, module] of [["remote", makeRemote({ claudeDir: temp() })], ["machine", makeMachine({ home })]] as const) {
      const o = await opened({ modules: [{ manifest: manifestOf(name), module }] });
      expect(Object.keys(o.hooks ?? {})).toEqual([]);
      expect(o.mcpServers ?? {}).toEqual({});
      expect(o.systemPrompt?.append).toBeUndefined();
    }
    const f = await opened({ modules: [{ manifest: manifestOf("fleet"), module: makeFleet().module }, { manifest: manifestOf("chat"), module: makeChat() }] });
    expect(f.env.CLAUDE_CODE_HARBOR_KITE).toBe("0");
    expect(f.mcpServers.fleet).toMatchObject({ type: "sdk", name: "fleet" });
    expect(f.systemPrompt.append).toContain(prompt("a@laptop"));
  });
});

describe("входы manage: остальные формы", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["усилие не того вида", { effort: "turbo" }, 'effort = "turbo"'],
    ["модель пустая", { model: "" }, 'model = ""'],
    ["модель не строка", { model: 1 }, "model = 1"],
    ["fast не флаг", { fast: 1 }, "fast = 1"],
    ["стиль пустой", { style: "" }, 'style = ""'],
    ["thinking не флаг", { thinking: "да" }, 'thinking = "да"'],
    ["заголовок пустой", { title: "" }, 'title = ""'],
  ])("session.update не по форме: %s — bad_spec, раздел не тронут", async (_n, f, why) => {
    const { st, req } = await bench();
    await st.open("d@laptop");
    expect(await req({ type: "session.update", callsign: "d@laptop", ...f })).toMatchObject({ ok: false, error: "bad_spec", why: `session.update d@laptop: ${why}` });
    expect(st.journal().some((l) => l.word === "bad_spec" && String(l.why).includes(why))).toBe(true);
    expect(st.session("host-manage", "d@laptop")!.store().get()).toBeUndefined();
    expect(st.query("d@laptop").calls).toEqual([]);
  });

  it("session.update: все усилия вида; пусто и незнакомое поле — ok и now пустой", async () => {
    const { st, req } = await bench();
    await st.open("d@laptop");
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) expect(await req({ type: "session.update", callsign: "d@laptop", effort }), effort).toMatchObject({ ok: true, result: { now: ["effort"] } });
    expect(await req({ type: "session.update", callsign: "d@laptop" })).toMatchObject({ ok: true, result: { now: [] } });
    expect(await req({ type: "session.update", callsign: "d@laptop", foo: 1 })).toMatchObject({ ok: true, result: { now: [] } });
  });

  it("session.open: заголовок при любом открытии; fork без resume и пустой resume — обычный старт; point — старт point; второй старт из точки — без заголовка", async () => {
    const { st, req } = await bench();
    const sid = "11111111-2222-4333-8444-555555555555";
    await req({ type: "session.open", v: 2, machine: "laptop", name: "r", dir: "~", resume: sid });
    expect(st.query("r@laptop").options.title).toBe("r");
    await req({ type: "session.open", v: 2, machine: "laptop", name: "pp", dir: "~", point: 3, resume: sid });
    expect(st.query("pp@laptop").options).toMatchObject({ title: "pp", resume: sid });
    expect(st.session("host-manage", "pp@laptop")!.info).toMatchObject({ start: "point", point: 3 });
    await req({ type: "session.open", v: 2, machine: "laptop", name: "f", dir: "~", fork: true });
    expect(st.session("host-manage", "f@laptop")!.info.start).toBe("spawn");
    await req({ type: "session.open", v: 2, machine: "laptop", name: "e", dir: "~", resume: "" });
    expect(st.session("host-manage", "e@laptop")!.info.start).toBe("spawn");
    const s = st.session("host-manage", "r@laptop")!;
    await s.stop();
    await s.start({ point: 9 });
    expect(st.query("r@laptop").options.title).toBeUndefined();
  });

  it("session.start живой — ok, процесс тот же; stop остановленной — ok; remove с after_turn остановленной — сразу", async () => {
    const { st, req } = await bench();
    await st.open("c@laptop");
    expect(await req({ type: "session.start", callsign: "c@laptop" })).toMatchObject({ ok: true });
    expect(st.sdk.of("c@laptop")).toHaveLength(1);
    expect(await req({ type: "session.stop", callsign: "c@laptop" })).toMatchObject({ ok: true });
    expect(await req({ type: "session.stop", callsign: "c@laptop" })).toMatchObject({ ok: true });
    const r = await req({ type: "session.remove", callsign: "c@laptop", after_turn: true });
    expect(r).toMatchObject({ ok: true });
    expect(r.result).toBeUndefined();
    expect(st.kernel.sessions.has("c@laptop")).toBe(false);
  });
});

describe("спорные места: найдено при сверке", () => {
  it("SDK отказал в модели — выбор не записан: настоящий setModel отвечает «not found», а старт с такой моделью проваливает каждый ход", async () => {
    // опыт на SDK 0.3.311, claude-haiku-5-5: setModel("нет-такой-модели") → Model not found; query с ней — init есть, result is_error на каждом ходу
    const { st, req } = await bench();
    await st.open("d@laptop");
    await req({ type: "session.update", callsign: "d@laptop", model: "sonnet" });
    (st.query("d@laptop") as unknown as Record<string, unknown>).setModel = async () => {
      throw new Error("Model 'нет' not found");
    };
    expect(await req({ type: "session.update", callsign: "d@laptop", model: "нет", effort: "low" })).toMatchObject({ ok: false, error: "sdk_error", why: "d@laptop: setModel — Model 'нет' not found" });
    expect(st.session("host-manage", "d@laptop")!.store().get()).toEqual({ model: "sonnet" });
    await st.session("host-manage", "d@laptop")!.restart();
    expect(st.query("d@laptop").options.model).toBe("sonnet");
  });

  it("имя сессии начинается с буквы или цифры: точка в начале — системное имя адреса", async () => {
    const { st, req } = await bench();
    for (const name of [".keeper", "-x", "_x", "ю"]) expect(await req({ type: "session.open", v: 2, machine: "laptop", name, dir: "~" }), name).toMatchObject({ ok: false, error: "bad_name" });
    expect(await req({ type: "session.open", v: 2, machine: "laptop", name: "a.b_c-1", dir: "~" })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.size).toBe(1);
  });
});

describe("fleet: остальные формы", () => {
  it("типы параметров инструментов: их видит модель", () => {
    const tools = makeFleet().tools("me@pc") as Array<{ name: string; inputSchema: z.ZodRawShape }>;
    const schema = Object.fromEntries(tools.map((t) => [t.name, z.toJSONSchema(z.object(t.inputSchema))])) as Record<string, { properties: Record<string, { type?: string; minimum?: number; additionalProperties?: unknown }>; required?: string[] }>;
    const types = (n: string) => Object.fromEntries(Object.entries(schema[n].properties).map(([k, v]) => [k, v.type]));
    expect(types("list")).toEqual({});
    expect(schema.send).toMatchObject({ required: ["to", "text"], properties: { to: { type: "string" }, text: { type: "string" } } });
    expect(schema.answer).toMatchObject({ required: ["to", "question", "answers"], properties: { answers: { type: "object", additionalProperties: { type: "string" } } } });
    expect(schema.open.required).toEqual(["name", "dir", "text"]);
    expect(new Set(Object.values(types("open")))).toEqual(new Set(["string", "array", "object"]));
    expect(schema.history).toMatchObject({ required: ["callsign"], properties: { limit: { type: "integer", minimum: 1 } } });
    expect(schema.update.required).toEqual(["callsign"]);
    expect(new Set(Object.values(types("update")))).toEqual(new Set(["string", "array", undefined]));
    expect(schema.label.required).toEqual(["to", "text"]);
    expect(schema.remove.required).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["timeout", { error: "timeout" }, "Не выполнено: x@wsl — timeout: исход неизвестен, проверь list"],
    ["слово без причины", { error: "too_large", bytes: 3 }, "Не выполнено: x@wsl — too_large"],
    ["слово с причиной", { error: "stopped", why: "почему" }, "Не выполнено: x@wsl — stopped. почему"],
    ["обрыв", { error: "disconnected" }, "Доставка не подтверждена: нет связи с relay (disconnected)"],
    ["нет на связи", { error: "offline" }, "Не доставлено: x@wsl не на связи (offline)"],
  ])("отказ словом: %s — один текст у send, answer, history, update и remove", async (_n, r, want) => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ["message", "send", { to: "x@wsl", text: "t" }],
      ["answer", "answer", { to: "x@wsl", question: "q", answers: {} }],
      ["session.history", "history", { callsign: "x@wsl" }],
      ["session.update", "update", { callsign: "x@wsl", model: "m" }],
      ["session.remove", "remove", { callsign: "x@wsl" }],
    ];
    for (const [frame, tool, args] of calls) {
      const pending = call("lead@win", tool, args);
      await replyTo(st, frame, { ok: false, ...r });
      expect(await pending, tool).toEqual(toolText(want, true));
    }
  });

  it("send не сессии: кадр без id и текст «отправлено» — служба, машина; пуш с меткой, чтобы письма не слипались; себе и сессии своей машины — доставлено", async () => {
    const { st, call } = await bench({ machine: "win", push: true });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await st.open("lead@win");
    expect(text(await call("lead@win", "send", { to: "@wsl", text: "t" }))).toBe("отправлено: @wsl");
    expect(text(await call("lead@win", "send", { to: ".relay", text: "t" }))).toBe("отправлено: .relay");
    expect(st.relay.frames("message").map((f) => [f.to, f.id])).toEqual([["@wsl", undefined], [".relay", undefined]]);
    expect(text(await call("lead@win", "send", { to: "lead@win", text: "t" }))).toBe("доставлено: lead@win");
    const sent = call("lead@win", "send", { to: "~a@b.c", text: "x".repeat(5000) });
    const p = await until(() => st.relay.frames("push.send").at(-1));
    st.relay.deliver({ type: "reply", id: p.id as string, from: "push", ok: true } as never);
    await sent;
    expect(p.push).toMatchObject({ to: "~a@b.c", notify: { title: "lead@win", body: "x".repeat(5000), tag: expect.any(String) } });
  });

  it("history: только текст и вызовы инструментов, каждый блок строкой; итог хода, thinking, картинки и ответы инструментов пропущены", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const h = call("lead@win", "history", { callsign: "x@wsl" });
    await replyTo(st, "session.history", {
      ok: true,
      result: {
        messages: [
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "вывод" }] } },
          { type: "user", message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image", source: {} }] } },
          { type: "assistant", message: { content: [{ type: "thinking", thinking: "t" }] } },
          { type: "assistant", message: { content: [{ type: "text", text: "1" }, { type: "tool_use", name: "A" }, { type: "tool_use", name: "B" }, { type: "text", text: "3" }] } },
          { type: "assistant", message: { content: "строка" } },
          { type: "user", message: { content: "" } },
          { type: "result", result: "x" },
        ],
      },
    });
    expect(text(await h)).toBe("user: a\nuser: b\nassistant: 1\ntool: A\ntool: B\nassistant: 3\nassistant: строка");
  });

  it("update: что сразу — через запятую; кадры session.slot и session.update только со своими полями; без полей «сразу: —»; отказ после слота — только отказ; remove своим callsign — как без него", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    await st.open("docs@win");
    expect(text(await call("lead@win", "update", { callsign: "docs@win", model: "a", effort: "low", title: "T" }))).toBe("сразу: model, effort, title");
    expect(text(await call("lead@win", "update", { callsign: "docs@win" }))).toBe("сразу: —");
    const u = call("lead@win", "update", { callsign: "x@wsl", slot: "main", model: "m", effort: "low", title: "T" });
    const slot = await replyTo(st, "session.slot", { ok: true, result: { restart: true } });
    expect(slot).toMatchObject({ callsign: "x@wsl", slot: "main", from: "lead@win", v: 2 });
    expect(slot).not.toHaveProperty("model");
    const up = await replyTo(st, "session.update", { ok: false, error: "bad_spec", why: "w" });
    expect(up).toMatchObject({ callsign: "x@wsl", model: "m", effort: "low", title: "T", from: "lead@win", v: 1 });
    expect(up).not.toHaveProperty("slot");
    expect(await u).toEqual(toolText("Не выполнено: x@wsl — bad_spec. w", true));
    expect(text(await call("lead@win", "remove", { callsign: "lead@win" }))).toBe("закроюсь после этого хода");
    expect(st.kernel.sessions.has("lead@win")).toBe(false);
  });

  it("open: кадр только с заданными полями; слот из ответа — в тексте; отказ без причины — только слово; задача не дошла — слово", async () => {
    const { st, call } = await bench({ machine: "win" });
    await st.open("lead@win");
    const o = call("lead@win", "open", { name: "k", dir: "~/x", text: "t", machine: "wsl" });
    const f = await replyTo(st, "session.open", { ok: true, result: { callsign: "k@wsl", session_id: "s1", slot: "s" } });
    expect(Object.keys(f).filter((k) => !["id", "type", "v", "from", "machine", "name", "dir"].includes(k))).toEqual([]);
    await replyTo(st, "message", { ok: true });
    expect(text(await o)).toBe("открыта: k@wsl · слот s; задача во вводе, итог хода придёт сам");
    const o2 = call("lead@win", "open", { name: "k3", dir: "~/x", text: "t", machine: "wsl" });
    await replyTo(st, "session.open", { ok: false, error: "bad_dir" }, 1);
    expect(await o2).toEqual(toolText("Не выполнено: k3@wsl — bad_dir", true));
    const o3 = call("lead@win", "open", { name: "k4", dir: "~/x", text: "t", machine: "wsl" });
    await replyTo(st, "session.open", { ok: true, result: { callsign: "k4@wsl", session_id: "s1" } }, 2);
    await replyTo(st, "message", { ok: false, error: "stopped", why: "w" }, 1);
    expect(await o3).toEqual(toolText("открыта: k4@wsl, но задача не доставлена — stopped", true));
  });

  it("итог родителю — у каждого хода, пока ввод от него: и у второго подряд", async () => {
    const { st, call, home } = await bench({ machine: "win" });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir: home, text: "x" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    turn(kid, "w", { result: "первый" });
    await until(() => st.proc("lead@win").inputs.length === 1);
    turn(kid, "w", { result: "второй" });
    await until(() => st.proc("lead@win").inputs.length === 2);
    expect(st.proc("lead@win").inputs[1].message.content).toBe(wrap("docs@win", "второй"));
    expect(st.journal().filter((l) => l.ev === "report")).toEqual([]);
  });
});

describe("remote: остальные формы", () => {
  it("отказ не трогает раздел и остаётся в поле у остановленной; ответ без bridge и без ссылки — раздел как есть, журнал «—», поля нет", async () => {
    const proto = stand.FakeQuery.prototype as unknown as Record<string, unknown>;
    const old = proto.enableRemoteControl;
    let n = 0;
    proto.enableRemoteControl = async function () {
      n++;
      if (n === 1) throw new Error("нет");
      return n === 2 ? { session_url: "u" } : {};
    };
    try {
      const { st } = await bench({ remote: temp("c-") });
      const s = await st.open("r@laptop");
      const rec = () => st.session("host-remote", "r@laptop")!.store().get();
      const field = () => st.kernel.sessions.get("r@laptop")!.record().remote;
      await until(() => field());
      expect(rec()).toBeUndefined();
      await s.stop();
      expect(field()).toEqual({ error: "нет" });
      await s.start();
      await until(() => (field() as { url?: string } | undefined)?.url === "u");
      expect(rec()).toEqual({ url: "u", account: null });
      await s.restart();
      await until(() => !field());
      expect(rec()).toEqual({ account: null });
      expect(st.journal().filter((l) => l.ev === "remote").at(-1)?.why).toBe("Remote Control включён: — · —");
    } finally {
      proto.enableRemoteControl = old;
    }
  });
});

describe("пара", () => {
  const WING = "lead-wing@win";
  /** Ведомый открыт: ведущий запросом с пульта, ведомый со своими настройками. */
  async function pair(o: { slot?: string } = {}) {
    const b = await bench({ machine: "win" });
    const lead = await b.st.open("lead@win");
    const r = await b.req({ type: "session.open", machine: "win", v: 2, wing_of: "lead@win", model: "haiku", effort: "low", ...(o.slot ? { slot: o.slot } : {}) });
    expect(r).toMatchObject({ ok: true, result: { callsign: WING } });
    const wing = b.st.kernel.sessions.get(WING)!;
    await until(() => wing.state === "idle");
    return { ...b, lead, wing };
  }
  /** Строка списка сессий: так roster несёт пару. */
  const rosterOf = (b: { st: Stand }, extra: object[] = []) =>
    b.st.relay.deliver({
      type: "roster",
      machines: [{ machine: "win", since: 1, proto: 1, contract: {} }],
      sessions: [
        { callsign: "lead@win", state: "idle", model: "opus", profile: [{ id: "t/p/lead", state: "ok" }], slot: { name: "main" } },
        { callsign: WING, state: "idle", parent: "lead@win", wing: true, model: "haiku", profile: [{ id: "t/p/design", state: "ok" }], slot: { name: "kimi" } },
        ...extra,
      ],
      clients: [],
    } as Frame);
  const prefs = (st: Stand) => setInterval(() => {
    for (const f of st.relay.frames("prefs.get")) if (!f.done) ((f.done = true), st.relay.deliver({ type: "reply", id: f.id as string, ok: true, result: { values: {} } } as Frame));
  }, 5);
  const list = async (b: Awaited<ReturnType<typeof pair>>, me: string) => {
    timers.push(prefs(b.st));
    return JSON.parse(text(await b.call(me, "list"))) as { sessions: Array<Record<string, unknown>> };
  };

  it("8101 · session.open с wing_of и своими настройками: две сессии, у ведомого parent — ведущий и wing, настройки его", async () => {
    // источник: слово пользователя 6 нояб. «Для обеих можно выбирать и профиль и настройки все»
    const { st, w, field } = await pair({ slot: "kimi" });
    await until(() => field(WING, "wing") === true);
    expect(field(WING, "parent")).toBe("lead@win");
    expect(field("lead@win", "wing")).toBeUndefined();
    expect(st.query(WING).options).toMatchObject({ model: "haiku", effort: "low" });
    expect(st.query("lead@win").options.model).toBeUndefined();
    expect(w.seen.filter(([k]) => k === "slot").at(-1)![1]).toMatchObject({ slot: "kimi", wing_of: "lead@win" });
  });

  it("8103 · ведущий отправляет задачу send: ведомый получает её первым сообщением хода", async () => {
    const b = await pair();
    rosterOf(b);
    expect(text(await b.call("lead@win", "send", { to: WING, text: "Сделай тест" }))).toBe(`доставлено: ${WING}`);
    await until(() => b.st.proc(WING).inputs.length === 1);
    expect(b.st.proc(WING).inputs[0].message.content).toBe(task("lead@win", "Сделай тест"));
  });

  it("8104 · ход ведомого кончился: итог пришёл ведущему без отдельного запроса", async () => {
    const b = await pair();
    await until(() => b.st.proc("lead@win").inputs.length === 1);
    await b.call("lead@win", "send", { to: WING, text: "Сделай" });
    await until(() => b.st.proc(WING).inputs.length === 1);
    turn(b.st.proc(WING), "работаю", { result: "Сделано, 12 из 12" });
    await until(() => b.st.proc("lead@win").inputs.length === 2);
    expect(b.st.proc("lead@win").inputs[1].message.content).toBe(wrap(WING, "Сделано, 12 из 12"));
  });

  it("8105 · второй wing_of — has_wing; ведомый у ведомого и имя с папкой — bad_spec; ведущего нет на машине — offline", async () => {
    const { st, req } = await pair();
    const open = (f: object) => req({ type: "session.open", machine: "win", v: 2, ...f });
    expect(await open({ wing_of: "lead@win" })).toMatchObject({ ok: false, error: "has_wing" });
    expect(await open({ wing_of: WING })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(await open({ wing_of: "lead@win", name: "x" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(await open({ wing_of: "gone@win" })).toMatchObject({ ok: false, error: "offline" });
    expect(st.sdk.of(WING)).toHaveLength(1);
  });

  it("8106 · удалить ведущего: ведомый тоже убран, первым; ведомый один уходит один; снятие после хода — тем же путём", async () => {
    const a = await pair();
    expect(await a.req({ type: "session.remove", callsign: "lead@win" })).toMatchObject({ ok: true });
    expect([a.st.kernel.sessions.has(WING), a.st.kernel.sessions.has("lead@win")]).toEqual([false, false]);
    expect(a.st.relay.frames("ledger.add").filter((f) => f.ev === "session.removed").map((f) => f.callsign)).toEqual([WING, "lead@win"]);

    const b = await pair();
    expect(await b.req({ type: "session.remove", callsign: WING })).toMatchObject({ ok: true });
    expect([b.st.kernel.sessions.has(WING), b.st.kernel.sessions.has("lead@win")]).toEqual([false, true]);

    const c = await pair();
    c.st.proc("lead@win").send(msg.state("running"));
    await until(() => c.lead.state === "busy");
    expect(await c.req({ type: "session.remove", callsign: "lead@win", after_turn: true })).toMatchObject({ ok: true, result: { after_turn: true } });
    expect(c.st.kernel.sessions.has(WING)).toBe(true);
    c.st.proc("lead@win").send(msg.result());
    c.st.proc("lead@win").send(msg.state("idle"));
    await until(() => !c.st.kernel.sessions.has("lead@win"));
    expect(c.st.kernel.sessions.has(WING)).toBe(false);
  });

  it("8107 · ведомый поднялся у идущей сессии: ведущему одно сообщение, отправитель его ввода прежний; после перезапуска ведомого нового нет", async () => {
    // источник: слепой архитектор — без report: true ведущий стал бы задавать вопросы ведомому
    const b = await bench({ machine: "win" });
    const lead = await b.st.open("lead@win");
    await b.req({ type: "session.prompt", callsign: "lead@win", text: "задача", from: OWNER });
    await until(() => b.st.proc("lead@win").inputs.length === 1);
    expect(lead.info.from).toBe(OWNER);
    await b.req({ type: "session.open", machine: "win", v: 2, wing_of: "lead@win", model: "haiku", slot: "kimi" });
    const p = b.st.proc("lead@win");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1].message.content).toBe(wrap(WING, `ведомый ${WING} поднят: haiku, kimi. Задачу ему — fleet.send, итог его хода придёт сам.`));
    expect(lead.info.from).toBe(OWNER);
    expect(b.st.sdk.of("lead@win")).toHaveLength(1);
    await b.st.session("host-manage", WING)!.restart();
    await until(() => b.st.sdk.of(WING).length === 2 && b.st.kernel.sessions.get(WING)!.state === "idle");
    await later();
    expect(p.inputs).toHaveLength(2);
  });

  it("8113 · session.open с wing_of без имени и папки: имя <ведущий>-wing, папка и машина ведущего", async () => {
    const { st, wing, lead } = await pair();
    expect(wing.info.callsign).toBe("lead-wing@win");
    expect(wing.info.cwd).toBe(lead.info.cwd);
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.opened" && f.callsign === WING)).toBeDefined();
  });

  it("8114 · стоп ведущего посреди хода ведомого, затем старт: стоят оба, итог прерванного хода дошёл, поднялись оба", async () => {
    // источник: слово пользователя 5 нояб. «снаружи выглядит как одна сессия»
    const b = await pair();
    const lp = b.st.proc("lead@win");
    await until(() => lp.inputs.length === 1);
    await b.call("lead@win", "send", { to: WING, text: "Сделай" });
    const wp = b.st.proc(WING);
    await until(() => wp.inputs.length === 1);
    wp.send(msg.state("running"));
    await until(() => b.wing.state === "busy");
    expect(await b.req({ type: "session.stop", callsign: "lead@win" })).toMatchObject({ ok: true });
    expect(wp.interrupts).toBe(1);
    expect([b.lead.state, b.wing.state]).toEqual(["stopped", "stopped"]);
    expect(lp.inputs).toHaveLength(2);
    expect(lp.inputs[1].message.content).toBe(wrap(WING, "ход кончился: error_during_execution"));
    expect(await b.req({ type: "session.start", callsign: "lead@win" })).toMatchObject({ ok: true });
    await until(() => b.lead.state === "idle" && b.wing.state === "idle");
    expect(await b.req({ type: "session.stop", callsign: WING })).toMatchObject({ ok: true });
    expect([b.lead.state, b.wing.state]).toEqual(["idle", "stopped"]);
  });

  it("8115 · процесс ведомого умер посреди хода ведущего: один resume, ведущему слово об обрыве, ход не повторён", async () => {
    const b = await pair();
    const lp = b.st.proc("lead@win");
    await until(() => lp.inputs.length === 1);
    await b.call("lead@win", "send", { to: WING, text: "Сделай" });
    const wp = b.st.proc(WING);
    await until(() => wp.inputs.length === 1);
    wp.send(msg.state("running"));
    await until(() => b.wing.state === "busy");
    wp.exit(1, "умер");
    await until(() => b.st.sdk.of(WING).length === 2 && b.wing.state === "idle");
    await until(() => lp.inputs.length === 2);
    expect(lp.inputs[1].message.content).toBe(wrap(WING, `ход ведомого ${WING} оборвался: процесс вышел, ход не повторяется`));
    await later();
    expect(b.st.proc(WING).inputs).toHaveLength(0);
    expect(lp.inputs).toHaveLength(2);
  });

  it("8118 · откат ведущего на точку на той же машине: ведущий с точкой, ведомый поднят без точки", async () => {
    const b = await pair();
    await b.req({ type: "session.stop", callsign: "lead@win" });
    expect(await b.req({ type: "session.start", callsign: "lead@win", point: 3 })).toMatchObject({ ok: true });
    await until(() => b.wing.state === "idle");
    expect([b.lead.info.start, b.lead.info.point]).toEqual(["point", 3]);
    expect(b.wing.info.start).toBe("resume");
    expect(b.wing.info.point).toBeUndefined();
  });

  it("8109 · другая сессия: list — пара одна сессия, ведомого и его адреса нет, настройки внутри ведущего", async () => {
    // источник: слово пользователя 6 нояб. «пара прозрачна на уровне MCP: видна только сессия владельца»
    const b = await pair();
    rosterOf(b, [{ callsign: "other@win", state: "idle", model: "opus" }]);
    const raw = text(await (async () => (timers.push(prefs(b.st)), b.call("other@win", "list")))());
    expect(raw).not.toContain(WING);
    const seen = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> };
    expect(seen.sessions.map((s) => s.callsign)).toEqual(["lead@win", "other@win"]);
    expect(seen.sessions[0].pair).toEqual({ state: "idle", model: "haiku", profile: ["t/p/design"], slot: "kimi" });
    expect(seen.sessions[1].pair).toBeUndefined();
  });

  it("8110 · другая сессия: send, answer, history на адрес ведомого — pair_inside, ведомый ничего не получил", async () => {
    const b = await pair();
    rosterOf(b);
    const word = `Не выполнено: ${WING} — pair_inside. Это ведомый внутри пары, работать с ним можно только через его ведущего`;
    expect(await b.call("other@win", "send", { to: WING, text: "x" })).toEqual(toolText(word, true));
    expect(await b.call("other@win", "answer", { to: WING, question: "q", answers: {} })).toEqual(toolText(word, true));
    expect(await b.call("other@win", "history", { callsign: WING })).toEqual(toolText(word, true));
    await later();
    expect(b.st.proc(WING).inputs).toHaveLength(0);
  });

  it("8111 · другая сессия: update ведущего с wing { model }: модель ведомого сменилась, ведущего — нет; ведомого нет — откроет; null — снимет", async () => {
    const b = await pair();
    rosterOf(b);
    expect(text(await b.call("other@win", "update", { callsign: "lead@win", wing: { model: "sonnet" } }))).toBe("ведомому сразу: model");
    expect(b.st.query(WING).calls.filter((c) => c.name === "setModel").map((c) => c.args)).toEqual([["sonnet"]]);
    expect(b.st.query("lead@win").calls.filter((c) => c.name === "setModel")).toHaveLength(0);
    expect(text(await b.call("other@win", "update", { callsign: "lead@win", wing: null }))).toBe("ведомый снят");
    expect(b.st.kernel.sessions.has(WING)).toBe(false);
    b.st.relay.deliver({ type: "roster", machines: [], sessions: [{ callsign: "lead@win", state: "idle" }], clients: [] } as Frame);
    expect(await b.call("other@win", "update", { callsign: "lead@win", wing: null })).toEqual(toolText("Не выполнено: lead@win — ведомого нет", true));
    expect(text(await b.call("other@win", "update", { callsign: "lead@win", wing: { model: "haiku" } }))).toBe("ведомый открыт");
    expect(b.st.kernel.sessions.has(WING)).toBe(true);
  });

  it("8111 · open с wing: пара одним вызовом — ведущий, ведомый, задача; ведомый не открылся — ведущий остаётся, задача не ушла, ответ называет слово", async () => {
    const { st, call, home, field } = await bench({ machine: "win" });
    await st.open("boss@win");
    expect(text(await call("boss@win", "open", { name: "audit", dir: home, text: "Проверь", wing: { model: "haiku" } }))).toBe("открыта: audit@win; задача во вводе, итог хода придёт сам");
    await until(() => field("audit-wing@win", "wing") === true);
    expect(field("audit-wing@win", "parent")).toBe("audit@win");
    // первым вводом может прийти весть о ведомом: ждём саму задачу
    await until(() => st.proc("audit@win").inputs.some((i) => i.message.content === task("boss@win", "Проверь")));

    const w = world({ opening: (f) => { if (f.wing_of) throw refuse("no_profile", "нет кусочка"); } });
    const b = await bench({ machine: "win", w });
    await b.st.open("boss@win");
    expect(await b.call("boss@win", "open", { name: "audit", dir: b.home, text: "Проверь", wing: { profile: ["t/p/x"] } })).toEqual(toolText("открыта: audit@win, ведомый не открыт — no_profile. нет кусочка; задача не ушла", true));
    expect(b.st.kernel.sessions.has("audit@win")).toBe(true);
    expect(b.st.kernel.sessions.has("audit-wing@win")).toBe(false);
    await later();
    expect(b.st.proc("audit@win").inputs).toHaveLength(0);
  });

  it("8112 · ведущий: list и history своего ведомого — видит его и его ленту", async () => {
    const b = await pair();
    rosterOf(b);
    const seen = await list(b, "lead@win");
    expect(seen.sessions.map((s) => s.callsign)).toEqual(["lead@win", WING]);
    expect(seen.sessions[0].pair).toMatchObject({ model: "haiku" });
    expect(b.st.relay.frames("session.history")).toHaveLength(0);
    b.st.sdk.functions = { getSessionInfo: async () => ({}), importSessionToStore: async () => {}, getSessionMessages: async () => [{ type: "user", uuid: "u1", message: { content: "Сделай" } }] };
    expect(text(await b.call("lead@win", "history", { callsign: WING }))).toBe("user: Сделай");
  });

  it("8116 · запуск ведомого: сервера инструментов и добавки нет, CLAUDE_CODE_HARBOR_KITE=0 есть; у ведущего всё на месте; после перезапуска то же", async () => {
    // источник: слово пользователя 6 нояб. «видна только сессия владельца»
    const b = await pair();
    const check = () => {
      const o = b.st.query(WING).options as { mcpServers?: Record<string, unknown>; systemPrompt?: { append?: string }; env: Record<string, string> };
      expect(o.mcpServers?.fleet).toBeUndefined();
      expect(o.systemPrompt?.append ?? "").not.toContain(prompt(WING));
      expect(o.env.CLAUDE_CODE_HARBOR_KITE).toBe("0");
    };
    check();
    const l = b.st.query("lead@win").options as { mcpServers: Record<string, unknown>; systemPrompt: { append: string } };
    expect(l.mcpServers.fleet).toMatchObject({ type: "sdk", name: "fleet" });
    expect(l.systemPrompt.append).toContain(prompt("lead@win"));
    await b.st.session("host-manage", WING)!.restart();
    await until(() => b.st.sdk.of(WING).length === 2);
    check();
  });

  it("8117 · другая сессия и ведущий: update, remove, label на адрес ведомого — pair_inside, ведомый не изменился", async () => {
    const b = await pair();
    rosterOf(b);
    const word = `Не выполнено: ${WING} — pair_inside. Это ведомый внутри пары, работать с ним можно только через его ведущего`;
    for (const me of ["other@win", "lead@win"]) {
      expect(await b.call(me, "update", { callsign: WING, model: "x" })).toEqual(toolText(word, true));
      expect(await b.call(me, "remove", { callsign: WING })).toEqual(toolText(word, true));
      expect(await b.call(me, "label", { to: WING, text: "имя" })).toEqual(toolText(word, true));
    }
    expect(b.st.kernel.sessions.has(WING)).toBe(true);
    expect(b.st.query(WING).calls.filter((c) => c.name === "setModel")).toHaveLength(0);
    expect(b.st.relay.frames("prefs.set")).toHaveLength(0);
    expect(makeFleet().tools("me@pc").map((t) => t.name)).toHaveLength(10);
  });
});
