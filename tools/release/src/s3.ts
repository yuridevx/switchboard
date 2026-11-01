// S3 API R2 без внешних пакетов: подпись AWS Signature V4 на node:crypto, адрес path-style <endpoint>/<bucket>/<key>.
import { createHash, createHmac } from "node:crypto";

/** Ключ S3 выкладчика. */
export type S3Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  /** у R2 — auto */
  region?: string;
};

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => Promise<{
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

/** Кодирование сегмента пути по RFC 3986, как требует подпись. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Подпись запроса. headers — без authorization; в них должны быть host, x-amz-date и x-amz-content-sha256.
 * Ответ — значение заголовка Authorization.
 */
export function sign(o: {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}): string {
  const service = o.service ?? "s3";
  const names = Object.keys(o.headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const signed = names.join(";");
  const canonical = [o.method, o.path, o.query ?? "", names.map((n) => `${n}:${lower[n]}\n`).join(""), signed, o.payloadHash].join("\n");
  const amzDate = lower["x-amz-date"];
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + o.secretAccessKey, day), o.region), service), "aws4_request");
  const sig = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
}

export type S3Result = { status: number; body: Buffer };

/** Клиент бакета: GET, HEAD и PUT объекта по ключу. Ответ — статус и тело; решает вызывающий. */
export function s3(c: S3Creds, f: Fetch = fetch as unknown as Fetch, now: () => Date = () => new Date()) {
  const base = new URL(c.endpoint);
  const call = async (method: "GET" | "HEAD" | "PUT", key: string, body?: Buffer, signal?: AbortSignal): Promise<S3Result> => {
    const path = `${base.pathname.replace(/\/$/, "")}/${enc(c.bucket)}/${key.split("/").map(enc).join("/")}`;
    const amzDate = now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = body ? hex(body) : "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = { host: base.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
    headers.authorization = sign({ method, path, headers, payloadHash, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region ?? "auto" });
    const { host: _host, ...send } = headers;
    const r = await f(`${base.protocol}//${base.host}${path}`, { method, headers: send, ...(body ? { body } : {}), ...(signal ? { signal } : {}) });
    return { status: r.status, body: method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer()) };
  };
  return {
    get: (key: string, signal?: AbortSignal) => call("GET", key, undefined, signal),
    head: (key: string) => call("HEAD", key),
    put: (key: string, body: Buffer) => call("PUT", key, body),
  };
}
