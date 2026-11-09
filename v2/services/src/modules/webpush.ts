// Web Push на WebCrypto: тело aes128gcm одной записью (RFC 8291, RFC 8188) и подпись VAPID (RFC 8292, JWT ES256).
const enc = new TextEncoder();
const P256 = { name: "ECDH", namedCurve: "P-256" };
/** Размер записи в заголовке тела: вся запись помещается в одну. */
const RS = 4096;
/** Тело сверх открытого текста: соль 16, rs 4, длина ключа 1, ключ 65, разделитель записи 1, тег GCM 16. */
const OVERHEAD = 16 + 4 + 1 + 65 + 1 + 16;
/** Предел тела пуша у служб — 4 096 Б; открытый текст — не больше этого. */
export const MAX_PLAIN = 4096 - OVERHEAD;

export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Тело пуша для подписки браузера (p256dh, auth): свой ключ ECDH и соль на каждое сообщение. */
export async function encrypt(plain: Uint8Array, p256dh: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const own = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const ownPublic = new Uint8Array((await crypto.subtle.exportKey("raw", own.publicKey)) as ArrayBuffer);
  const browser = await crypto.subtle.importKey("raw", p256dh, P256, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: browser } as never, own.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), p256dh, ownPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 2 — разделитель последней записи
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, RS);
  head[20] = ownPublic.length;
  return concat(head, ownPublic, sealed);
}

/** Открытый ключ VAPID: несжатая точка P-256 из JWK. */
export const publicKey = (jwk: JsonWebKey) => b64u(concat(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!)));

/** Заголовок Authorization для службы этого адреса: JWT на 12 часов (служба принимает не больше 24). */
export async function vapid(jwk: JsonWebKey, endpoint: string, sub: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey(jwk)}`;
}
