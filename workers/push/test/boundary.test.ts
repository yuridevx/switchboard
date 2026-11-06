// Леса границы «уведомление доходит до человека», сторона Worker'а push. Снаружи: gate (стенд), служба пушей (подделка fetch).
// Вход — кадр по привязке и POST с пропуском; исход — ответ, POST службе, строка таблицы подписок, журнал. Номер — эталон-источник; без пометки — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";

const worker = (exports as unknown as { default: unknown }).default as { fetch(r: Request): Promise<Response>; frame(f: Frame): Promise<Frame[]> };
const DB = (env as unknown as { DB: D1Database }).DB;
const GATE = (env as unknown as { GATE: { revoke(k: string): Promise<unknown> } }).GATE;
const VAPID = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
beforeAll(() => applyD1Migrations(DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

const enc = new TextEncoder();
const dec = new TextDecoder();
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const join = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const ECDH = { name: "ECDH", namedCurve: "P-256" };

type Ua = { keys: CryptoKeyPair; p256dh: string; auth: string };

/** Браузер: ключи подписки. */
async function ua(): Promise<Ua> {
  const keys = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return { keys, p256dh: b64u(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Браузер: расшифровка тела aes128gcm по RFC 8291. Сама сверена с примером RFC в отдельном тесте. */
async function decrypt(body: Uint8Array, keys: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const as = await crypto.subtle.importKey("raw", asPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as } as never, keys.privateKey, 256));
  const ikm = await hkdf(auth, shared, join(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, body.slice(21 + idlen)));
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("нет разделителя последней записи");
  return dec.decode(plain.slice(0, end));
}

type Post = { url: string; headers: Headers; body: Uint8Array; signal: unknown };

/** Служба пушей: статус по адресу или один на все; каждый POST записан. */
function service(status: number | Record<string, number>) {
  const posts: Post[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    posts.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()), signal: init?.signal });
    return new Response(null, { status: typeof status === "number" ? status : status[req.url] });
  });
  return posts;
}

function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(JSON.parse(String(s))));
  return lines;
}

const sub = (u: Ua, endpoint: string) => ({ endpoint, keys: { p256dh: u.p256dh, auth: u.auth } });

async function subscribe(client: string, u: Ua, endpoint: string) {
  expect(await worker.frame({ type: "push.subscribe", v: 1, id: `u-${client}`, to: ".push", from: client, sub: sub(u, endpoint) })).toEqual([{ type: "reply", id: `u-${client}`, ok: true, to: client }]);
}

const NOTIFY = {
  title: "profiles@laptop спрашивает",
  body: "Какую базу мигрировать первой?",
  actions: [
    { title: "прод", frame: { type: "answer", id: "q-1", answer: "прод" } },
    { title: "стенд", frame: { type: "answer", id: "q-1", answer: "стенд" } },
  ],
};

const send = (id: string, to: string, notify: Record<string, unknown> = NOTIFY, skip?: string[]): Frame => ({
  type: "push.send",
  id,
  v: 1,
  to: ".push",
  from: "@laptop",
  push: { to, ...(skip ? { skip } : {}), type: "question", from: "profiles@laptop", notify },
});

const rows = async () => (await DB.prepare("SELECT * FROM subs ORDER BY client").all<Record<string, unknown>>()).results;
const row = async (client: string) => (await rows()).find((r) => r.client === client);

describe("push.key", () => {
  it("124 · открытый ключ — несжатая точка P-256 из JWK", async () => {
    const out = await worker.frame({ type: "push.key", v: 1, id: "k-1", to: ".push", from: "phone" });
    const key = unb64u((out[0] as unknown as { result: { key: string } }).result.key);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    expect(b64u(key.slice(1, 33))).toBe(VAPID.x);
    expect(b64u(key.slice(33))).toBe(VAPID.y);
    expect(out[0]).toMatchObject({ type: "reply", id: "k-1", ok: true, to: "phone" });
  });
});

