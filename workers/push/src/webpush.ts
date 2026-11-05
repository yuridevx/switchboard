// Web Push: тело aes128gcm по RFC 8291, подпись VAPID по RFC 8292. Всё на WebCrypto платформы.
import { CALL_MS } from "@switchboard/protocol";

/** Запись одна на сообщение, размер записи и предел службы — 4 096 Б. */
const RECORD = 4096;
const HEADER = 16 + 4 + 1 + 65;
/** Сколько открытого текста влезает: заголовок, разделитель записи и метка AES-GCM. */
export const MAX_PLAIN = RECORD - HEADER - 1 - 16;
/** Срок подписи и пуша у службы. RFC 8292 разрешает подпись до суток. */
const VAPID_S = 12 * 3600;
const TTL_S = 86400;

const enc = new TextEncoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" };

export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (s: string) => b64u(enc.encode(s));

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function encrypt(plain: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64u(p256dh);
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const ua = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua } as never, pair.privateKey, 256));
  const ikm = await hkdf(unb64u(auth), shared, join(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const iv = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, join(plain, new Uint8Array([2])));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD);
  return join(salt, size, new Uint8Array([asPublic.length]), asPublic, new Uint8Array(sealed));
}

/** Открытый ключ VAPID: несжатая точка P-256 из JWK. */
export function publicKey(jwk: JsonWebKey): string {
  return b64u(join(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!)));
}

async function authorization(endpoint: string, jwk: JsonWebKey, subject: string): Promise<string> {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + VAPID_S, sub: subject };
  const unsigned = `${b64uText(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64uText(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(new Uint8Array(signature))}, k=${publicKey(jwk)}`;
}

export type Target = { endpoint: string; p256dh: string; auth: string };

/** Запрос службе пушей: тело зашифровано ключами устройства, подпись — ключом VAPID. */
export async function pushRequest(t: Target, text: string, jwk: JsonWebKey, subject: string): Promise<{ init: RequestInit; bytes: number }> {
  const body = await encrypt(enc.encode(text), t.p256dh, t.auth);
  return {
    bytes: body.length,
    init: {
      method: "POST",
      body,
      signal: AbortSignal.timeout(CALL_MS),
      headers: {
        authorization: await authorization(t.endpoint, jwk, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_S),
        urgency: "high",
      },
    },
  };
}
