import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { b64u, unb64u } from "../src/webpush.ts";
import { decrypt, fakeService, journal, sub, ua, type Ua } from "./helpers.ts";

const VAPID = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
const relay = (exports as unknown as { default: unknown }).default as { hello(): Promise<unknown>; frame(f: Frame): Promise<void> };
const home = () => env.SUBS.get(env.SUBS.idFromName("home"));

async function frame(f: Frame) {
  await relay.frame(f);
  return (await env.RELAY_LOG.take()).map((x) => {
    expect(x.name).toBe("push");
    return x.frame;
  });
}

async function subscribe(client: string, u: Ua, endpoint: string) {
  const out = await frame({ type: "push.subscribe", id: "u-" + client, to: ".push", from: client, sub: sub(u, endpoint) });
  expect(out).toEqual([{ type: "reply", id: "u-" + client, ok: true, to: client }]);
}

const NOTIFY = {
  title: "profiles@laptop спрашивает",
  body: "Какую базу мигрировать первой?",
  actions: [
    { title: "прод", frame: { type: "answer", id: "q-1", answer: "прод" } },
    { title: "стенд", frame: { type: "answer", id: "q-1", answer: "стенд" } },
  ],
};

const send = (id: string, to: string, notify: Record<string, unknown> = NOTIFY): Frame => ({
  type: "push.send",
  id,
  v: 1,
  to: ".push",
  from: "@laptop",
  push: { to, type: "question", from: "profiles@laptop", notify },
});

async function table(): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(home(), (_o, state) => state.storage.sql.exec("SELECT * FROM subs ORDER BY client").toArray());
}

const open = (u: Ua) => ({ keys: u.keys, auth: unb64u(u.auth) });

beforeEach(async () => {
  await env.RELAY_LOG.take();
  await env.RELAY_LOG.answer();
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны push", () => {
  it("5 · push.send доставлен по подписке phone: тело расшифровывается ключами телефона, ok cut: false", async () => {
    const phone = await ua();
    await subscribe("phone", phone, "https://web.push.apple.com/QK2s-5");
    const before = (await table()).find((r) => r.client === "phone");
    const svc = fakeService(201);
    const out = await frame(send("s-4", "phone"));
    expect(svc.posts).toHaveLength(1);
    expect(svc.posts[0].url).toBe("https://web.push.apple.com/QK2s-5");
    const shown = JSON.parse(await decrypt(svc.posts[0].body, open(phone)));
    expect(shown).toEqual({ type: "question", from: "profiles@laptop", notify: NOTIFY });
    expect(out).toEqual([{ type: "reply", id: "s-4", ok: true, result: { cut: false }, to: "@laptop" }]);
    expect((await table()).find((r) => r.client === "phone")).toEqual(before);
  });

  it("42 · подписка переживает перезапуск объекта push: пуш уходит по подписке, записанной до выпуска", async () => {
    const phone = await ua();
    await subscribe("phone42", phone, "https://web.push.apple.com/before-release");
    await evictDurableObject(home());
    const svc = fakeService(201);
    const out = await frame(send("s-42", "phone42"));
    expect(svc.posts.map((p) => p.url)).toEqual(["https://web.push.apple.com/before-release"]);
    expect(out[0]).toMatchObject({ id: "s-42", ok: true });
  });

  it("43 · служба ответила 410: gone, строка удалена, в журнале 410 и адрес; следующий push.send — gone без POST", async () => {
    const phone = await ua();
    await subscribe("phone43", phone, "https://web.push.apple.com/gone");
    const svc = fakeService(410);
    const log = journal();
    expect(await frame(send("s-9", "phone43"))).toEqual([{ type: "reply", id: "s-9", ok: false, error: "gone", to: "@laptop" }]);
    expect((await table()).find((r) => r.client === "phone43")).toBeUndefined();
    expect(log).toContainEqual(expect.objectContaining({ part: "push", word: "gone", status: 410, host: "web.push.apple.com" }));
    expect(svc.posts).toHaveLength(1);
    expect(await frame(send("s-10", "phone43"))).toEqual([{ type: "reply", id: "s-10", ok: false, error: "gone", to: "@laptop" }]);
    expect(svc.posts).toHaveLength(1);
  });

  it("48 · notify.body 6 000 байт: тело POST не больше 4 096 Б, в уведомлении начало текста, cut: true", async () => {
    const phone = await ua();
    await subscribe("phone48", phone, "https://fcm.googleapis.com/fcm/send/48");
    const svc = fakeService(201);
    const long = "ж".repeat(3000); // 6 000 байт UTF-8
    const out = await frame(send("s-5", "phone48", { ...NOTIFY, body: long }));
    expect(svc.posts[0].body.length).toBeLessThanOrEqual(4096);
    const shown = JSON.parse(await decrypt(svc.posts[0].body, open(phone)));
    expect(shown.notify.body.endsWith("…")).toBe(true);
    expect(long.startsWith(shown.notify.body.slice(0, -1))).toBe(true);
    expect(shown.notify.body.length).toBeGreaterThan(1500);
    expect(out).toEqual([{ type: "reply", id: "s-5", ok: true, result: { cut: true }, to: "@laptop" }]);
  });

  it("120 · подписка — по from: новая подписка phone заменяет свою строку, panel-desk пишет свою", async () => {
    const phone = await ua();
    await subscribe("phone120", phone, "https://web.push.apple.com/first");
    const svc = fakeService(201);
    await frame(send("s-120", "phone120"));
    expect(svc.posts[0].url).toBe("https://web.push.apple.com/first");
    const phone2 = await ua();
    await subscribe("phone120", phone2, "https://web.push.apple.com/second");
    const panel = await ua();
    await subscribe("panel-desk120", panel, "https://fcm.googleapis.com/fcm/send/panel");
    const mine = (await table()).filter((r) => String(r.client).endsWith("120"));
    expect(mine.map((r) => [r.client, r.endpoint])).toEqual([
      ["panel-desk120", "https://fcm.googleapis.com/fcm/send/panel"],
      ["phone120", "https://web.push.apple.com/second"],
    ]);
  });

  it("121 · служба ответила 503: push_failed, в журнале 503 и адрес, повтора нет, строка на месте", async () => {
    const phone = await ua();
    await subscribe("phone121", phone, "https://fcm.googleapis.com/fcm/send/121");
    const svc = fakeService(503);
    const log = journal();
    expect(await frame(send("s-6", "phone121"))).toEqual([{ type: "reply", id: "s-6", ok: false, error: "push_failed", to: "@laptop" }]);
    expect(svc.posts).toHaveLength(1);
    expect(log).toContainEqual(expect.objectContaining({ word: "push_failed", status: 503, host: "fcm.googleapis.com" }));
    expect((await table()).find((r) => r.client === "phone121")).toBeTruthy();
  });

  it("122 · hello() — ровно три запроса push", async () => {
    expect(await relay.hello()).toEqual({ contract: { "push.key": 1, "push.send": 1, "push.subscribe": 1 } });
  });

  it("123 · POST службе: aes128gcm, TTL, vapid t=…, k=…; JWT проверяется открытым ключом, aud — origin, срок ≤ суток", async () => {
    const phone = await ua();
    await subscribe("phone123", phone, "https://push.example/sub/123");
    const svc = fakeService(201);
    const now = Date.now();
    await frame(send("s-123", "phone123"));
    const h = svc.posts[0].headers;
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("ttl")).toBe("86400");
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.get("authorization") ?? "");
    expect(m).not.toBeNull();
    const [jwt, k] = [m![1], m![2]];
    const [head, body, sig] = jwt.split(".");
    const pub = await crypto.subtle.importKey("raw", unb64u(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), new TextEncoder().encode(`${head}.${body}`));
    expect(good).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(unb64u(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(unb64u(body)));
    expect(claims.aud).toBe("https://push.example");
    expect(claims.exp * 1000 - now).toBeLessThanOrEqual(86400 * 1000);
    expect(claims.exp * 1000).toBeGreaterThan(now);
    expect(JSON.parse(await decrypt(svc.posts[0].body, open(phone))).type).toBe("question");
  });

  it("124 · push.key — несжатая точка P-256 из x и y JWK; настройки VAPID_PUBLIC нет", async () => {
    const out = await frame({ type: "push.key", id: "k-1", to: ".push", from: "phone" });
    const key = unb64u((out[0] as unknown as { result: { key: string } }).result.key);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    expect(b64u(key.slice(1, 33))).toBe(VAPID.x);
    expect(b64u(key.slice(33))).toBe(VAPID.y);
    expect(out[0]).toMatchObject({ type: "reply", id: "k-1", ok: true, to: "phone" });
    expect("VAPID_PUBLIC" in env).toBe(false);
  });
});

