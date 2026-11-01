// Ссылки S3 с подписью в адресе (AWS Signature V4, query): чтение и запись одного объекта без ключа у того, кто идёт по ссылке.

export const LINK_TTL = 3600;

const te = new TextEncoder();
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hex = async (s: string) => toHex(await crypto.subtle.digest("SHA-256", te.encode(s)));
async function hmac(k: ArrayBuffer | string, s: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", typeof k === "string" ? te.encode(k) : k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, te.encode(s));
}
/** Кодирование по RFC 3986, как требует подпись. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export type LinkKey = { accessKeyId: string; secretAccessKey: string; region?: string };

/** Подписанная ссылка: метод, хост, путь (/бакет/ключ — сегменты как есть), миг подписи, срок в секундах. */
export async function presign(k: LinkKey, o: { method: "GET" | "PUT"; host: string; path: string; now: Date; expires?: number }): Promise<string> {
  const region = k.region ?? "auto";
  const amz = o.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amz.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = o.path.split("/").map(enc).join("/");
  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${k.accessKeyId}/${scope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(o.expires ?? LINK_TTL),
    "X-Amz-SignedHeaders": "host",
  };
  const query = Object.keys(q)
    .sort()
    .map((n) => `${enc(n)}=${enc(q[n])}`)
    .join("&");
  const canonical = [o.method, path, query, `host:${o.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, await hex(canonical)].join("\n");
  const key = await hmac(await hmac(await hmac(await hmac("AWS4" + k.secretAccessKey, day), region), "s3"), "aws4_request");
  const sig = toHex(await hmac(key, toSign));
  return `https://${o.host}${path}?${query}&X-Amz-Signature=${sig}`;
}
