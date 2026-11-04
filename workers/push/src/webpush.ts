// Протокол веб-пушей на WebCrypto: подпись VAPID (RFC 8292) и шифрование тела aes128gcm (RFC 8291). Базы и сети здесь нет.
const utf8 = new TextEncoder();
const P256 = { namedCurve: "P-256" };

export const toB64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Открытый ключ VAPID: несжатая точка P-256, 0x04 ‖ x ‖ y, base64url. */
export function publicKey(vapid: JsonWebKey): string {
  if (vapid.kty !== "EC" || vapid.crv !== "P-256" || !vapid.x || !vapid.y || !vapid.d) throw new Error("VAPID_PRIVATE — не JWK P-256 с d, x, y");
  return toB64u(bytes(Uint8Array.of(4), fromB64u(vapid.x), fromB64u(vapid.y)));
}

/** Значение Authorization службе: JWT ES256, aud — origin адреса подписки, срок 12 ч (RFC 8292 — не больше суток). */
export async function authorization(vapid: JsonWebKey, endpoint: string, sub: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: vapid.x, y: vapid.y, d: vapid.d }, { name: "ECDSA", ...P256 }, false, ["sign"]);
  const part = (o: object) => toB64u(utf8.encode(JSON.stringify(o)));
  const signed = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(signed));
  return `vapid t=${signed}.${toB64u(new Uint8Array(sig))}, k=${publicKey(vapid)}`;
}

async function hkdf(salt: BufferSource, secret: BufferSource, info: BufferSource, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Размер записи: тело службе — одна запись. */
const RECORD = 4096;
/** Заголовок тела: salt 16, размер записи 4, длина ключа 1, ключ 65. */
const HEADER = 86;
/** Открытого текста в записи: без заголовка, разделителя и тега. */
const PLAIN_MAX = RECORD - HEADER - 1 - 16;

/** Тело по RFC 8291: ECDH со случайным ключом сервера, ключи — HKDF с auth подписки, AES-128-GCM одной записью. */
export async function encrypt(plain: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array<ArrayBuffer>> {
  const device = fromB64u(p256dh);
  const server = (await crypto.subtle.generateKey({ name: "ECDH", ...P256 }, true, ["deriveBits"])) as CryptoKeyPair;
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer);
  const peer = await crypto.subtle.importKey("raw", device, { name: "ECDH", ...P256 }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm, server.privateKey, 256);
  const secret = await hkdf(fromB64u(auth), shared, bytes(utf8.encode("WebPush: info\0"), device, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, secret, utf8.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["encrypt"]);
  const iv = await hkdf(salt, secret, utf8.encode("Content-Encoding: nonce\0"), 12);
  // 0x02 — разделитель последней записи
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, bytes(plain, Uint8Array.of(2))));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD);
  return bytes(salt, size, Uint8Array.of(serverPublic.length), serverPublic, sealed);
}

/** Открытый текст уведомления. Не влезает — укорачивается notify.body и кончается «…»; не влезает и без него — null. */
export function fit(msg: { type: string; from?: string; notify: Record<string, unknown> }): { bytes: Uint8Array; cut: boolean } | null {
  const whole = utf8.encode(JSON.stringify(msg));
  if (whole.length <= PLAIN_MAX) return { bytes: whole, cut: false };
  if (typeof msg.notify.body !== "string") return null;
  const chars = Array.from(msg.notify.body);
  const withFirst = (n: number) => utf8.encode(JSON.stringify({ ...msg, notify: { ...msg.notify, body: `${chars.slice(0, n).join("")}…` } }));
  if (withFirst(0).length > PLAIN_MAX) return null;
  // символы экранируются по-разному: наибольшее начало текста — делением пополам
  let fits = 0;
  let over = chars.length;
  while (over - fits > 1) {
    const mid = (fits + over) >> 1;
    if (withFirst(mid).length <= PLAIN_MAX) fits = mid;
    else over = mid;
  }
  return { bytes: withFirst(fits), cut: true };
}
