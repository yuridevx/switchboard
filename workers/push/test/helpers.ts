// Сторона браузера для тестов: ключи подписки и расшифровка тела aes128gcm (RFC 8291).
import { vi } from "vitest";
import { b64u, concat } from "../src/webpush.ts";

const enc = new TextEncoder();

export type Ua = { keys: CryptoKeyPair; p256dh: string; auth: string };

export async function ua(): Promise<Ua> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return { keys, p256dh: b64u(pub), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

export function sub(u: Ua, endpoint: string) {
  return { endpoint, keys: { p256dh: u.p256dh, auth: u.auth } };
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Расшифровать тело так, как это делает браузер. */
export async function decrypt(body: Uint8Array, u: { keys: CryptoKeyPair; auth: Uint8Array<ArrayBuffer> }): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", u.keys.publicKey)) as ArrayBuffer);
  const as = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(as), u.keys.privateKey, 256));
  const ikm = await hkdf(u.auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ct));
  // последняя запись: текст ‖ 0x02 ‖ нули
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("нет разделителя последней записи");
  return new TextDecoder().decode(plain.slice(0, end));
}

export type Posted = { url: string; headers: Headers; body: Uint8Array };

/** Поддельная служба пушей: отвечает status и записывает каждый POST. */
export function fakeService(status: number | (() => number)) {
  const posts: Posted[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    posts.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status: typeof status === "function" ? status() : status });
  });
  return { posts, spy };
}

/** Строки журнала push, которые попали в console.log. */
export function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
}

/** Алгоритм ECDH с открытым ключом другой стороны (в типах workers-types поле называется $public). */
function ecdh(pub: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}
