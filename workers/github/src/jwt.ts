// JWT приложения GitHub: RS256 ключом приложения, iss — id приложения.

/** Начало на минуту назад — расхождение часов с GitHub; всего 10 минут — предел GitHub. */
const BACK_S = 60;
const AHEAD_S = 540;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const PKCS1_LABEL = "BEGIN RSA PRIVATE KEY";
/** Начало PrivateKeyInfo: версия 0 и алгоритм rsaEncryption с NULL. */
const PKCS8_HEAD = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
const OCTET_STRING = 0x04;
const SEQUENCE = 0x30;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonPart = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Элемент DER: метка, длина, тело. */
function der(tag: number, body: Uint8Array | number[]): Uint8Array<ArrayBuffer> {
  const length: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) length.unshift(n % 256);
  const head = body.length < 128 ? [body.length] : [0x80 + length.length, ...length];
  return Uint8Array.from([tag, ...head, ...body]);
}

/** WebCrypto принимает только PKCS#8, а GitHub отдаёт ключ в PKCS#1 — оборачиваем. */
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return pem.includes(PKCS1_LABEL) ? der(SEQUENCE, [...PKCS8_HEAD, ...der(OCTET_STRING, body)]) : body;
}

export async function appJwt(appId: number, pem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(pem), RS256, false, ["sign"]);
  const nowS = Math.floor(nowMs / 1000);
  const signed = `${jsonPart({ alg: "RS256", typ: "JWT" })}.${jsonPart({ iat: nowS - BACK_S, exp: nowS + AHEAD_S, iss: String(appId) })}`;
  const signature = await crypto.subtle.sign(RS256, key, new TextEncoder().encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}
