// API Cloudflare для частей Cloudflare: версии Worker'а с меткой-номером, выложенная версия, выкладка на 100%, версия со статикой сборки страницы, адрес по имени.
import type { Env } from "./env.ts";

/** API не ответил как надо: статус и errors — в журнал releases, отправителю — cf_failed. */
export class CfFailed extends Error {
  status: number;
  text: string;
  constructor(status: number, text: string) {
    super(status ? `API Cloudflare ответил ${status}` : `API Cloudflare: ${text}`);
    this.status = status;
    this.text = text;
  }
}

/** Предел обращения: вдвое выше самого долгого замера выкладки одной части целиком (3,6 с, три обращения). */
const LIMIT_MS = 8_000;

/** Обращение к API аккаунта; токен загрузки статики приходит в init и заменяет свой. */
async function api<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.CF_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new CfFailed(0, "нет CF_ACCOUNT_ID или CLOUDFLARE_API_TOKEN в настройках releases");
  let res: Response;
  let body: string;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(LIMIT_MS),
    });
    body = await res.text();
  } catch (e) {
    throw new CfFailed(0, (e as { name?: string } | null)?.name === "TimeoutError" ? `не ответил за ${LIMIT_MS / 1000} с` : String(e));
  }
  const parsed = parseOr(body);
  if (!res.ok || !parsed?.success) throw new CfFailed(res.status, parsed ? JSON.stringify(parsed.errors ?? null) : body);
  return parsed.result as T;
}

function parseOr(body: string): { success?: boolean; errors?: unknown; result?: unknown } | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const postJson = <T>(env: Env, path: string, body: unknown) => api<T>(env, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Спросить о Worker'е; его нет во флоте (код 10007: модуль лежит в каталоге, но здесь не выложен) — none. */
async function ifScript<T, N>(ask: Promise<T>, none: N): Promise<T | N> {
  try {
    return await ask;
  } catch (e) {
    if (e instanceof CfFailed && e.status === 404 && e.text.includes("10007")) return none;
    throw e;
  }
}

/** Версии Worker'а с меткой: метка → id версии, новейшая на метку. */
export async function versions(env: Env, script: string): Promise<Map<string, string>> {
  const r = await ifScript(api<{ items?: Array<{ id: string; annotations?: Record<string, string> }> }>(env, `/workers/scripts/${script}/versions?per_page=100`), null);
  const out = new Map<string, string>();
  for (const v of r?.items ?? []) {
    const tag = v.annotations?.["workers/tag"];
    if (tag && !out.has(tag)) out.set(tag, v.id);
  }
  return out;
}

/** id выложенной версии: у последней выкладки — версия с наибольшей долей. */
export async function deployed(env: Env, script: string): Promise<string | null> {
  const r = await ifScript(api<{ deployments?: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(env, `/workers/scripts/${script}/deployments`), null);
  const shares = r?.deployments?.[0]?.versions ?? [];
  return shares.toSorted((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;
}

export async function deploy(env: Env, script: string, versionId: string): Promise<void> {
  await postJson(env, `/workers/scripts/${script}/deployments`, { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] });
}

const TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  css: "text/css",
};
const extension = (path: string) => path.split(".").pop() ?? "";

async function assetHash(data: Uint8Array, path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([...data, ...new TextEncoder().encode(extension(path))]));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Версия Worker'а со статикой сборки страницы, без выкладки: сессия загрузки по манифесту файлов → загрузка тех, каких у Cloudflare нет →
 * версия с меткой tag. _headers — правила заголовков, не файл. Ответ — id версии.
 */
export async function publishStatic(env: Env, script: string, files: Array<{ path: string; data: Uint8Array }>, tag: string): Promise<string> {
  const rules = files.find((f) => f.path === "_headers");
  const byHash = new Map<string, { path: string; data: Uint8Array }>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    if (f === rules) continue;
    const hash = await assetHash(f.data, f.path);
    manifest[`/${f.path}`] = { hash, size: f.data.length };
    byHash.set(hash, f);
  }
  const session = await postJson<{ jwt: string; buckets?: string[][] }>(env, `/workers/scripts/${script}/assets-upload-session`, { manifest });
  let jwt = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) {
      const f = byHash.get(hash)!;
      form.append(hash, new File([Buffer.from(f.data).toString("base64")], hash, { type: TYPES[extension(f.path)] ?? "application/octet-stream" }));
    }
    const r = await api<{ jwt?: string } | null>(env, "/workers/assets/upload?base64=true", { method: "POST", headers: { authorization: `Bearer ${session.jwt}` }, body: form });
    jwt = r?.jwt ?? jwt;
  }
  const metadata = {
    compatibility_date: "2026-10-01",
    assets: { jwt, config: rules ? { _headers: new TextDecoder().decode(rules.data) } : {} },
    annotations: { "workers/tag": tag },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  return (await api<{ id: string }>(env, `/workers/scripts/${script}/versions`, { method: "POST", body: form })).id;
}

/** Адреса Worker'ов: свой домен, если он есть, иначе workers.dev аккаунта. Два обращения на все имена. */
export async function urlsOf(env: Env, scripts: string[]): Promise<Record<string, string>> {
  if (!scripts.length) return {};
  const [domains, { subdomain }] = await Promise.all([api<Array<{ hostname: string; service: string }> | null>(env, "/workers/domains"), api<{ subdomain: string }>(env, "/workers/subdomain")]);
  return Object.fromEntries(scripts.map((s) => [s, `https://${domains?.find((d) => d.service === s)?.hostname ?? `${s}.${subdomain}.workers.dev`}`]));
}
