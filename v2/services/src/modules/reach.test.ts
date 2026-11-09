import { describe, expect, it } from "vitest";
import { type DeviceRow, sha256hex } from "@sb/protocol";
import { b64u } from "./webpush.ts";
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

describe("связь с людьми: Telegram", () => {
  const TG = { TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_BOT: "sb_bot" };
  const calls = (s: Stand) => s.seen.net.map((n) => [n.url.split("/").pop(), JSON.parse(String(n.init!.body))] as [string, Record<string, unknown>]);
  const hook = async (s: Stand, message: object, secret?: string) =>
    s.http("/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret ?? (await sha256hex("webhook|123:token")) }, body: JSON.stringify({ message }) });

  it("код привязки делает чат устройством; уведомление идёт в тему сессии; ответ из темы уходит сессии кадром message", async () => {
    const s = stand(undefined, { env: TG });
    s.state.net = (url) => Response.json({ ok: true, result: url.endsWith("/createForumTopic") ? { message_thread_id: 77 } : {} });
    const { code, bot } = (await s.ask("reach.telegram", {}, "kanya1")).result as { code: string; bot: string };
    expect(bot).toBe("sb_bot");
    expect((await hook(s, { message_id: 1, chat: { id: 500 }, from: { id: 9 }, text: `/start ${code}` })).status).toBe(200);
    expect(await devices(s)).toMatchObject([{ kind: "telegram", person: "~anya@example.com", kid: "kanya1" }]);
    expect(calls(s)[0]).toEqual(["sendMessage", { chat_id: 500, text: "Привязано: ~anya@example.com" }]);
    // код одноразовый
    await hook(s, { message_id: 2, chat: { id: 600 }, from: { id: 10 }, text: code });
    expect(await devices(s)).toHaveLength(1);

    s.seen.net.length = 0;
    expect((await s.ask("reach.send", NOTE, "klaptop")).result).toEqual({ sent: 1, online: false });
    expect(calls(s)).toEqual([
      ["createForumTopic", { chat_id: 500, name: "site@laptop" }],
      ["sendMessage", { chat_id: 500, text: "site@laptop спрашивает\n\nКакую ветку выкладывать?", message_thread_id: 77 }],
    ]);

    await hook(s, { message_id: 3, chat: { id: 500 }, message_thread_id: 77, from: { id: 9 }, text: "main" });
    expect(s.seen.delivered).toMatchObject([{ type: "message", to: "site@laptop", from: "telegram~anya@example.com", text: "main" }]);
    // сообщение вне темы сессии никуда не уходит
    await hook(s, { message_id: 4, chat: { id: 500 }, from: { id: 9 }, text: "просто так" });
    expect(s.seen.delivered).toHaveLength(1);
  });

  it("вебхук без секрета — 401; бот не подключён — код не выдаётся", async () => {
    const s = stand(undefined, { env: TG });
    expect((await hook(s, { message_id: 1, chat: { id: 1 }, text: "x" }, "wrong")).status).toBe(401);
    expect(await stand().ask("reach.telegram", {}, "kanya1")).toMatchObject({ ok: false, error: "no_telegram" });
  });
});
