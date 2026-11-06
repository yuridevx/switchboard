// Леса границы «чат Telegram — устройство человека», сторона Worker'а rooms. Снаружи: Bot API, gate, relay — подделки.
// Вход — привязка send и POST /webhook; исход — вызовы Bot API, кадры relay, строки базы, журнал. Номер — эталон дизайна «Переписка с человеком»; без номера — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Frame } from "@switchboard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { Rooms } from "../src/index.ts";
import type { RoomsSend, RoomsSent } from "../contract.ts";

const DB = (env as unknown as { DB: D1Database }).DB;
const MIGRATIONS = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const TOKEN = "123456789:test-token";

const ANN = 1001;
const BOB = 1002;
const CARL = 1003;
const ANON = 1087968824;
const GROUP = -100777;
const ANN_DM = "telegram~ann@x.y";
const BOB_DM = "telegram~bob@x.y";
const TEAM = "team~ann@x.y";
const SITE = "site@laptop";
const NAMES: Record<number, string> = { [ANN]: "Ann", [BOB]: "Bob" };
const INVITE = `abcd.${"s".repeat(43)}`;

type Answer = { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: unknown };
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[];
let frames: Frame[];
let deliverN: number;
let revoked: string[];
let redeems: Record<string, { key: string; addr: string; kid: string }>;
/** Ответы Bot API на метод: первый в очереди забирается, последний остаётся. */
let answers: Record<string, Answer[]>;
let nextThread: number;
let waits: Array<{ ms: number; before: number }>;
let pending: Array<Promise<unknown>>;

const fakeEnv = (over: Record<string, unknown> = {}) =>
  ({
    DB,
    TELEGRAM_BOT_TOKEN: TOKEN,
    GATE: {
      revoked: async (ids: string[]) => ids.filter((id) => revoked.includes(id)),
      redeem: async (invite: string) => redeems[invite] ?? { error: "bad_invite" },
    },
    RELAY: { deliver: async (f: Frame) => (frames.push(f), deliverN) },
    ...over,
  }) as never;
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as never;

const of = (method: string) => calls.filter((c) => c.method === method);

function telegram() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const queue = answers[method];
    if (queue?.length) return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
    if (method === "createForumTopic") return Response.json({ ok: true, result: { message_thread_id: ++nextThread } });
    return Response.json({ ok: true, result: { message_id: 500 + calls.length } });
  });
}

const secret = async () => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`webhook|${TOKEN}`));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Вебхук и работа после ответа. */
async function hook(update: unknown, o: { header?: string; env?: never } = {}) {
  const req = new Request("https://rooms.test/webhook", { method: "POST", body: JSON.stringify(update), headers: { "x-telegram-bot-api-secret-token": o.header ?? (await secret()) } });
  const r = await worker.fetch(req as never, o.env ?? fakeEnv(), ctx);
  await Promise.all(pending);
  return r;
}
const send = (push: Partial<RoomsSend> & { to: string }): Promise<RoomsSent> => new (Rooms as unknown as { new (c: unknown, e: unknown): Rooms })({ waitUntil() {} }, fakeEnv()).send({ type: "message", from: SITE, notify: { title: SITE, body: "Тесты прошли" }, ...push });

let n = 0;
const chatOf = (id: number) => (id > 0 ? { id, type: "private" } : { id, type: "supergroup", is_forum: true });
const said = (chat: number, from: number, text: string, thread?: number) => ({ message: { message_id: ++n, chat: chatOf(chat), from: { id: from, is_bot: false, first_name: NAMES[from] ?? "Гость" }, text, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) } });
const link = (chat: number, addr: string, kid: string) => DB.prepare("INSERT INTO chats (chat, addr, kid) VALUES (?, ?, ?)").bind(chat, addr, kid).run();
const row = (table: string) => DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>().then((r) => r.results);
const reactions = () => of("setMessageReaction").map((c) => (c.body.reaction as Array<{ emoji: string }>)[0].emoji);

beforeEach(async () => {
  await applyD1Migrations(DB, MIGRATIONS);
  await DB.batch(["chats", "threads"].map((t) => DB.prepare(`DELETE FROM ${t}`)));
  [calls, frames, revoked, deliverN, redeems, answers, nextThread, waits, pending] = [[], [], [], 1, {}, {}, 100, [], []];
  vi.stubGlobal("scheduler", { wait: async (ms: number) => void waits.push({ ms, before: calls.length }) });
  telegram();
});
afterEach(() => vi.unstubAllGlobals());

