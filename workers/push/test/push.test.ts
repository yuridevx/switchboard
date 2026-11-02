import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { b64u, unb64u } from "../src/webpush.ts";
import { decrypt, fakeService, journal, sub, ua, type Ua } from "./helpers.ts";

const VAPID = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
const relay = (exports as unknown as { default: unknown }).default as { hello(): Promise<unknown>; frame(f: Frame): Promise<Frame[]> };
const DB = (env as unknown as { DB: D1Database }).DB;
beforeAll(() => applyD1Migrations(DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS));

/** Кадр на вход по привязке; ответ — кадры вызывающему. */
const frame = (f: Frame) => relay.frame(f);

async function subscribe(client: string, u: Ua, endpoint: string) {
  const out = await frame({ type: "push.subscribe", v: 1, id: "u-" + client, to: ".push", from: client, sub: sub(u, endpoint) });
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
  return (await DB.prepare("SELECT * FROM subs ORDER BY client").all<Record<string, unknown>>()).results;
}

const open = (u: Ua) => ({ keys: u.keys, auth: unb64u(u.auth) });

afterEach(() => vi.restoreAllMocks());

describe("эталоны push", () => {
  it("5 · 123 · push.send доставлен по подписке phone: aes128gcm, TTL, vapid t=…, k=…; тело расшифровывается ключами телефона, ok cut: false; текста в журнале нет", async () => {
    const phone = await ua();
    await subscribe("phone", phone, "https://web.push.apple.com/QK2s-5");
    const before = (await table()).find((r) => r.client === "phone");
    const svc = fakeService(201);
    const log = journal();
    const now = Date.now();
    const out = await frame(send("s-4", "phone"));
    expect(svc.posts).toHaveLength(1);
    expect(svc.posts[0].url).toBe("https://web.push.apple.com/QK2s-5");
    const shown = JSON.parse(await decrypt(svc.posts[0].body, open(phone)));
    expect(shown).toEqual({ type: "question", from: "profiles@laptop", notify: NOTIFY });
    expect(out).toEqual([{ type: "reply", id: "s-4", ok: true, result: { cut: false }, to: "@laptop" }]);
    expect((await table()).find((r) => r.client === "phone")).toEqual(before);
    // заголовки службе: aes128gcm, TTL сутки, срочность, VAPID — JWT проверяется открытым ключом, aud — origin, срок ≤ суток
    const h = svc.posts[0].headers;
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("ttl")).toBe("86400");
    expect(h.get("urgency")).toBe("high");
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.get("authorization") ?? "");
    expect(m).not.toBeNull();
    const [jwt, k] = [m![1], m![2]];
    const [head, body, sig] = jwt.split(".");
    const pub = await crypto.subtle.importKey("raw", unb64u(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), new TextEncoder().encode(`${head}.${body}`))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(unb64u(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(unb64u(body)));
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.exp * 1000 - now).toBeLessThanOrEqual(86400 * 1000);
    expect(claims.exp * 1000).toBeGreaterThan(now);
    // журнал: строка sent, без текста уведомления и ключей подписки
    expect(log).toContainEqual(expect.objectContaining({ part: "push", kind: "note", ev: "sent", client: "phone", status: 201 }));
    const text = JSON.stringify(log);
    expect(text).not.toContain(NOTIFY.body);
    expect(text).not.toContain(phone.auth);
  });

  it("42 · подписка — в базе D1 push: пуш уходит по подписке, записанной до выпуска", async () => {
    const phone = await ua();
    await subscribe("phone42", phone, "https://web.push.apple.com/before-release");
    const svc = fakeService(201);
    const out = await frame(send("s-42", "phone42"));
    expect(svc.posts.map((p) => p.url)).toEqual(["https://web.push.apple.com/before-release"]);
    expect(out[0]).toMatchObject({ id: "s-42", ok: true });
  });

  it("5063 · push.subscribe через вход — строка устройства с номером пропуска; номер отозван — один gate.revoked, строка удалена, gone; живой — ушёл", async () => {
    const a = await ua();
    const b = await ua();
    // номер пропуска приходит от обёртки входа полем kid; стенд gate считает отозванным секрет «revoked» и номера из revoke
    await frame({ type: "push.subscribe", v: 1, id: "s1", to: ".push", from: "tab~a@b", fromKid: "t1ab", sub: sub(a, "https://fcm.googleapis.com/send/tab") });
    await frame({ type: "push.subscribe", v: 1, id: "s2", to: ".push", from: "pad~a@b", fromKid: "p4ad", sub: sub(b, "https://fcm.googleapis.com/send/pad") });
    expect((await table()).filter((r) => String(r.client).endsWith("~a@b")).map((r) => [r.client, r.kid])).toEqual([["pad~a@b", "p4ad"], ["tab~a@b", "t1ab"]]);
    await (env as unknown as { GATE: { revoke(k: string): Promise<unknown> } }).GATE.revoke("t1ab");
    const svc = fakeService(201);
    const out = await frame({ type: "push.send", id: "x", v: 1, to: ".push", from: "@laptop", push: { to: "~a@b", type: "question", notify: NOTIFY } });
    expect(svc.posts.map((p) => p.url)).toEqual(["https://fcm.googleapis.com/send/pad"]);
    expect(out[0]).toMatchObject({ ok: true });
    expect((await table()).map((r) => r.client)).not.toContain("tab~a@b");
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

  it("120 · подписка — по from: новая подписка phone заменяет свою строку, panel-desk пишет свою; в журнале хост без ключей", async () => {
    const phone = await ua();
    const log = journal();
    await subscribe("phone120", phone, "https://web.push.apple.com/first");
    expect(log).toContainEqual(expect.objectContaining({ part: "push", ev: "subscribe", client: "phone120", host: "web.push.apple.com" }));
    expect(JSON.stringify(log)).not.toContain(phone.p256dh);
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

  it("124 · push.key — несжатая точка P-256 из x и y JWK; настройки VAPID_PUBLIC нет", async () => {
    const out = await frame({ type: "push.key", v: 1, id: "k-1", to: ".push", from: "phone" });
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
  it("2019 · подписка не по контракту — bad_frame, прежняя строка клиента не тронута, причина в журнале", async () => {
    const tab = await ua();
    await subscribe("tab", tab, "https://web.push.apple.com/tab");
    const log = journal();
    const good = sub(tab, "https://x.example/1");
    const bad: Array<[unknown, string]> = [
      [undefined, "нет sub"],
      [{ ...good, endpoint: "http://x.example/1" }, "в подписке нет https-адреса"],
      [{ endpoint: "https://x.example/1" }, "в подписке нет ключей"],
      [{ ...good, keys: { ...good.keys, p256dh: b64u(new Uint8Array(33)) } }, "p256dh — не точка P-256 в 65 Б"],
      [{ ...good, keys: { ...good.keys, auth: b64u(new Uint8Array(8)) } }, "auth — не 16 Б"],
      [{ ...good, keys: { ...good.keys, auth: "!!!" } }, "ключи подписки — не base64url"],
    ];
    for (const [s, why] of bad) {
      const out = await frame({ type: "push.subscribe", v: 1, id: "u-2", to: ".push", from: "tab", sub: s });
      expect(out, why).toEqual([{ type: "reply", id: "u-2", ok: false, error: "bad_frame", to: "tab" }]);
      expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", why, from: "tab" }));
    }
    expect((await table()).find((r) => r.client === "tab")?.endpoint).toBe("https://web.push.apple.com/tab");
    // без from — имя клиента некому поставить
    await relay.frame({ type: "push.subscribe", v: 1, id: "u-3", to: ".push", sub: good });
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "нет from — имя клиента ставит relay" }));
  });

  it("у клиента нет подписки — gone, службу не зовёт", async () => {
    const svc = fakeService(201);
    expect(await frame(send("s-7", "tablet"))).toEqual([{ type: "reply", id: "s-7", ok: false, error: "gone", to: "@laptop" }]);
    expect(svc.posts).toHaveLength(0);
  });

  it("2016 · вход отклонён: чужое имя — unknown_request, другая версия — contract_mismatch, reply — только строка note", async () => {
    const log = journal();
    expect(await frame({ type: "push.drop", id: "b-2", to: ".push", from: "@pc" })).toEqual([{ type: "reply", id: "b-2", ok: false, error: "unknown_request", to: "@pc" }]);
    expect(await frame({ ...send("b-3", "phone"), v: 2 })).toEqual([{ type: "reply", id: "b-3", ok: false, error: "contract_mismatch", to: "@laptop" }]);
    expect(await frame({ type: "reply", id: "x", ok: true, to: ".push", from: "@pc" })).toEqual([]);
    expect(log.map((l) => [l.kind, l.word ?? l.ev])).toEqual([
      ["refuse", "unknown_request"],
      ["refuse", "contract_mismatch"],
      ["note", "reply"],
    ]);
  });

  it("2018 · push.send не по контракту или не влезает и без body — bad_frame, службу не зовёт", async () => {
    const phone = await ua();
    await subscribe("phone2018", phone, "https://push.example/2018");
    const svc = fakeService(201);
    const bad: Frame[] = [
      { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc" },
      { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { type: "question", notify: {} } },
      { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { to: "phone2018", notify: {} } },
      { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { to: "phone2018", type: "question" } },
      { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { to: "phone2018", skip: "pult", type: "question", notify: {} } },
      send("b-1", "phone2018", { title: "x".repeat(5000) }),
    ];
    for (const f of bad) expect(await frame(f)).toMatchObject([{ id: "b-1", ok: false, error: "bad_frame" }]);
    expect(svc.posts).toHaveLength(0);
  });

  it("служба не ответила (сеть) — push_failed с причиной в журнале", async () => {
    const phone = await ua();
    await subscribe("phone-net", phone, "https://push.example/net");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const log = journal();
    expect(await frame(send("s-n", "phone-net"))).toMatchObject([{ ok: false, error: "push_failed" }]);
    expect(log.some((l) => l.word === "push_failed" && String(l.why).includes("connection reset"))).toBe(true);
  });

  it("5185 · пуш службе — с пределом: fetch к endpoint идёт с сигналом отмены", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит; отчёт слепого архитектора 2 нояб.: п. 8 — внешний fetch без предела
    const phone = await ua();
    await subscribe("phone-5185", phone, "https://push.example/5185");
    const signals: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => (signals.push(init?.signal), new Response(null, { status: 201 })));
    expect(await frame(send("s-5185", "phone-5185"))).toMatchObject([{ ok: true }]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("2083 · адрес человека: пуш каждой его подписке, кроме skip; ответ ok", async () => {
    // источник: слово пользователя 2 нояб. «пушить всем» — сообщение на ~email пушем доходит до каждого подписанного устройства не на связи
    const [pult, phone, laptop, other] = await Promise.all([ua(), ua(), ua(), ua()]);
    await subscribe("pult~yuri2083@example.com", pult, "https://push.example/2083-pult");
    await subscribe("phone~yuri2083@example.com", phone, "https://push.example/2083-phone");
    await subscribe("laptop~yuri2083@example.com", laptop, "https://push.example/2083-laptop");
    await subscribe("phone~anna2083@example.com", other, "https://push.example/2083-anna");
    const svc = fakeService(201);
    const f = send("s-2083", "~yuri2083@example.com");
    const out = await frame({ ...f, push: { ...(f.push as object), skip: ["pult~yuri2083@example.com"] } });
    expect(svc.posts.map((p) => p.url).sort()).toEqual(["https://push.example/2083-laptop", "https://push.example/2083-phone"]);
    expect(out).toEqual([{ type: "reply", id: "s-2083", ok: true, result: { cut: false }, to: "@laptop" }]);
  });

  it("2084 · адрес человека без его подписок или все его подписки в skip — gone, чужому устройству пуша нет", async () => {
    // источник: чьё: код (отказ gone, когда подписки нет); слово пользователя «пуш уходит только устройству не на связи»
    await subscribe("phone~anna2084@example.com", await ua(), "https://push.example/2084-anna");
    await subscribe("pult~olga2084@example.com", await ua(), "https://push.example/2084-olga");
    const svc = fakeService(201);
    expect(await frame(send("s-2084", "~yuri2084@example.com"))).toMatchObject([{ id: "s-2084", ok: false, error: "gone" }]);
    const f = send("s-2084b", "~olga2084@example.com");
    expect(await frame({ ...f, push: { ...(f.push as object), skip: ["pult~olga2084@example.com"] } })).toMatchObject([{ id: "s-2084b", ok: false, error: "gone" }]);
    expect(svc.posts).toHaveLength(0);
  });

  it("2086 · адрес человека: исход по каждому устройству — строка журнала на каждое; ok, если ушёл хоть одному; иначе push_failed", async () => {
    // источник: слово пользователя 2 нояб. «пушить всем»; чьё: код (404/410 — строка подписки удаляется; push_failed — отказ службы)
    await subscribe("phone~yuri2086@example.com", await ua(), "https://push.example/2086-phone");
    await subscribe("tab~yuri2086@example.com", await ua(), "https://push.example/2086-tab");
    const statuses: Record<string, number> = { "https://push.example/2086-phone": 201, "https://push.example/2086-tab": 410 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => new Response(null, { status: statuses[new Request(input).url] }));
    const log = journal();
    expect(await frame(send("s-2086", "~yuri2086@example.com"))).toEqual([{ type: "reply", id: "s-2086", ok: true, result: { cut: false }, to: "@laptop" }]);
    expect(log).toContainEqual(expect.objectContaining({ ev: "sent", client: "phone~yuri2086@example.com", status: 201 }));
    expect(log).toContainEqual(expect.objectContaining({ word: "gone", client: "tab~yuri2086@example.com", status: 410 }));
    expect((await table()).some((r) => r.client === "tab~yuri2086@example.com")).toBe(false);
    // осталась одна подписка, служба отказала — push_failed
    statuses["https://push.example/2086-phone"] = 503;
    expect(await frame(send("s-2086b", "~yuri2086@example.com"))).toMatchObject([{ id: "s-2086b", ok: false, error: "push_failed" }]);
  });

  it("2088 · адрес человека: одному 503, другому 410 — push_failed, а не gone; строка 410 удалена", async () => {
    // источник: чьё: код (отказ службы не выдаётся за «подписки нет»: host-push пишет gone без остановки)
    await subscribe("phone~yuri2088@example.com", await ua(), "https://push.example/2088-phone");
    await subscribe("tab~yuri2088@example.com", await ua(), "https://push.example/2088-tab");
    const statuses: Record<string, number> = { "https://push.example/2088-phone": 503, "https://push.example/2088-tab": 410 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => new Response(null, { status: statuses[new Request(input).url] }));
    expect(await frame(send("s-2088", "~yuri2088@example.com"))).toMatchObject([{ id: "s-2088", ok: false, error: "push_failed" }]);
    expect((await table()).some((r) => r.client === "tab~yuri2088@example.com")).toBe(false);
  });

  it("2096 · запрос без v — contract_mismatch, как у ядра Host", async () => {
    // источник: чьё: код (protocol accepts — v обязателен)
    expect(await frame({ type: "push.key", id: "k-2096", to: ".push", from: "phone" })).toMatchObject([{ id: "k-2096", ok: false, error: "contract_mismatch" }]);
  });

  it("кадр без id — push отвечать некому, кадров в relay нет", async () => {
    expect(await frame({ type: "push.key", v: 1, to: ".push", from: "phone" })).toEqual([]);
  });
});
