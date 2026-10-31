// Временные ключи R2 через API Cloudflare: ключ S3 на час, ограничен бакетом, правом и префиксами.
import type { Creds } from "../contract.ts";
import type { Env } from "./env.ts";

export const TTL = 3600;

/** API Cloudflare не выдал ключ: статус и ответ — в журнал points, отправителю — r2_failed. */
export class R2Failed extends Error {
  status: number;
  text: string;
  constructor(status: number, text: string) {
    super(status ? `API Cloudflare ответил ${status}` : `API Cloudflare: ${text}`);
    this.status = status;
    this.text = text;
  }
}

export async function tempCreds(env: Env, bucket: string, permission: "object-read-write" | "object-read-only", prefixes?: string[]): Promise<Creds> {
  if (!env.CF_ACCOUNT_ID || !env.R2_PARENT_KEY_ID || !env.R2_TOKEN) throw new R2Failed(0, "нет CF_ACCOUNT_ID, R2_PARENT_KEY_ID или R2_TOKEN в настройках points");
  const body: Record<string, unknown> = { bucket, parentAccessKeyId: env.R2_PARENT_KEY_ID, permission, ttlSeconds: TTL };
  if (prefixes) body.prefixes = prefixes;
  let r: Response;
  try {
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/temp-access-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.R2_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new R2Failed(0, String(e));
  }
  const text = await r.text();
  let j: { success?: boolean; errors?: unknown; result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } } | null = null;
  try {
    j = JSON.parse(text);
  } catch {
    // не JSON — ниже отказ с текстом ответа
  }
  const k = j?.result;
  if (!r.ok || !j?.success || !k?.accessKeyId || !k.secretAccessKey || !k.sessionToken) // в журнал — только errors ответа: ключей в нём нет
    throw new R2Failed(r.status, j ? JSON.stringify(j.errors ?? null) : text);
  return {
    accessKeyId: k.accessKeyId,
    secretAccessKey: k.secretAccessKey,
    sessionToken: k.sessionToken,
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket,
    exp: Date.now() + TTL * 1000,
  };
}