describe("сообщение сессии", () => {
  it("1 · первое сообщение создаёт тему с именем сессии, второе идёт в неё же", async () => {
    // источник: слово пользователя — от своего имени
    await link(ANN, ANN_DM, "k-ann");
    expect(await send({ to: ANN_DM })).toEqual({ sent: 1 });
    expect(await send({ to: ANN_DM })).toEqual({ sent: 1 });
    expect(of("createForumTopic").map((c) => c.body)).toEqual([{ chat_id: ANN, name: SITE }]);
    expect(of("sendRichMessage").map((c) => c.body)).toEqual(Array(2).fill({ chat_id: ANN, message_thread_id: 101, rich_message: { markdown: "Тесты прошли" }, disable_notification: false }));
  });

  it("чужая сессия в том же чате — своя тема", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    await send({ to: ANN_DM, from: "api@ex44" });
    expect(of("createForumTopic").map((c) => c.body.name)).toEqual([SITE, "api@ex44"]);
  });

  it("11 · адрес группы: тема в группе, сообщение без звука", async () => {
    // источник: слово пользователя — канал делят несколько людей
    await link(GROUP, TEAM, "k-team");
    expect(await send({ to: TEAM })).toEqual({ sent: 1 });
    expect(of("sendRichMessage")[0].body).toMatchObject({ chat_id: GROUP, disable_notification: true });
  });

  it("человеку ~email — только его личка, групп нет; устройства из skip — нет", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await link(GROUP, TEAM, "k-team");
    expect(await send({ to: "~ann@x.y" })).toEqual({ sent: 1 });
    expect(of("sendRichMessage").map((c) => c.body.chat_id)).toEqual([ANN]);
    expect(await send({ to: "~ann@x.y", skip: [ANN_DM] })).toEqual({ sent: 0 });
  });

  it("чата у адреса нет: sent 0 без слова, Telegram не трогается", async () => {
    expect(await send({ to: "phone~ann@x.y" })).toEqual({ sent: 0 });
    expect(calls).toEqual([]);
  });

  it("отправитель не сессия: сообщения нет", async () => {
    await link(ANN, ANN_DM, "k-ann");
    expect(await send({ to: ANN_DM, from: "@laptop" })).toEqual({ sent: 0 });
    expect(calls).toEqual([]);
  });

  it("пропуск отозван: чат и его темы удалены, сообщения нет", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    revoked = ["k-ann"];
    expect(await send({ to: ANN_DM })).toEqual({ sent: 0 });
    expect(await row("chats")).toEqual([]);
    expect(await row("threads")).toEqual([]);
  });

  it("разрешение и форма: в чате сказано, где ответить", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM, type: "question", notify: { title: "просит разрешения", body: "Bash", app: true } });
    expect(of("sendRichMessage")[0].body).toMatchObject({ rich_message: { markdown: "**просит разрешения**\n\nBash\n\nОтветить можно в пульте." } });
  });
});

describe("отказы Telegram", () => {
  it("10 · 429: rate_limited с секундами, повтора в коде нет", async () => {
    // источник: факт — 20 сообщений в минуту на группу, 21-е получило retry_after 37
    await link(GROUP, TEAM, "k-team");
    answers.sendRichMessage = [{ ok: false, error_code: 429, description: "Too Many Requests: retry after 37", parameters: { retry_after: 37 } }];
    expect(await send({ to: TEAM })).toEqual({ sent: 0, word: "rate_limited", why: "предел Telegram, повторить через 37 с" });
    expect(of("sendRichMessage")).toHaveLength(1);
  });

  it.each([
    ["not enough rights to create a topic", 400, "no_topics"],
    ["the chat is not a forum", 400, "no_topics"],
  ])("создание темы: %s → %s", async (description, error_code, word) => {
    await link(GROUP, TEAM, "k-team");
    answers.createForumTopic = [{ ok: false, error_code, description: `Bad Request: ${description}` }];
    expect(await send({ to: TEAM })).toMatchObject({ sent: 0, word });
    expect(await row("threads")).toEqual([]);
  });

  it.each([
    [403, "Forbidden: bot was kicked from the supergroup chat", "gone"],
    [413, "Request Entity Too Large", "too_long"],
    [400, "Bad Request: message is too long", "too_long"],
  ])("отказ %s %s → %s", async (error_code, description, word) => {
    // источник: факт — все три ответа сняты с настоящего Bot API 6 нояб.
    await link(GROUP, TEAM, "k-team");
    answers.sendRichMessage = [{ ok: false, error_code, description }];
    expect(await send({ to: TEAM })).toMatchObject({ sent: 0, word });
  });

  it("человек удалил тему: новая тема и одна новая попытка, сообщение не теряется", async () => {
    // источник: факт — message thread not found; вопрос и служебные сообщения повторить некому
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    answers.sendRichMessage = [{ ok: false, error_code: 400, description: "Bad Request: message thread not found" }, { ok: true, result: { message_id: 9 } }];
    expect(await send({ to: ANN_DM })).toEqual({ sent: 1 });
    expect(of("createForumTopic")).toHaveLength(2);
    expect(await row("threads")).toEqual([{ callsign: SITE, chat: ANN, thread: 102 }]);
  });

  it("новая тема тоже не принимает: отказ словом, цикла нет", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    answers.sendRichMessage = [{ ok: false, error_code: 400, description: "Bad Request: message thread not found" }];
    expect(await send({ to: ANN_DM })).toMatchObject({ sent: 0, word: "gone" });
    expect(of("createForumTopic")).toHaveLength(2);
  });
});

