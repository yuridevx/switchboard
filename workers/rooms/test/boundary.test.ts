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
const GROUP = -100777;
const ANN_DM = "telegram~ann@x.y";
const BOB_DM = "telegram~bob@x.y";
const TEAM = "team~ann@x.y";
const SITE = "site@laptop";

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[];
let frames: Frame[];
let deliverN: number;
let revoked: string[];
let redeems: Record<string, { key: string } | { error: string }>;
let answers: Record<string, { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: unknown }>;
let nextThread: number;
let waits: Array<{ ms: number; before: number }>;

const fakeEnv = () =>
  ({
    DB,
    TELEGRAM_BOT_TOKEN: TOKEN,
    GATE: {
      revoked: async (ids: string[]) => ids.filter((id) => revoked.includes(id)),
      redeem: async (invite: string) => redeems[invite] ?? { error: "bad_invite" },
      verify: async (key: string) => ({ role: "client", name: key.split(".")[1], kid: key.split(".")[2], addr: key.split(".").slice(3).join(".").replaceAll("_", "@").replace("!", "~") }),
    },
    RELAY: { deliver: async (f: Frame) => (frames.push(f), deliverN) },
  }) as never;

const of = (method: string) => calls.filter((c) => c.method === method);

function telegram() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const set = answers[method];
    if (set) return Response.json(set);
    if (method === "createForumTopic") return Response.json({ ok: true, result: { message_thread_id: ++nextThread } });
    return Response.json({ ok: true, result: { message_id: 500 + calls.length } });
  });
}

const secret = async () => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`webhook|${TOKEN}`));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
};

async function hook(update: unknown, header?: string) {
  const req = new Request("https://rooms.test/webhook", { method: "POST", body: JSON.stringify(update), headers: { "x-telegram-bot-api-secret-token": header ?? (await secret()) } });
  return worker.fetch(req as never, fakeEnv());
}
const send = (push: Partial<RoomsSend> & { to: string }): Promise<RoomsSent> => new (Rooms as unknown as { new (c: unknown, e: unknown): Rooms })({ waitUntil() {} }, fakeEnv()).send({ type: "message", from: SITE, notify: { title: SITE, body: "Тесты прошли" }, ...push });

let n = 0;
const NAMES: Record<number, string> = { [ANN]: "Ann", [BOB]: "Bob" };
const said = (chat: number, from: number, text: string, thread?: number, type = chat > 0 ? "private" : "supergroup") => ({ message: { message_id: ++n, chat: { id: chat, type }, from: { id: from, first_name: NAMES[from] }, text, ...(thread ? { message_thread_id: thread } : {}) } });
const link = (chat: number, addr: string, kid: string) => DB.prepare("INSERT INTO chats (chat, addr, kid, at) VALUES (?, ?, ?, 0)").bind(chat, addr, kid).run();
const row = (table: string) => DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>().then((r) => r.results);
const reactions = () => of("setMessageReaction").map((c) => (c.body.reaction as Array<{ emoji: string }>)[0].emoji);

beforeEach(async () => {
  await applyD1Migrations(DB, MIGRATIONS);
  await DB.batch(["chats", "threads", "asks"].map((t) => DB.prepare(`DELETE FROM ${t}`)));
  [calls, frames, revoked, deliverN, redeems, answers, nextThread] = [[], [], [], 1, {}, {}, 100];
  waits = [];
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
});

