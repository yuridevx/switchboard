import { describe, expect, it } from "vitest";
import { type DeviceRow, sha256hex } from "@sb/protocol";
import { b64u, encrypt, unb64u } from "./reach/webpush.ts";
import { type Stand, stand } from "../../test/stand.ts";

/** Ключ VAPID флота — JWK строкой. */
async function vapidKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** Подписка браузера: точка P-256 и 16 байт auth. */
async function subscription(endpoint = "https://push.example/sub/1") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  return { kind: "webpush", endpoint, p256dh, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

const NOTE = { to: "~anya@example.com", title: "site@laptop спрашивает", text: "Какую ветку выкладывать?", callsign: "site@laptop", kind: "ask" };
const devices = async (s: Stand, as = "kanya1") => ((await s.ask("reach.devices", {}, as)).result as { devices: DeviceRow[] }).devices;

describe("связь с людьми: веб-пуш", () => {
  it("человека нет на связи — один зашифрованный пуш на его подписку", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    await s.ask("reach.subscribe", await subscription(), "kanya1");
    expect(await devices(s)).toMatchObject([{ kind: "webpush", person: "~anya@example.com", kid: "kanya1" }]);
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 1, online: false });
    expect(s.seen.net).toHaveLength(1);
    const { url, init } = s.seen.net[0]!;
    expect(url).toBe("https://push.example/sub/1");
    const headers = init!.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    // тело зашифровано: текста уведомления в нём нет
    expect(new TextDecoder().decode(init!.body as Uint8Array)).not.toContain("ветку");
  });

  it("человек на связи — запрос принят, уведомление не ушло; force — ушло", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    await s.ask("reach.subscribe", await subscription(), "kanya1");
    s.state.online.add("~anya@example.com");
    expect(await s.ask("reach.send", NOTE, "klaptop")).toMatchObject({ ok: true, result: { sent: 0, online: true } });
    expect(s.seen.net).toHaveLength(0);
    expect((await s.ask("reach.send", { ...NOTE, force: true }, "klaptop")).result).toEqual({ sent: 1, online: true });
  });

  it("служба пушей ответила «подписки нет» — устройство убрано; чужому человеку пуш не идёт", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    await s.ask("reach.subscribe", await subscription(), "kanya1");
    expect((await s.ask("reach.send", { ...NOTE, to: "~oleg@example.com" }, "klaptop")).result).toEqual({ sent: 0, online: false });
    expect(s.seen.net).toHaveLength(0);
    s.state.net = () => new Response(null, { status: 410 });
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 0, online: false });
    expect(await devices(s)).toHaveLength(0);
  });

  it("пропуск отозван — подписка не получает и убирается", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    await s.ask("reach.subscribe", await subscription(), "kanya1");
    s.state.dead.add("kanya1");
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 0, online: false });
    expect(s.seen.net).toHaveLength(0);
    s.state.dead.clear();
    expect(await devices(s)).toHaveLength(0);
  });

  it("ключ веб-пуша отдаётся странице; не задан — отказ словом; своё устройство убирается, чужое — нет", async () => {
    const off = stand();
    expect(await off.ask("reach.key")).toMatchObject({ ok: false, error: "no_vapid" });
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    expect(((await s.ask("reach.key")).result as { key: string }).key).toMatch(/^[\w-]{80,}$/);
    const { id } = (await s.ask("reach.subscribe", await subscription(), "kanya1")).result as { id: string };
    expect(await s.ask("reach.subscribe", { ...(await subscription()), auth: "короткий" }, "kanya1")).toMatchObject({ ok: false, error: "bad_input" });
    expect(await s.ask("reach.remove", { device: id }, "koleg1")).toMatchObject({ ok: false, error: "not_found" });
    expect(await s.ask("reach.remove", { device: id }, "kanya1")).toMatchObject({ ok: true });
    expect(await devices(s)).toHaveLength(0);
  });
});

