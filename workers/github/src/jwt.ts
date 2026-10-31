// JWT приложения GitHub: RS256 ключом приложения, iss — id приложения, срок 9 минут (предел GitHub — 10).

const enc = new TextEncoder();

function b64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function der(pem: string): Uint8Array<ArrayBuffer> {
  const bin = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tlv(tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  const out = new Uint8Array(1 + len.length + n);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** GitHub отдаёт ключ в PKCS#1 («BEGIN RSA PRIVATE KEY»); WebCrypto принимает PKCS#8 — оборачиваем. */
export function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = der(pem);
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return body;
  // PrivateKeyInfo: version 0, AlgorithmIdentifier rsaEncryption + NULL, OCTET STRING с ключом PKCS#1
  const head = new Uint8Array([0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const oct = tlv(0x04, body);
  const inner = new Uint8Array(head.length + oct.length);
  inner.set(head);
  inner.set(oct, head.length);
  return tlv(0x30, inner);
}

export async function appJwt(id: number, pem: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sec = Math.floor(now / 1000);
  // iat на минуту назад — расхождение часов с GitHub
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u(enc.encode(JSON.stringify({ iat: sec - 60, exp: sec + 540, iss: String(id) })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}