describe("push.subscribed", () => {
  const asked = async (client: string, endpoint: unknown, fromKid?: string) => {
    const [r] = await worker.frame({ type: "push.subscribed", v: 1, id: "q", to: ".push", from: client, endpoint, ...(fromKid ? { fromKid } : {}) });
    return r as unknown as { ok: boolean; error?: string; result?: { subscribed: boolean } };
  };
  it("есть строка этого устройства и этого пропуска: другой адрес, другой клиент, сменившийся пропуск — нет", async () => {
    const endpoint = "https://web.push.apple.com/asked";
    await worker.frame({ type: "push.subscribe", v: 1, id: "u", to: ".push", from: "phone-q", fromKid: "kid1", sub: sub(await ua(), endpoint) });
    expect((await asked("phone-q", endpoint, "kid1")).result).toEqual({ subscribed: true });
    expect((await asked("phone-q", "https://web.push.apple.com/other", "kid1")).result).toEqual({ subscribed: false });
    expect((await asked("desk-q", endpoint, "kid1")).result).toEqual({ subscribed: false });
    expect((await asked("phone-q", endpoint, "kid2")).result).toEqual({ subscribed: false });
    expect(await asked("phone-q", 7, "kid1")).toMatchObject({ ok: false, error: "bad_frame" });
  });
});

describe("push.subscribe", () => {
  it("120 · строка на устройство: новая подписка заменяет свою, другое устройство пишет свою; в журнале адрес службы без ключей", async () => {
    const log = journal();
    const first = await ua();
    await subscribe("phone120", first, "https://web.push.apple.com/first");
    expect(log).toContainEqual(expect.objectContaining({ part: "push", kind: "note", ev: "subscribe", client: "phone120", host: "web.push.apple.com" }));
    expect(JSON.stringify(log)).not.toContain(first.p256dh);
    const second = await ua();
    await worker.frame({ type: "push.subscribe", v: 1, id: "u-120", to: ".push", from: "phone120", fromKid: "n2ew", sub: sub(second, "https://web.push.apple.com/second") });
    expect(await row("phone120")).toMatchObject({ endpoint: "https://web.push.apple.com/second", kid: "n2ew", p256dh: second.p256dh, auth: second.auth });
    await subscribe("desk120", await ua(), "https://fcm.googleapis.com/fcm/send/desk");
    expect((await rows()).filter((r) => String(r.client).endsWith("120")).map((r) => [r.client, r.endpoint])).toEqual([
      ["desk120", "https://fcm.googleapis.com/fcm/send/desk"],
      ["phone120", "https://web.push.apple.com/second"],
    ]);
  });

  it("прямой вход: POST с пропуском — клиент и номер из пропуска, from из тела не берётся; ответ телом", async () => {
    const u = await ua();
    const r = await worker.fetch(new Request("https://push.test/", { method: "POST", body: JSON.stringify({ type: "push.subscribe", v: 1, id: "p-1", from: "чужой~x@y", key: "client.pad.k7dz.secret", sub: sub(u, "https://push.example/pad") }) }));
    expect(await r.json()).toMatchObject({ type: "reply", id: "p-1", ok: true });
    expect(await row("pad~test@example.com")).toMatchObject({ endpoint: "https://push.example/pad", kid: "k7dz" });
    expect(await row("чужой~x@y")).toBeUndefined();
  });

  it("2019 · подписка не по контракту — bad_frame с причиной в журнале, прежняя строка не тронута", async () => {
    const tab = await ua();
    await subscribe("tab", tab, "https://web.push.apple.com/tab");
    const log = journal();
    const good = sub(tab, "https://x.example/1");
    const bad: Array<[unknown, string]> = [
      [undefined, "нет sub"],
      // 7301: https:// без узла — на отправке провалил бы весь пуш на ~email
      [{ ...good, endpoint: "https://" }, "в подписке нет https-адреса"],
      [{ ...good, endpoint: "http://x.example/1" }, "в подписке нет https-адреса"],
      [{ endpoint: "https://x.example/1" }, "в подписке нет ключей"],
      [{ ...good, keys: { ...good.keys, p256dh: b64u(new Uint8Array(33)) } }, "p256dh — не точка P-256 в 65 Б"],
      [{ ...good, keys: { ...good.keys, auth: b64u(new Uint8Array(8)) } }, "auth — не 16 Б"],
      [{ ...good, keys: { ...good.keys, auth: "!!!" } }, "ключи подписки — не base64url"],
      // длина 4n + 1: разрешённые знаки, но base64 такой длины не бывает
      [{ ...good, keys: { ...good.keys, auth: "AAAAA" } }, "ключи подписки — не base64url"],
    ];
    for (const [s, why] of bad) {
      expect(await worker.frame({ type: "push.subscribe", v: 1, id: "u-2", to: ".push", from: "tab", sub: s }), why).toEqual([{ type: "reply", id: "u-2", ok: false, error: "bad_frame", to: "tab" }]);
      expect(log).toContainEqual(expect.objectContaining({ part: "push", kind: "refuse", ev: "push.subscribe", word: "bad_frame", why, from: "tab" }));
    }
    expect((await row("tab"))?.endpoint).toBe("https://web.push.apple.com/tab");
    await worker.frame({ type: "push.subscribe", v: 1, id: "u-3", to: ".push", sub: good });
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "нет from — имя клиента ставит relay" }));
  });

  it("ключи браузера с заполнением «=»: подписка принята, тело пуша расшифровывается", async () => {
    const u = await ua();
    const padded = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
    await subscribe("phone-pad", { ...u, p256dh: padded(u.p256dh), auth: padded(u.auth) }, "https://push.example/pad-keys");
    const posts = service(201);
    expect(await worker.frame(send("s-pad", "phone-pad"))).toMatchObject([{ ok: true }]);
    expect(JSON.parse(await decrypt(posts[0].body, u.keys, unb64u(u.auth)))).toMatchObject({ notify: NOTIFY });
  });
});

