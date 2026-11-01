// API Cloudflare для частей Cloudflare: версии Worker'а с меткой-номером, выложенная версия, выкладка версии на 100%.
import type { Env } from "./env.ts";

/** API Cloudflare не ответил как надо: статус и errors ответа — в журнал releases, отправителю — cf_failed. */
export class CfFailed extends Error {
  status: number;
  text: string;
  constructor(status: number, text: string) {
    super(status ? `API Cloudflare ответил ${status}` : `API Cloudflare: ${text}`);
    this.status = status;
    this.text = text;
  }
}

async function api<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!env.CF_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new CfFailed(0, "нет CF_ACCOUNT_ID или CLOUDFLARE_API_TOKEN в настройках releases");
  let r: Response;
  try {
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new CfFailed(0, String(e));
  }
  const text = await r.text();
  let j: { success?: boolean; errors?: unknown; result?: T } | null = null;
  try {
    j = JSON.parse(text);
  } catch {
    // не JSON — ниже отказ с текстом ответа
  }
  if (!r.ok || !j?.success) throw new CfFailed(r.status, j ? JSON.stringify(j.errors ?? null) : text);
  return j.result as T;
}

/** Версии Worker'а с меткой: метка → id версии. */
export async function versions(env: Env, script: string): Promise<Map<string, string>> {
  const r = await api<{ items?: Array<{ id: string; annotations?: Record<string, string> }> }>(env, "GET", `/workers/scripts/${script}/versions?per_page=100`);
  const out = new Map<string, string>();
  for (const v of r.items ?? []) {
    const tag = v.annotations?.["workers/tag"];
    if (tag && !out.has(tag)) out.set(tag, v.id);
  }
  return out;
}

/** id выложенной версии: у последней выкладки — версия с наибольшей долей. */
export async function deployed(env: Env, script: string): Promise<string | null> {
  const r = await api<{ deployments?: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(env, "GET", `/workers/scripts/${script}/deployments`);
  const v = [...(r.deployments?.[0]?.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
  return v?.version_id ?? null;
}

/** Выложить версию на 100%. */
export async function deploy(env: Env, script: string, versionId: string): Promise<void> {
  await api(env, "POST", `/workers/scripts/${script}/deployments`, { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] });
}
