// Подписанная ссылка на объект S3 (AWS Signature V4 в адресе) на WebCrypto: работает в Node и в Worker'ах. Чтение и запись одного объекта без ключа у того, кто идёт по ссылке.
const HOUR = 3600;
const encoder = new TextEncoder();

const hexOf = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(message));
}

/** Кодирование по RFC 3986, как требует подпись. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export type LinkKey = { accessKeyId: string; secretAccessKey: string; region?: string };

/** Ссылка: метод, хост, путь /бакет/ключ, миг подписи, срок в секундах (по умолчанию час). */
export async function presign(key: LinkKey, o: { method: "GET" | "PUT"; host: string; path: string; now: Date; expires?: number }): Promise<string> {
  const region = key.region ?? "auto";
  const stamp = o.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = o.path.split("/").map(rfc3986).join("/");
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${key.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(o.expires ?? HOUR)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([n, v]) => `${n}=${rfc3986(v)}`)
    .join("&");
  const request = `${o.method}\n${path}\n${query}\nhost:${o.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const digest = hexOf(await crypto.subtle.digest("SHA-256", encoder.encode(request)));
  let signing = await hmac(encoder.encode(`AWS4${key.secretAccessKey}`), day);
  for (const step of [region, "s3", "aws4_request"]) signing = await hmac(signing, step);
  const signature = hexOf(await hmac(signing, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${digest}`));
  return `https://${o.host}${path}?${query}&X-Amz-Signature=${signature}`;
}