describe("push.send устройству", () => {
  it("расшифровка стенда верна: пример RFC 8291, приложение A", async () => {
    const uaPublic = unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const body = unb64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
    const jwk = { kty: "EC", crv: "P-256", x: b64u(uaPublic.slice(1, 33)), y: b64u(uaPublic.slice(33)), d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94" };
    const keys = {
      privateKey: await crypto.subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("raw", uaPublic, ECDH, true, []),
    } as CryptoKeyPair;
    expect(await decrypt(body, keys, unb64u("BTBZMqHH6r4Tts7J_aSIgg"))).toBe("When I grow up, I want to be a watermelon");
  });

  it("5 · 42 · 123 · пуш по записанной подписке: тело расшифровывается ключами телефона; заголовки службе; строка на месте; текста и ключей в журнале нет", async () => {
    const phone = await ua();
    await subscribe("phone", phone, "https://web.push.apple.com/QK2s-5");
    const before = await row("phone");
    const posts = service(201);
    const log = journal();
    const now = Date.now();
    const out = await worker.frame(send("s-4", "phone"));
    expect(out).toEqual([{ type: "reply", id: "s-4", ok: true, to: "@laptop" }]);
    expect(posts.map((p) => p.url)).toEqual(["https://web.push.apple.com/QK2s-5"]);
    // 5185 · пуш службе — с пределом: fetch идёт с сигналом отмены
    expect(posts[0].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(await decrypt(posts[0].body, phone.keys, unb64u(phone.auth)))).toEqual({ type: "question", from: "profiles@laptop", notify: NOTIFY });
    expect(await row("phone")).toEqual(before);
    const h = posts[0].headers;
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("ttl")).toBe("86400");
    expect(h.get("urgency")).toBe("high");
    expect(posts[0].body.slice(16, 20)).toEqual(new Uint8Array([0, 0, 16, 0]));
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.get("authorization") ?? "")!;
    expect(m).not.toBeNull();
    const [head, body, sig] = m[1].split(".");
    const pub = await crypto.subtle.importKey("raw", unb64u(m[2]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), enc.encode(`${head}.${body}`))).toBe(true);
    expect(JSON.parse(dec.decode(unb64u(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(dec.decode(unb64u(body)));
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe(env.VAPID_SUB);
    expect(claims.exp * 1000 - now).toBeLessThanOrEqual(86400 * 1000);
    expect(claims.exp * 1000).toBeGreaterThan(now);
    expect(log).toContainEqual(expect.objectContaining({ part: "push", kind: "note", ev: "sent", from: "@laptop", client: "phone", type: "question", status: 201, host: "web.push.apple.com", cut: false }));
    expect(log.find((l) => l.ev === "sent")!.bytes).toBe(posts[0].body.length);
    const text = JSON.stringify(log);
    expect(text).not.toContain(NOTIFY.body);
    expect(text).not.toContain(phone.auth);
  });

  it("48 · длинный текст, кириллица 6 000 байт: тело службе не больше 4 096 Б и заполнено до предела, начало текста и «…», cut: true в журнале", async () => {
    const long = "ж".repeat(3000);
    const phone = await ua();
    await subscribe("phone48", phone, "https://fcm.googleapis.com/fcm/send/48");
    const posts = service(201);
    const log = journal();
    const out = await worker.frame(send("s-5", "phone48", { ...NOTIFY, body: long }));
    expect(posts[0].body.length).toBeLessThanOrEqual(4096);
    expect(posts[0].body.length).toBeGreaterThan(4096 - 8);
    const shown = JSON.parse(await decrypt(posts[0].body, phone.keys, unb64u(phone.auth)));
    expect(shown.notify.body.endsWith("…")).toBe(true);
    expect(long.startsWith(shown.notify.body.slice(0, -1))).toBe(true);
    expect(out).toEqual([{ type: "reply", id: "s-5", ok: true, to: "@laptop" }]);
    expect(log).toContainEqual(expect.objectContaining({ ev: "sent", cut: true }));
  });

  it("43 · служба ответила 410 или 404: gone, строка удалена, в журнале статус и адрес; следующий пуш — gone без POST", async () => {
    for (const status of [410, 404]) {
      const c = `phone-gone${status}`;
      await subscribe(c, await ua(), "https://web.push.apple.com/gone");
      const posts = service(status);
      const log = journal();
      expect(await worker.frame(send("s-9", c))).toEqual([{ type: "reply", id: "s-9", ok: false, error: "gone", to: "@laptop" }]);
      expect(await row(c)).toBeUndefined();
      expect(log).toContainEqual(expect.objectContaining({ part: "push", kind: "refuse", ev: "push.send", word: "gone", why: `служба ответила ${status}: подписки нет, строка удалена`, client: c, status, host: "web.push.apple.com" }));
      expect(await worker.frame(send("s-10", c))).toEqual([{ type: "reply", id: "s-10", ok: false, error: "gone", to: "@laptop" }]);
      expect(log).toContainEqual(expect.objectContaining({ word: "gone", why: "подписки нет", client: c, type: "question" }));
      expect(posts).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });

  it("121 · служба ответила 503: push_failed, в журнале статус и адрес, повтора нет, строка на месте", async () => {
    await subscribe("phone121", await ua(), "https://fcm.googleapis.com/fcm/send/121");
    const posts = service(503);
    const log = journal();
    expect(await worker.frame(send("s-6", "phone121"))).toEqual([{ type: "reply", id: "s-6", ok: false, error: "push_failed", to: "@laptop" }]);
    expect(posts).toHaveLength(1);
    expect(log).toContainEqual(expect.objectContaining({ word: "push_failed", why: "служба ответила 503", status: 503, host: "fcm.googleapis.com" }));
    expect(await row("phone121")).toBeTruthy();
  });

  it("служба не ответила: push_failed, причина в журнале", async () => {
    await subscribe("phone-net", await ua(), "https://push.example/net");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const log = journal();
    expect(await worker.frame(send("s-n", "phone-net"))).toMatchObject([{ ok: false, error: "push_failed" }]);
    expect(log.some((l) => l.word === "push_failed" && String(l.why).startsWith("служба не ответила: ") && String(l.why).includes("connection reset") && l.client === "phone-net" && l.host === "push.example")).toBe(true);
  });

  it("5063 · номер пропуска подписки отозван: один разбор — строка удалена, пуш живым; все отозваны — gone", async () => {
    const [a, b] = await Promise.all([ua(), ua()]);
    await worker.frame({ type: "push.subscribe", v: 1, id: "s1", to: ".push", from: "tab~a@b", fromKid: "t1ab", sub: sub(a, "https://fcm.googleapis.com/send/tab") });
    await worker.frame({ type: "push.subscribe", v: 1, id: "s2", to: ".push", from: "pad~a@b", fromKid: "p4ad", sub: sub(b, "https://fcm.googleapis.com/send/pad") });
    await GATE.revoke("t1ab");
    const posts = service(201);
    const log = journal();
    expect(await worker.frame({ type: "push.send", id: "x", v: 1, to: ".push", from: "@laptop", push: { to: "~a@b", type: "question", notify: NOTIFY } })).toMatchObject([{ ok: true }]);
    expect(posts.map((p) => p.url)).toEqual(["https://fcm.googleapis.com/send/pad"]);
    expect(await row("tab~a@b")).toBeUndefined();
    expect(await row("pad~a@b")).toBeTruthy();
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", word: "gone", why: "пропуск t1ab отозван: подписка удалена", client: "tab~a@b", type: "question" }));
    await GATE.revoke("p4ad");
    expect(await worker.frame(send("y", "pad~a@b"))).toMatchObject([{ ok: false, error: "gone" }]);
    expect(posts).toHaveLength(1);
  });

  it.each<[string, Frame]>([
    ["нет to", { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { type: "question", notify: {} } }],
    ["нет type", { type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { to: "phone2018", notify: {} } }],
  ])("2018 · кадр не по контракту, %s: bad_frame, службу не зовёт", async (_n, f) => {
    const posts = service(201);
    const log = journal();
    expect(await worker.frame(f)).toMatchObject([{ id: "b-1", ok: false, error: "bad_frame" }]);
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "в push нужны to, type и notify" }));
    expect(posts).toHaveLength(0);
  });

  it("2018 · skip не список и уведомление без текста не влезает: bad_frame с причиной, службу не зовёт", async () => {
    await subscribe("phone2018", await ua(), "https://push.example/2018");
    const posts = service(201);
    const log = journal();
    expect(await worker.frame({ type: "push.send", v: 1, id: "b-1", to: ".push", from: "@pc", push: { to: "phone2018", skip: "pult", type: "question", notify: {} } })).toMatchObject([{ error: "bad_frame" }]);
    expect(log).toContainEqual(expect.objectContaining({ why: "skip — список адресов устройств" }));
    expect(await worker.frame(send("b-2", "phone2018", { title: "x".repeat(5000) }))).toMatchObject([{ error: "bad_frame" }]);
    expect(log).toContainEqual(expect.objectContaining({ why: "уведомление не влезает в 4 096 Б и без notify.body", client: "phone2018", type: "question" }));
    expect(await worker.frame(send("b-3", "phone2018", { body: "ж", title: "x".repeat(5000) }))).toMatchObject([{ error: "bad_frame" }]);
    expect(posts).toHaveLength(0);
  });

  it("сначала кому, потом что: подписки нет — gone и при тексте, который не влезает; отозванный пропуск снят и при нём, причина в журнале", async () => {
    const huge = { title: "x".repeat(5000) };
    const log = journal();
    expect(await worker.frame(send("h-1", "phone-none", huge))).toMatchObject([{ ok: false, error: "gone" }]);
    expect(log).toContainEqual(expect.objectContaining({ word: "gone", why: "подписки нет", client: "phone-none", type: "question" }));
    await worker.frame({ type: "push.subscribe", v: 1, id: "h-2", to: ".push", from: "phone-out", fromKid: "h0ut", sub: sub(await ua(), "https://push.example/out") });
    await GATE.revoke("h0ut");
    expect(await worker.frame(send("h-3", "phone-out", huge))).toMatchObject([{ ok: false, error: "gone" }]);
    expect(await row("phone-out")).toBeUndefined();
    expect(log).toContainEqual(expect.objectContaining({ word: "gone", why: "подписки нет", client: "phone-out", type: "question" }));
  });
});