describe("связь с людьми: шифрование по стандарту", () => {
  it("тело пуша совпадает с примером RFC 8291 на его ключах и соли", async () => {
    // источник: RFC 8291, раздел 5 — ключи получателя и отправителя, секрет, соль и готовое тело
    const text = "When I grow up, I want to be a watermelon";
    const uaPublic = unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const auth = unb64u("BTBZMqHH6r4Tts7J_aSIgg");
    const asPublic = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u(asPublic.slice(1, 33)), y: b64u(asPublic.slice(33)) };
    const P256 = { name: "ECDH", namedCurve: "P-256" };
    const own = {
      privateKey: await crypto.subtle.importKey("jwk", jwk, P256, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("raw", asPublic, P256, true, []),
    } as CryptoKeyPair;
    const body = await encrypt(new TextEncoder().encode(text), uaPublic, auth, { own, salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw") });
    expect(b64u(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("связь с людьми: Telegram", () => {
  const TOKEN = "123:token";
  type Call = [string, Record<string, unknown>];
  const calls = (s: Stand): Call[] => s.seen.net.map((n) => [n.url.split("/").pop()!, JSON.parse(String(n.init!.body))]);

  /** Флот с подключённым ботом. forum — есть ли в чатах темы; сообщения бота получают номера по порядку. */
  async function withBot(forum = true) {
    const s = stand();
    let msg = 100;
    s.state.net = (url) => {
      const method = url.split("/").pop();
      if (method === "getMe") return Response.json({ ok: true, result: { username: "sb_bot" } });
      if (method === "createForumTopic") return forum ? Response.json({ ok: true, result: { message_thread_id: 77 } }) : Response.json({ ok: false, error_code: 400, description: "Bad Request: the chat is not a forum" });
      if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: ++msg } });
      return Response.json({ ok: true, result: {} });
    };
    expect(await s.ask("reach.bot", { token: TOKEN })).toMatchObject({ ok: true, result: { bot: "sb_bot", on: true } });
    return s;
  }
  const hook = async (s: Stand, update: object, secret?: string, fleet = s.fleet) =>
    s.http("/telegram/" + fleet, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret ?? (await sha256hex("webhook|" + TOKEN)) }, body: JSON.stringify(update) });
  /** Привязать чат кодом человека. */
  async function link(s: Stand, chat: object, user: number, as = "kanya1") {
    const { code } = (await s.ask("reach.telegram", {}, as)).result as { code: string };
    await hook(s, { message: { message_id: 1, chat, from: { id: user }, text: `/start ${code}` } });
    return code;
  }

  it("бот у флота свой: токен проверяется, вебхук ставится на адрес этого флота; подключает только админ", async () => {
    const s = stand();
    expect(await s.ask("reach.bot", {})).toMatchObject({ result: { on: false } });
    expect(await s.ask("reach.bot", { token: TOKEN }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    s.state.net = (url) => Response.json(url.endsWith("/getMe") ? { ok: true, result: { username: "sb_bot" } } : { ok: true, result: {} });
    expect(await s.ask("reach.bot", { token: TOKEN })).toMatchObject({ result: { bot: "sb_bot", on: true } });
    expect(calls(s)).toEqual([
      ["getMe", {}],
      ["setWebhook", { url: `https://fleet.test/telegram/${s.fleet}`, secret_token: await sha256hex("webhook|" + TOKEN), allowed_updates: ["message", "callback_query"] }],
    ]);
    expect(await s.ask("reach.bot", {}, "kyura1")).toMatchObject({ result: { bot: "sb_bot", on: true } });
    // Telegram не принял токен — бот не подключён
    const bad = stand();
    bad.state.net = () => Response.json({ ok: false, description: "Unauthorized" });
    expect(await bad.ask("reach.bot", { token: "нет" })).toMatchObject({ ok: false, error: "bad_token" });
    expect(await bad.ask("reach.telegram", {}, "kanya1")).toMatchObject({ ok: false, error: "no_telegram" });
    // отключение
    expect(await s.ask("reach.bot", { token: null })).toMatchObject({ result: { on: false } });
    expect((await hook(s, { message: { message_id: 1, chat: { id: 1 }, text: "x" } })).status).toBe(404);
  });

  it("код привязки делает чат устройством; уведомление идёт в тему сессии; ответ из темы уходит сессии кадром message", async () => {
    const s = await withBot();
    const code = await link(s, { id: 500 }, 9);
    expect(await devices(s)).toMatchObject([{ kind: "telegram", person: "~anya@example.com", kid: "kanya1" }]);
    expect(calls(s).at(-1)).toEqual(["sendMessage", { chat_id: 500, text: "Привязано: ~anya@example.com" }]);
    // код одноразовый
    await hook(s, { message: { message_id: 2, chat: { id: 600 }, from: { id: 10 }, text: code } });
    expect(await devices(s)).toHaveLength(1);

    s.seen.net.length = 0;
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 1, online: false });
    expect(calls(s)).toEqual([
      ["createForumTopic", { chat_id: 500, name: "site@laptop" }],
      ["sendMessage", { chat_id: 500, text: "site@laptop спрашивает\n\nКакую ветку выкладывать?", message_thread_id: 77 }],
    ]);

    await hook(s, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(s.seen.delivered).toMatchObject([{ type: "message", to: "site@laptop", from: "telegram~anya@example.com", text: "main" }]);
    // сообщение вне темы сессии никуда не уходит
    await hook(s, { message: { message_id: 4, chat: { id: 500 }, from: { id: 9 }, text: "просто так" } });
    expect(s.seen.delivered).toHaveLength(1);
  });

  it("чат одного флота другому флоту не известен: общей записи нет", async () => {
    const a = await withBot(), b = await withBot();
    await link(a, { id: 500 }, 9);
    await a.ask("reach.send", NOTE, "klaptop");
    // тот же чат и та же тема приходят на адрес другого флота: там такого чата нет
    await hook(b, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(b.seen.delivered).toHaveLength(0);
    await hook(a, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(a.seen.delivered).toHaveLength(1);
    // код чужого флота не принимается
    const { code } = (await a.ask("reach.telegram", {}, "kanya1")).result as { code: string };
    await hook(b, { message: { message_id: 5, chat: { id: 700 }, from: { id: 11 }, text: code } });
    expect(await devices(b)).toHaveLength(0);
  });

  it("вопрос уходит с кнопками вариантов; нажатая кнопка — кадр answer сессии; кнопки снимаются", async () => {
    const s = await withBot();
    await link(s, { id: 500 }, 9);
    s.seen.net.length = 0;
    await s.ask("reach.send", { ...NOTE, ask: "q-9", options: ["main", "release/2.4"] }, "klaptop");
    const sent = calls(s).find(([m]) => m === "sendMessage")![1];
    expect(sent.reply_markup).toEqual({ inline_keyboard: [[{ text: "main", callback_data: "0:q-9" }], [{ text: "release/2.4", callback_data: "1:q-9" }]] });
    const message = { message_id: 101, chat: { id: 500 }, message_thread_id: 77, reply_markup: sent.reply_markup };
    s.seen.net.length = 0;
    await hook(s, { callback_query: { id: "cb1", from: { id: 9 }, data: "1:q-9", message } });
    expect(s.seen.delivered).toMatchObject([{ type: "answer", to: "site@laptop", from: "telegram~anya@example.com", ask: "q-9", answer: "release/2.4" }]);
    expect(calls(s)).toEqual([
      ["answerCallbackQuery", { callback_query_id: "cb1" }],
      ["editMessageReplyMarkup", { chat_id: 500, message_id: 101, reply_markup: { inline_keyboard: [] } }],
    ]);
    // на вопрос уже ответили со страницы: человек видит это, кнопки снимаются
    s.state.answer = (f) => ({ type: "reply", id: f.id!, ok: false, error: "already_answered" });
    s.seen.net.length = 0;
    await hook(s, { callback_query: { id: "cb2", from: { id: 9 }, data: "0:q-9", message } });
    expect(calls(s)[0]).toEqual(["answerCallbackQuery", { callback_query_id: "cb2", text: "На вопрос уже ответили" }]);
    // кнопка от того, кто не привязан
    s.seen.net.length = 0;
    await hook(s, { callback_query: { id: "cb3", from: { id: 666 }, data: "0:q-9", message: { ...message, chat: { id: -900 } } } });
    expect(calls(s)).toEqual([["answerCallbackQuery", { callback_query_id: "cb3", text: "Нет привязки к флоту" }]]);
  });

  it("личный чат без тем: сообщение идёт с позывным, ответ на него уходит той же сессии", async () => {
    const s = await withBot(false);
    await link(s, { id: 500 }, 9);
    s.seen.net.length = 0;
    await s.ask("reach.send", NOTE, "klaptop");
    expect(calls(s).at(-1)).toEqual(["sendMessage", { chat_id: 500, text: "site@laptop · site@laptop спрашивает\n\nКакую ветку выкладывать?" }]);
    await hook(s, { message: { message_id: 5, chat: { id: 500 }, from: { id: 9 }, text: "main", reply_to_message: { message_id: 102 } } });
    expect(s.seen.delivered).toMatchObject([{ type: "message", to: "site@laptop", text: "main" }]);
  });

  it("группа без тем отказывается до приёма кода — код не сгорает; в группе с темами говорит только привязанный", async () => {
    const s = await withBot();
    const { code } = (await s.ask("reach.telegram", {}, "kanya1")).result as { code: string };
    s.seen.net.length = 0;
    await hook(s, { message: { message_id: 1, chat: { id: -700, type: "supergroup" }, from: { id: 9 }, text: code } });
    expect(calls(s)).toEqual([["sendMessage", { chat_id: -700, text: "Включите темы в настройках группы и отправьте код снова." }]]);
    expect(await devices(s)).toHaveLength(0);
    // тот же код принимается группой с темами
    await hook(s, { message: { message_id: 2, chat: { id: -800, type: "supergroup", is_forum: true }, from: { id: 9, first_name: "Аня" }, text: code } });
    expect(await devices(s)).toMatchObject([{ kind: "telegram", label: "Telegram · группа" }]);
    await s.ask("reach.send", NOTE, "klaptop");
    // чужой в теме сессии: реакция отказа, сессии ничего не уходит
    s.seen.net.length = 0;
    await hook(s, { message: { message_id: 3, chat: { id: -800 }, message_thread_id: 77, from: { id: 10, first_name: "Гость" }, text: "выкладывай" } });
    expect(s.seen.delivered).toHaveLength(0);
    expect(calls(s)).toEqual([["setMessageReaction", { chat_id: -800, message_id: 3, reaction: [{ type: "emoji", emoji: "👎" }] }]]);
    // привязавший — доходит, с именем автора
    await hook(s, { message: { message_id: 4, chat: { id: -800 }, message_thread_id: 77, from: { id: 9, first_name: "Аня" }, text: "main" } });
    expect(s.seen.delivered).toMatchObject([{ type: "message", to: "site@laptop", from: "telegram~anya@example.com", text: "Аня: main" }]);
    // General в группе — разговор людей: бот молчит
    s.seen.net.length = 0;
    await hook(s, { message: { message_id: 5, chat: { id: -800 }, from: { id: 10 }, text: "привет всем" } });
    expect(calls(s)).toEqual([]);
  });

  it("вебхук без секрета — 401; пропуск отозван — чат больше не говорит с флотом", async () => {
    const s = await withBot();
    expect((await hook(s, { message: { message_id: 1, chat: { id: 1 }, text: "x" } }, "wrong")).status).toBe(401);
    await link(s, { id: 500 }, 9);
    await s.ask("reach.send", NOTE, "klaptop");
    s.state.dead.add("kanya1");
    s.seen.net.length = 0;
    await hook(s, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(s.seen.delivered).toHaveLength(0);
    // человек видит отказ: реакция на его сообщение
    expect(calls(s)).toEqual([["setMessageReaction", { chat_id: 500, message_id: 3, reaction: [{ type: "emoji", emoji: "👎" }] }]]);
  });

  // устав: «система ловит» — отказать, записать причину
  it("код привязки не принят — чужого флота или уже использованный: устройства нет, на сообщение реакция 👎", async () => {
    const s = await withBot();
    const code = await link(s, { id: 500 }, 9);
    s.seen.net.length = 0;
    // использованный код из другого чата и код чужого флота
    await hook(s, { message: { message_id: 7, chat: { id: 600 }, from: { id: 10 }, text: code } });
    await hook(s, { message: { message_id: 8, chat: { id: 600 }, from: { id: 10 }, text: code.replace(s.fleet, "otherfleet") } });
    expect(await devices(s)).toHaveLength(1);
    expect(await devices(s, "koleg1")).toHaveLength(0);
    expect(calls(s)).toEqual([
      ["setMessageReaction", { chat_id: 600, message_id: 7, reaction: [{ type: "emoji", emoji: "👎" }] }],
      ["setMessageReaction", { chat_id: 600, message_id: 8, reaction: [{ type: "emoji", emoji: "👎" }] }],
    ]);
  });

  // устав: ожидаемая ветка «соединение с машиной оборвалось»; чьё: код — «всегда 200: повтор доставки дал бы двойной ввод»
  it("машина сессии не на связи: вебхук отвечает 200, на сообщение человека реакция 🤷", async () => {
    const s = await withBot();
    await link(s, { id: 500 }, 9);
    await s.ask("reach.send", NOTE, "klaptop");
    s.state.answer = (f) => ({ type: "reply", id: f.id!, ok: false, error: "offline" });
    s.seen.net.length = 0;
    const res = await hook(s, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(res.status).toBe(200);
    expect(calls(s)).toEqual([["setMessageReaction", { chat_id: 500, message_id: 3, reaction: [{ type: "emoji", emoji: "🤷" }] }]]);
  });

  // чьё: код
  it("чат Telegram убран из устройств: его нет в списке, сообщение из прежней темы сессии никуда не уходит", async () => {
    const s = await withBot();
    await link(s, { id: 500 }, 9);
    await s.ask("reach.send", NOTE, "klaptop");
    const [dev] = await devices(s);
    expect(await s.ask("reach.remove", { device: dev!.id }, "kanya1")).toMatchObject({ ok: true });
    expect(await devices(s)).toHaveLength(0);
    await hook(s, { message: { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" } });
    expect(s.seen.delivered).toHaveLength(0);
  });

  // устав: «система ловит» — отказать, записать причину
  it("бот заблокирован в чате (403): уведомление не ушло — sent 0, чат убран из устройств", async () => {
    const s = await withBot();
    await link(s, { id: 500 }, 9);
    const before = s.state.net;
    s.state.net = (url, init) => (url.endsWith("/sendMessage") ? Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }) : before(url, init));
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 0, online: false });
    expect(await devices(s)).toHaveLength(0);
  });

  // чьё: код
  it("админ убирает чужое устройство: у владельца его больше нет", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapidKey() } });
    const { id } = (await s.ask("reach.subscribe", await subscription(), "kanya1")).result as { id: string };
    expect(await s.ask("reach.remove", { device: id }, "kyura1")).toMatchObject({ ok: true });
    expect(await devices(s, "kanya1")).toHaveLength(0);
  });
});
