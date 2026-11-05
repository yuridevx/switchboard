// Ссылка на объект R2: подпись AWS4 в адресе (S3-совместимый вход).
export type LinkKey = { accessKeyId: string; secretAccessKey: string; region?: string };
type Link = { method: "GET" | "PUT"; host: string; path: string; now?: Date; expires?: number };

const HOUR = 3600;
const encoder = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: BufferSource, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(text));
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export async function presign(key: LinkKey, link: Link): Promise<string> {
  const { method, host, path, now = new Date(), expires = HOUR } = link;
  const region = key.region ?? "auto";
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = new URLSearchParams({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${key.accessKeyId}/${scope}`, "X-Amz-Date": stamp, "X-Amz-Expires": String(expires), "X-Amz-SignedHeaders": "host" }).toString();
  const route = encodePath(path);
  const canonical = [method, route, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))].join("\n");
  let signing: ArrayBuffer = encoder.encode(`AWS4${key.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [day, region, "s3", "aws4_request"]) signing = await hmac(signing, part);
  return `https://${host}${route}?${query}&X-Amz-Signature=${hex(await hmac(signing, toSign))}`;
}