describe("push.send человеку ~email", () => {
  it("2083 · каждой его подписке, кроме skip; чужому устройству нет; ответ ok", async () => {
    const [pult, phone, laptop, other] = await Promise.all([ua(), ua(), ua(), ua()]);
    await subscribe("pult~yuri2083@example.com", pult, "https://push.example/2083-pult");
    await subscribe("phone~yuri2083@example.com", phone, "https://push.example/2083-phone");
    await subscribe("laptop~yuri2083@example.com", laptop, "https://push.example/2083-laptop");
    await subscribe("phone~anna2083@example.com", other, "https://push.example/2083-anna");
    const posts = service(201);
    const out = await worker.frame(send("s-2083", "~yuri2083@example.com", NOTIFY, ["pult~yuri2083@example.com"]));
    expect(posts.map((p) => p.url).sort()).toEqual(["https://push.example/2083-laptop", "https://push.example/2083-phone"]);
    expect(out).toEqual([{ type: "reply", id: "s-2083", ok: true, to: "@laptop" }]);
  });

  it("2084 · подписок нет или все в skip — gone со своей причиной, службу не зовёт", async () => {
    await subscribe("phone~anna2084@example.com", await ua(), "https://push.example/2084-anna");
    await subscribe("pult~olga2084@example.com", await ua(), "https://push.example/2084-olga");
    const posts = service(201);
    const log = journal();
    expect(await worker.frame(send("s-2084", "~yuri2084@example.com"))).toMatchObject([{ id: "s-2084", ok: false, error: "gone" }]);
    expect(await worker.frame(send("s-2084b", "~olga2084@example.com", NOTIFY, ["pult~olga2084@example.com"]))).toMatchObject([{ id: "s-2084b", ok: false, error: "gone" }]);
    expect(log.map((l) => l.why)).toEqual(["пушить некому: подписок нет или все на связи", "пушить некому: подписок нет или все на связи"]);
    expect(posts).toHaveLength(0);
  });

  it("2086 · ушёл хоть одному — ok; строка 410 удалена; строка журнала на каждое устройство", async () => {
    const [a, b, want] = [201, 410, { ok: true }];
    const m = `${a}${b}`;
    await subscribe(`phone~y${m}@example.com`, await ua(), `https://push.example/${m}-phone`);
    await subscribe(`tab~y${m}@example.com`, await ua(), `https://push.example/${m}-tab`);
    service({ [`https://push.example/${m}-phone`]: a, [`https://push.example/${m}-tab`]: b });
    const log = journal();
    expect(await worker.frame(send("s", `~y${m}@example.com`))).toMatchObject([{ id: "s", to: "@laptop", ...(want as object) }]);
    expect(log.filter((l) => l.status === a && l.client === `phone~y${m}@example.com`)).toHaveLength(1);
    expect(log.filter((l) => l.status === b && l.client === `tab~y${m}@example.com`)).toHaveLength(1);
    expect(await row(`tab~y${m}@example.com`)).toBeUndefined();
  });
});

describe("вход", () => {
  it.each<[string, Frame, string]>([
    ["чужое имя", { type: "push.drop", id: "b", to: ".push", from: "@pc", v: 1 }, "unknown_request"],
  ])("2016 · отказ словом, %s: ответ и строка refuse", async (_n, f, word) => {
    const log = journal();
    expect(await worker.frame(f)).toEqual([{ type: "reply", id: "b", ok: false, error: word, to: "@pc" }]);
    expect(log.map((l) => [l.part, l.kind, l.ev, l.word])).toEqual([["push", "refuse", f.type, word]]);
  });

  it("кадр без id — ответа нет; чужой reply — только строка note", async () => {
    const log = journal();
    expect(await worker.frame({ type: "push.key", v: 1, to: ".push", from: "phone" })).toEqual([]);
    expect(await worker.frame({ type: "push.send", v: 1, to: ".push", from: "phone" })).toEqual([]);
    log.length = 0;
    expect(await worker.frame({ type: "reply", id: "x", ok: true, to: ".push", from: "@pc" })).toEqual([]);
    expect(log.map((l) => [l.kind, l.ev, l.why])).toEqual([["note", "reply", "push ответов не ждёт"]]);
  });
});
