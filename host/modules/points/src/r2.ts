// R2 по S3: PUT и GET блоков f/<отпечаток> прямо с машины, временным ключом из ответа реестра points.
// Подпись — AWS Signature V4 (регион auto, служба s3), временный ключ — заголовком X-Amz-Security-Token.
import { createHash, createHmac } from "node:crypto";

export type Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  bucket: string;
  exp: number;
};

export type Fetch = typeof fetch;

const hex = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();

/** Заголовки подписанного запроса к объекту key бакета. */
export function sign(method: "PUT" | "GET", c: Creds, key: string, body: Uint8Array | null, now = new Date()): { url: string; headers: Record<string, string> } {
  const host = new URL(c.endpoint).host;
  const path = `/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const amz = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amz.slice(0, 8);
  const payload = hex(body ?? "");
  const h: Record<string, string> = {
    host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amz,
    "x-amz-security-token": c.sessionToken,
  };
  const names = Object.keys(h).sort();
  const canonical = [method, path, "", names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, hex(canonical)].join("\n");
  const k = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), "auto"), "s3"), "aws4_request");
  const sig = createHmac("sha256", k).update(sts).digest("hex");
  const { host: _h, ...rest } = h;
  return {
    url: `${c.endpoint.replace(/\/$/, "")}${path}`,
    headers: { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` },
  };
}

/** Положить блок в R2. Не вышло — исключение со статусом. */
export async function putBlock(c: Creds, hash: string, body: Buffer, f: Fetch = fetch): Promise<void> {
  const { url, headers } = sign("PUT", c, `f/${hash}`, body);
  const r = await f(url, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!r.ok) throw new Error(`R2 PUT f/${hash}: ${r.status}`);
}

/** Взять блок из R2. */
export async function getBlock(c: Creds, hash: string, f: Fetch = fetch): Promise<Buffer> {
  const { url, headers } = sign("GET", c, `f/${hash}`, null);
  const r = await f(url, { method: "GET", headers });
  if (!r.ok) throw new Error(`R2 GET f/${hash}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