describe("push: отказы и стык с relay", () => {
  it("подписка без ключей — bad_frame, прежняя строка клиента не тронута, причина в журнале", async () => {
    const tab = await ua();
    await subscribe("tab", tab, "https://web.push.apple.com/tab");
    const log = journal();
    const out = await frame({ type: "push.subscribe", id: "u-2", to: ".push", from: "tab", sub: { endpoint: "https://x.example/1" } });
    expect(out).toEqual([{ type: "reply", id: "u-2", ok: false, error: "bad_frame", to: "tab" }]);
    expect((await table()).find((r) => r.client === "tab")?.endpoint).toBe("https://web.push.apple.com/tab");
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "в подписке нет ключей", from: "tab" }));
  });

  it("у клиента нет подписки — gone, службу не зовёт", async () => {
    const svc = fakeService(201);
    expect(await frame(send("s-7", "tablet"))).toEqual([{ type: "reply", id: "s-7", ok: false, error: "gone", to: "@laptop" }]);
    expect(svc.posts).toHaveLength(0);
  });

  it("push.send без push — bad_frame; чужое имя — unknown_request; другая версия — contract_mismatch", async () => {
    expect(await frame({ type: "push.send", id: "b-1", to: ".push", from: "@pc" })).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect(await frame({ type: "push.drop", id: "b-2", to: ".push", from: "@pc" })).toMatchObject([{ ok: false, error: "unknown_request" }]);
    expect(await frame({ ...send("b-3", "phone"), v: 2 })).toMatchObject([{ ok: false, error: "contract_mismatch" }]);
  });

  it("служба не ответила (сеть) — push_failed с причиной в журнале", async () => {
    const phone = await ua();
    await subscribe("phone-net", phone, "https://push.example/net");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const log = journal();
    expect(await frame(send("s-n", "phone-net"))).toMatchObject([{ ok: false, error: "push_failed" }]);
    expect(log.some((l) => l.word === "push_failed" && String(l.why).includes("connection reset"))).toBe(true);
  });

  it("relay отказал ответу push словом — строка в журнале push", async () => {
    await env.RELAY_LOG.answer("offline");
    const log = journal();
    await relay.frame({ type: "push.key", id: "k-9", to: ".push", from: "phone-gone" });
    expect(log).toContainEqual(expect.objectContaining({ part: "push", ev: "relay", word: "offline", to: "phone-gone" }));
  });

  it("кадр без id — push отвечать некому, кадров в relay нет", async () => {
    expect(await frame({ type: "push.key", to: ".push", from: "phone" })).toEqual([]);
  });
});
