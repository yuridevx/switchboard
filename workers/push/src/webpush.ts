// Протокол веб-пушей на WebCrypto: подпись VAPID (RFC 8292) и шифрование тела aes128gcm (RFC 8291).

const enc = new TextEncoder();

export function b64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Открытый ключ VAPID из закрытого JWK: несжатая точка P-256 (0x04 ‖ x ‖ y), 65 байт, base64url. */
export function publicKey(jwk: JsonWebKey): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) throw new Error("VAPID_PRIVATE — не JWK P-256 с d, x, y");
  return b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
}

/** JWT ES256 для службы пушей: aud — origin адреса подписки, срок 12 ч (RFC 8292 — не больше суток). */
export async function vapidJwt(jwk: JsonWebKey, endpoint: string, sub: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Размер записи aes128gcm: тело службе — одна запись, не больше 4 096 Б. */
export const RS = 4096;
/** Заголовок тела: salt 16 ‖ rs 4 ‖ idlen 1 ‖ keyid 65. */
export const HEAD = 86;
/** Открытого текста в одной записи при таком теле: 4 096 − 86 − 1 (разделитель) − 16 (тег). */
export const PLAIN_MAX = RS - HEAD - 1 - 16;

/**
 * Шифрование тела по RFC 8291: ECDH с ключом подписки, HKDF с auth, AES-128-GCM одной записью.
 * salt и ключ сервера — случайные; тест передаёт свои, чтобы сверить с примером RFC.
 */
export async function encrypt(
  plain: Uint8Array,
  p256dh: Uint8Array<ArrayBuffer>,
  auth: Uint8Array<ArrayBuffer>,
  fixed?: { salt: Uint8Array<ArrayBuffer>; as: CryptoKeyPair },
): Promise<Uint8Array<ArrayBuffer>> {
  if (plain.length > PLAIN_MAX) throw new Error(`открытый текст ${plain.length} Б больше ${PLAIN_MAX}`);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = fixed?.as ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const ua = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(ua), as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), p256dh, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 — разделитель последней записи
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RS);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/**
 * Открытый текст уведомления: { type, from, notify } в JSON.
 * Не влезает в PLAIN_MAX — notify.body укорачивается и кончается «…»; cut: true.
 * Не влезает и без body — null.
 */
export function fit(msg: { type: string; from?: string; notify: Record<string, unknown> }): { bytes: Uint8Array; cut: boolean } | null {
  const whole = enc.encode(JSON.stringify(msg));
  if (whole.length <= PLAIN_MAX) return { bytes: whole, cut: false };
  const body = msg.notify.body;
  if (typeof body !== "string") return null;
  const chars = Array.from(body);
  const at = (n: number) => enc.encode(JSON.stringify({ ...msg, notify: { ...msg.notify, body: chars.slice(0, n).join("") + "…" } }));
  if (at(0).length > PLAIN_MAX) return null;
  // наибольшее начало текста, с которым тело влезает
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at(mid).length <= PLAIN_MAX) lo = mid;
    else hi = mid - 1;
  }
  return { bytes: at(lo), cut: true };
}

/** Алгоритм ECDH с открытым ключом другой стороны (в типах workers-types поле называется $public). */
function ecdh(pub: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}