describe("отказы Telegram", () => {
  it("10 · 429: rate_limited с секундами, повтора в коде нет", async () => {
    // источник: факт — 20 сообщений в минуту на группу, 21-е получило retry_after 37
    await link(GROUP, TEAM, "k-team");
    answers.sendRichMessage = { ok: false, error_code: 429, description: "Too Many Requests: retry after 37", parameters: { retry_after: 37 } };
    expect(await send({ to: TEAM })).toEqual({ sent: 0, word: "rate_limited", why: "предел Telegram, повторить через 37 с" });
    expect(of("sendRichMessage")).toHaveLength(1);
  });

  it.each([
    ["not enough rights to create a topic", 400, "no_topics"],
    ["the chat is not a forum", 400, "no_topics"],
  ])("создание темы: %s → %s", async (description, error_code, word) => {
    await link(GROUP, TEAM, "k-team");
    answers.createForumTopic = { ok: false, error_code, description: `Bad Request: ${description}` };
    expect(await send({ to: TEAM })).toMatchObject({ sent: 0, word });
    expect(await row("threads")).toEqual([]);
  });

  it("бота убрали: gone; длинный текст: too_long", async () => {
    await link(GROUP, TEAM, "k-team");
    answers.sendRichMessage = { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" };
    expect(await send({ to: TEAM })).toMatchObject({ sent: 0, word: "gone" });
    answers.sendRichMessage = { ok: false, error_code: 413, description: "Request Entity Too Large" };
    expect(await send({ to: TEAM })).toMatchObject({ sent: 0, word: "too_long" });
  });

  it("человек удалил тему: отказ gone, строка темы удалена, следующее сообщение создаёт новую", async () => {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    answers.sendRichMessage = { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    expect(await send({ to: ANN_DM })).toMatchObject({ sent: 0, word: "gone" });
    expect(await row("threads")).toEqual([]);
    delete answers.sendRichMessage;
    expect(await send({ to: ANN_DM })).toEqual({ sent: 1 });
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

  it("13 · ответ в группе: from — адрес группы, автор в тексте: написать в from значит ответить туда же", async () => {
    await hook(said(GROUP, ANN, "вижу", 102));
    expect(frames[0]).toMatchObject({ from: TEAM, text: "Ann: вижу" });
  });

  it("3 · двое пишут в тему: два автора, порядок сохранён", async () => {
    // источник: слово пользователя — канал делят несколько людей
    await hook(said(GROUP, ANN, "раз", 102));
    await hook(said(GROUP, BOB, "два", 102));
    expect(frames.map((f) => f.text)).toEqual(["Ann: раз", "Bob: два"]);
  });

  it("4 · гость и анонимный админ: кадра нет, на сообщении 👎", async () => {
    // источник: факт — сессия в режиме «разрешено всё»; анонимный админ приходит как GroupAnonymousBot
    await hook(said(GROUP, CARL, "а что случилось?", 102));
    await hook(said(GROUP, 1087968824, "анонимно", 102));
    expect(frames).toEqual([]);
    expect(reactions()).toEqual(["👎", "👎"]);
  });

  it("бот в группе: кадра нет", async () => {
    const u = said(GROUP, ANN, "я бот", 102);
    (u.message.from as { is_bot?: boolean }).is_bot = true;
    await hook(u);
    expect(frames).toEqual([]);
  });

  it("14 · реакция — после паузы: мгновенную Telegram молча теряет", async () => {
    // источник: факт — без паузы видна 0 из 3, с паузой 400 мс 2 из 2, ответ ok в обоих случаях
    await hook(said(GROUP, CARL, "гость", 102));
    expect(waits).toEqual([{ ms: 1000, before: 0 }]);
    expect(reactions()).toEqual(["👎"]);
  });

  it("отказ реакции — строка журнала", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    answers.setMessageReaction = { ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" };
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
    await hook({ message: { message_id: 9, chat: { id: ANN, type: "private" }, from: { id: ANN }, message_thread_id: 101, photo: [] } });
    expect(frames).toEqual([]);
    expect(reactions()).toEqual(["🤷"]);
  });
});

describe("вебхук", () => {
  it("без подписи и с чужой подписью — 401, ничего не сделано", async () => {
    expect((await hook(said(ANN, ANN, "x", 101), "чужая")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("ошибка внутри: 200, строка журнала: повтор Telegram дал бы двойной ввод", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    const env = fakeEnv() as unknown as { RELAY: { deliver(): never } };
    env.RELAY.deliver = () => {
      throw new Error("relay упал");
    };
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM });
    const req = new Request("https://rooms.test/webhook", { method: "POST", body: JSON.stringify(said(ANN, ANN, "x", 101)), headers: { "x-telegram-bot-api-secret-token": await secret() } });
    expect((await worker.fetch(req as never, env as never)).status).toBe(200);
    expect(lines.some((l) => l.includes("relay упал"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("/setup: вход токеном бота, адрес — свой, секрет — выведенный, типы — message и callback_query", async () => {
    const setup = (auth: string) => worker.fetch(new Request("https://rooms.test/setup", { method: "POST", headers: { authorization: auth } }) as never, fakeEnv());
    expect((await setup("Bearer чужой")).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await setup(`Bearer ${TOKEN}`)).status).toBe(200);
    expect(of("setWebhook")[0].body).toEqual({ url: "https://rooms.test/webhook", secret_token: await secret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  });
});

describe("привязка", () => {
  it("11 · приглашение в группе: чат стал устройством с адресом пропуска, пропуск не хранится", async () => {
    // источник: слово пользователя — канал делят несколько людей; факт — /start@бот с параметром дошёл целым
    const invite = `abcd.${"s".repeat(43)}`;
    redeems[invite] = { key: "client.team.abcd.team!ann_x.y" };
    await hook(said(GROUP, ANN, `/start@switchboard_test_fleet_bot abcd_${"s".repeat(43)}`));
    expect((await row("chats")).map(({ chat, addr, kid }) => ({ chat, addr, kid }))).toEqual([{ chat: GROUP, addr: TEAM, kid: "abcd" }]);
    expect(JSON.stringify(await row("chats"))).not.toContain("client.team");
    expect(of("sendMessage")[0].body).toEqual({ chat_id: GROUP, text: `Привязано: ${TEAM}` });
  });

  it("приглашение в личке: и командой, и текстом с точкой", async () => {
    const invite = `abcd.${"s".repeat(43)}`;
    redeems[invite] = { key: "client.telegram.abcd.telegram!ann_x.y" };
    await hook(said(ANN, ANN, invite));
    expect((await row("chats")).map((r) => r.addr)).toEqual([ANN_DM]);
  });

  it("чужое приглашение: 👎, строки нет", async () => {
    await hook(said(ANN, ANN, `/start abcd_${"s".repeat(43)}`));
    expect(await row("chats")).toEqual([]);
    expect(reactions()).toEqual(["👎"]);
  });
});

describe("кнопки вопроса", () => {
  const ASK = { title: `${SITE} спрашивает`, body: "Какую базу?", actions: [{ title: "прод", frame: { type: "answer", v: 1, callsign: SITE, question: "q1", answers: { "Какую базу?": "прод" } } }, { title: "стенд", frame: { type: "answer", v: 1, callsign: SITE, question: "q1", answers: { "Какую базу?": "стенд" } } }] };
  const tap = (from: number, data: string, message: number, thread = 101) => hook({ callback_query: { id: "cb", from: { id: from }, data, message: { message_id: message, chat: { id: ANN, type: "private" }, message_thread_id: thread } } });

  async function asked() {
    await link(ANN, ANN_DM, "k-ann");
    await send({ to: ANN_DM, type: "question", notify: ASK });
    const body = of("sendRichMessage")[0].body;
    const message = (await row("asks"))[0].message as number;
    calls = [];
    return { body, message };
  }

  it("вопрос приходит кнопками со звуком, заголовок жирным", async () => {
    const { body } = await asked();
    expect(body).toMatchObject({ rich_message: { markdown: `**${SITE} спрашивает**\n\nКакую базу?` }, disable_notification: false, reply_markup: { inline_keyboard: [[{ text: "прод", callback_data: "0" }], [{ text: "стенд", callback_data: "1" }]] } });
  });

  it("нажатие: кадр спросившего как есть с адресом устройства, кнопки сняты, строка удалена", async () => {
    const { message } = await asked();
    await tap(ANN, "1", message);
    expect(frames).toEqual([expect.objectContaining({ ...ASK.actions[1].frame, to: SITE, from: ANN_DM, id: expect.any(String) })]);
    expect(of("editMessageReplyMarkup")).toHaveLength(1);
    expect(of("answerCallbackQuery")).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb" } }]);
    expect(await row("asks")).toEqual([]);
  });

  it("чужой нажал: кадра нет, подсказка", async () => {
    const { message } = await asked();
    await tap(CARL, "0", message);
    expect(frames).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Нет привязки к флоту" });
  });

  it("машина не на связи: кнопки остаются, подсказка", async () => {
    const { message } = await asked();
    deliverN = 0;
    await tap(ANN, "0", message);
    expect(await row("asks")).toHaveLength(1);
    expect(of("editMessageReplyMarkup")).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Машина не на связи" });
  });

  it("второе нажатие: вопрос уже снят", async () => {
    const { message } = await asked();
    await tap(ANN, "0", message);
    frames = [];
    calls = [];
    await tap(ANN, "0", message);
    expect(frames).toEqual([]);
    expect(of("answerCallbackQuery")[0].body).toEqual({ callback_query_id: "cb", text: "Вопрос уже снят" });
  });
});