describe("ответ человека", () => {
  beforeEach(async () => {
    await link(ANN, ANN_DM, "k-ann");
    await link(BOB, BOB_DM, "k-bob");
    await link(GROUP, TEAM, "k-team");
    await send({ to: ANN_DM });
    await send({ to: TEAM });
    calls = [];
  });

  it("2 · ответ в теме лички: кадр сессии без id с адресом устройства и 👀", async () => {
    // источник: слово пользователя — реагировать на ответы
    expect((await hook(said(ANN, ANN, "да, только без миграции", 101))).status).toBe(200);
    expect(frames).toEqual([{ type: "rooms.message", v: 1, to: SITE, from: ANN_DM, text: "да, только без миграции" }]);
    expect(reactions()).toEqual(["👀"]);
  });

  it("13 · ответ в группе: from — адрес группы, автор отдельно: написать в from значит ответить туда же", async () => {
    await hook(said(GROUP, ANN, "вижу", 102));
    expect(frames).toEqual([{ type: "rooms.message", v: 1, to: SITE, from: TEAM, text: "вижу", author: "Ann" }]);
  });

  it("3 · двое пишут в тему: у каждого своё имя", async () => {
    // источник: слово пользователя — канал делят несколько людей
    await hook(said(GROUP, ANN, "раз", 102));
    await hook(said(GROUP, BOB, "два", 102));
    expect(frames.map((f) => f.author)).toEqual(["Ann", "Bob"]);
  });

  it("4 · гость и анонимный админ: кадра нет, на сообщении 👎", async () => {
    // источник: факт — сессия в режиме «разрешено всё»; анонимный админ приходит как GroupAnonymousBot с is_bot
    await hook(said(GROUP, CARL, "а что случилось?", 102));
    const anon = said(GROUP, ANON, "анонимно", 102);
    anon.message.from.is_bot = true;
    await hook(anon);
    expect(frames).toEqual([]);
    expect(reactions()).toEqual(["👎", "👎"]);
  });

  it("14 · реакция — после паузы и после ответа вебхуку", async () => {
    // источник: факт — без паузы и со 100 мс реакция не видна 0 из 6, от 250 мс 9 из 9, ответ ok в обоих случаях
    await worker.fetch(new Request("https://rooms.test/webhook", { method: "POST", body: JSON.stringify(said(GROUP, CARL, "гость", 102)), headers: { "x-telegram-bot-api-secret-token": await secret() } }) as never, fakeEnv(), ctx);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(waits).toEqual([{ ms: 1000, before: 0 }]);
    expect(reactions()).toEqual(["👎"]);
  });

  it("отказ реакции — строка журнала", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    answers.setMessageReaction = [{ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }];
    await hook(said(ANN, ANN, "x", 101));
    expect(lines.some((l) => l.includes('"ev":"react"') && l.includes("REACTION_INVALID"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("5 · пропуск человека отозван: кадра нет, 👎, строка удалена", async () => {
    // источник: факт — отзыв единственный выключатель человека
    revoked = ["k-bob"];
    await hook(said(GROUP, BOB, "я отозван", 102));
    expect(frames).toEqual([]);
    expect(reactions()).toEqual(["👎"]);
    expect((await row("chats")).map((r) => r.addr).sort()).toEqual([ANN_DM, TEAM].sort());
  });

  it("пропуск группы отозван: кадра нет, группа отвязана", async () => {
    revoked = ["k-team"];
    await hook(said(GROUP, ANN, "группа отозвана", 102));
    expect(frames).toEqual([]);
    expect((await row("chats")).map((r) => r.addr)).not.toContain(TEAM);
  });

  it("6 · deliver вернул 0: на сообщении 🤷", async () => {
    // источник: устав — отказ словом
    deliverN = 0;
    await hook(said(ANN, ANN, "ты тут?", 101));
    expect(reactions()).toEqual(["🤷"]);
  });

  it("General группы: бот молчит; без темы в личке — 🤷", async () => {
    await hook(said(GROUP, ANN, "разговор людей"));
    expect(calls).toEqual([]);
    expect(frames).toEqual([]);
    await hook(said(ANN, ANN, "мимо темы"));
    expect(reactions()).toEqual(["🤷"]);
  });

  it("без текста: 🤷, кадра нет", async () => {
    await hook({ message: { message_id: 9, chat: chatOf(ANN), from: { id: ANN }, message_thread_id: 101, photo: [] } });
    expect(frames).toEqual([]);
    expect(reactions()).toEqual(["🤷"]);
  });

  it("фото с подписью: подпись доходит, сессия знает, что вложения нет", async () => {
    await hook({ message: { message_id: 9, chat: chatOf(ANN), from: { id: ANN }, message_thread_id: 101, photo: [], caption: "смотри" } });
    expect(frames[0]).toMatchObject({ text: "смотри\n(вложение не передано)" });
  });
});

describe("вебхук", () => {
  it("без подписи и с чужой подписью — 401, ничего не сделано", async () => {
    expect((await hook(said(ANN, ANN, "x", 101), { header: "чужая" })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("сбой relay: 200, строка журнала и 🤷: человек видит исход, повтора нет", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    calls = [];
    const broken = fakeEnv({ RELAY: { deliver: () => { throw new Error("relay упал"); } } });
    expect((await hook(said(ANN, ANN, "x", 101), { env: broken })).status).toBe(200);
    expect(lines.some((l) => l.includes("relay упал"))).toBe(true);
    expect(reactions()).toEqual(["🤷"]);
    vi.restoreAllMocks();
  });

  it("сбой gate на кнопке: подсказка, кнопка не крутится", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    calls = [];
    const broken = fakeEnv({ GATE: { revoked: () => { throw new Error("gate упал"); } } });
    await hook({ callback_query: { id: "cb", from: { id: ANN }, data: "0:q1", message: { message_id: 7, chat: chatOf(ANN), message_thread_id: 101 } } }, { env: broken });
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Машина не на связи" });
    vi.restoreAllMocks();
  });

  it("/setup: вход токеном бота, адрес — свой, секрет — выведенный; очередь Telegram не сбрасывается", async () => {
    const setup = (auth: string) => worker.fetch(new Request("https://rooms.test/setup", { method: "POST", headers: { authorization: auth } }) as never, fakeEnv(), ctx);
    expect((await setup("Bearer чужой")).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await setup(`Bearer ${TOKEN}`)).status).toBe(200);
    expect(of("setWebhook")[0].body).toEqual({ url: "https://rooms.test/webhook", secret_token: await secret(), allowed_updates: ["message", "callback_query"] });
  });
});

describe("привязка", () => {
  it("11 · приглашение в группе с темами: чат стал устройством, пропуск не хранится", async () => {
    // источник: слово пользователя — канал делят несколько людей; факт — /start@бот с параметром дошёл целым
    redeems[INVITE] = { key: "client.team.abcd.секрет", addr: TEAM, kid: "abcd" };
    await hook(said(GROUP, ANN, `/start@switchboard_test_fleet_bot abcd_${"s".repeat(43)}`));
    expect(await row("chats")).toEqual([{ chat: GROUP, addr: TEAM, kid: "abcd" }]);
    expect(of("sendMessage")[0].body).toEqual({ chat_id: GROUP, text: `Привязано: ${TEAM}` });
  });

  it("приглашение в личке: и текстом с точкой", async () => {
    redeems[INVITE] = { key: "k", addr: ANN_DM, kid: "abcd" };
    await hook(said(ANN, ANN, INVITE));
    expect((await row("chats")).map((r) => r.addr)).toEqual([ANN_DM]);
  });

  it("группа без тем: отказ словами до приёма, приглашение не сгорает", async () => {
    // источник: факт — включение тем меняет id группы, привязка к старому id становится тупиком
    const redeem = vi.fn(async () => ({ key: "k", addr: TEAM, kid: "abcd" }));
    const u = said(GROUP, ANN, `/start abcd_${"s".repeat(43)}`);
    u.message.chat = { id: GROUP, type: "group" } as never;
    await hook(u, { env: fakeEnv({ GATE: { redeem, revoked: async () => [] } }) });
    expect(redeem).not.toHaveBeenCalled();
    expect(await row("chats")).toEqual([]);
    expect(of("sendMessage")[0].body).toMatchObject({ chat_id: GROUP, text: "Включите темы в настройках группы и отправьте приглашение снова." });
  });

  it("приглашение машины чат не принимает: 👎, строки нет", async () => {
    redeems[INVITE] = { key: "k", addr: "@laptop", kid: "abcd" };
    await hook(said(ANN, ANN, INVITE));
    expect(await row("chats")).toEqual([]);
    expect(reactions()).toEqual(["👎"]);
  });

  it("чужое приглашение: 👎, строки нет", async () => {
    await hook(said(ANN, ANN, `/start abcd_${"s".repeat(43)}`));
    expect(await row("chats")).toEqual([]);
    expect(reactions()).toEqual(["👎"]);
  });
});

describe("кнопки вопроса", () => {
  const ASK = { title: `${SITE} спрашивает`, body: "Какую базу?", tag: "toolu_01Hq", actions: [{ title: "прод" }, { title: "стенд" }] };
  const KEYBOARD = { inline_keyboard: [[{ text: "прод", callback_data: "0:toolu_01Hq" }], [{ text: "стенд", callback_data: "1:toolu_01Hq" }]] };
  const tap = (from: number, data: string, chat = ANN, thread = 101, markup: unknown = KEYBOARD) => hook({ callback_query: { id: "cb", from: { id: from }, data, message: { message_id: 55, chat: chatOf(chat), message_thread_id: thread, reply_markup: markup } } });

  async function asked(to = ANN_DM, chat = ANN) {
    await link(chat, to, "k-chat");
    await send({ to, type: "question", notify: ASK });
    const { body } = of("sendRichMessage")[0];
    calls = [];
    return body;
  }

  it("вопрос приходит кнопками со звуком, заголовок жирным; в базе нет ни вопроса, ни вариантов", async () => {
    // источник: слово пользователя — без нашего хранения
    const body = await asked();
    expect(body).toMatchObject({ rich_message: { markdown: `**${SITE} спрашивает**\n\nКакую базу?` }, disable_notification: false, reply_markup: KEYBOARD });
    const tables = (await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name NOT LIKE 'd1%'").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables.sort()).toEqual(["chats", "threads"]);
  });

  it("нажатие: подпись и номер вопроса кадром, кнопки сняты", async () => {
    await asked();
    await tap(ANN, "1:toolu_01Hq");
    expect(frames).toEqual([{ type: "rooms.message", v: 1, to: SITE, from: ANN_DM, text: "стенд", question: "toolu_01Hq" }]);
    expect(of("editMessageReplyMarkup")).toHaveLength(1);
    expect(of("answerCallbackQuery")).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb" } }]);
  });

  it("нажатие в группе: from — адрес группы", async () => {
    await asked(TEAM, GROUP);
    await link(ANN, ANN_DM, "k-ann");
    await tap(ANN, "0:toolu_01Hq", GROUP);
    expect(frames).toEqual([{ type: "rooms.message", v: 1, to: SITE, from: TEAM, text: "прод", question: "toolu_01Hq" }]);
  });

  it("чужой нажал: кадра нет, подсказка", async () => {
    await asked();
    await tap(CARL, "0:toolu_01Hq");
    expect(frames).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Нет привязки к флоту" });
  });

  it("машина не на связи: кнопки остаются, подсказка", async () => {
    await asked();
    deliverN = 0;
    await tap(ANN, "0:toolu_01Hq");
    expect(of("editMessageReplyMarkup")).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Машина не на связи" });
  });

  it.each([
    ["кнопка старого вида", "0", KEYBOARD],
    ["такой кнопки в сообщении нет", "9:toolu_01Hq", KEYBOARD],
    ["сообщение недоступно: разметки нет", "0:toolu_01Hq", null],
  ])("%s: кадра нет, подсказка", async (_n, data, markup) => {
    await asked();
    await tap(ANN, data, ANN, 101, markup);
    expect(frames).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Вопрос уже снят" });
  });
});
