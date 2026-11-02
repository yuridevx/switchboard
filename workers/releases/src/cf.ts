// API Cloudflare для частей Cloudflare: версии Worker'а с меткой-номером, выложенная версия, выкладка версии на 100%,
// версия Worker'а со статикой сборки страницы и адрес Worker'а по имени.
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

/** Предел обращения к API: вдвое выше самого долгого замера выкладки одной части целиком (3,6 с, три обращения). */
const API_MS = 8_000;

async function api<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  return call<T>(env, path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

/** Обращение к API аккаунта: токен — свой или переданный в init (токен загрузки статики), предел API_MS. */
async function call<T>(env: Env, path: string, init: RequestInit): Promise<T> {
  if (!env.CF_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new CfFailed(0, "нет CF_ACCOUNT_ID или CLOUDFLARE_API_TOKEN в настройках releases");
  let r: Response;
  try {
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(API_MS),
    });
  } catch (e) {
    throw new CfFailed(0, late(e) ? `не ответил за ${API_MS / 1000} с` : String(e));
  }
  let text: string;
  try {
    text = await r.text();
  } catch (e) {
    throw new CfFailed(0, late(e) ? `не ответил за ${API_MS / 1000} с` : String(e));
  }
  let j: { success?: boolean; errors?: unknown; result?: T } | null = null;
  try {
    j = JSON.parse(text);
  } catch {
    // не JSON — ниже отказ с текстом ответа
  }
  if (!r.ok || !j?.success) throw new CfFailed(r.status, j ? JSON.stringify(j.errors ?? null) : text);
  return j.result as T;
}

/** Предел вышел: AbortSignal.timeout бросает TimeoutError. */
const late = (e: unknown) => (e as { name?: string } | null)?.name === "TimeoutError";

/** Worker'а с таким именем во флоте нет (код 10007): модуль-Worker лежит в каталоге, но здесь не выложен. */
const absent = (e: unknown) => e instanceof CfFailed && e.status === 404 && e.text.includes("10007");

/** Версии Worker'а с меткой: метка → id версии. Worker'а во флоте нет — версий нет. */
export async function versions(env: Env, script: string): Promise<Map<string, string>> {
  let r: { items?: Array<{ id: string; annotations?: Record<string, string> }> };
  try {
    r = await api(env, "GET", `/workers/scripts/${script}/versions?per_page=100`);
  } catch (e) {
    if (absent(e)) return new Map();
    throw e;
  }
  const out = new Map<string, string>();
  for (const v of r.items ?? []) {
    const tag = v.annotations?.["workers/tag"];
    if (tag && !out.has(tag)) out.set(tag, v.id);
  }
  return out;
}

/** id выложенной версии: у последней выкладки — версия с наибольшей долей. Worker'а во флоте нет — null. */
export async function deployed(env: Env, script: string): Promise<string | null> {
  let r: { deployments?: Array<{ versions: Array<{ version_id: string; percentage: number }> }> };
  try {
    r = await api(env, "GET", `/workers/scripts/${script}/deployments`);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
  const v = [...(r.deployments?.[0]?.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
  return v?.version_id ?? null;
}

/** Выложить версию на 100%. */
export async function deploy(env: Env, script: string, versionId: string): Promise<void> {
  await api(env, "POST", `/workers/scripts/${script}/deployments`, { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] });
}

const MIME: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  css: "text/css",
};
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Версия Worker'а со статикой сборки страницы, без выкладки: сессия загрузки по манифесту файлов → загрузка тех, каких
 * у Cloudflare нет → версия с меткой tag. _headers — правила заголовков статики, не файл. Ответ — id версии.
 */
export async function publishStatic(env: Env, script: string, files: Array<{ path: string; data: Uint8Array }>, tag: string): Promise<string> {
  const assets = files.filter((x) => x.path !== "_headers");
  const headers = files.find((x) => x.path === "_headers");
  const byHash = new Map<string, { path: string; data: Uint8Array }>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of assets) {
    const ext = new TextEncoder().encode(a.path.split(".").pop() ?? "");
    const hash = (await hex(new Uint8Array([...a.data, ...ext]))).slice(0, 32);
    manifest[`/${a.path}`] = { hash, size: a.data.length };
    byHash.set(hash, a);
  }
  const s = await api<{ jwt: string; buckets?: string[][] }>(env, "POST", `/workers/scripts/${script}/assets-upload-session`, { manifest });
  let jwt = s.jwt;
  for (const bucket of s.buckets ?? []) {
    const fd = new FormData();
    for (const h of bucket) {
      const a = byHash.get(h)!;
      fd.append(h, new File([Buffer.from(a.data).toString("base64")], h, { type: MIME[a.path.split(".").pop() ?? ""] ?? "application/octet-stream" }));
    }
    const r = await call<{ jwt?: string }>(env, "/workers/assets/upload?base64=true", { method: "POST", headers: { authorization: `Bearer ${s.jwt}` }, body: fd });
    if (r?.jwt) jwt = r.jwt;
  }
  const meta = {
    compatibility_date: "2026-10-01",
    assets: { jwt, config: { not_found_handling: "single-page-application", ...(headers ? { _headers: new TextDecoder().decode(headers.data) } : {}) } },
    annotations: { "workers/tag": tag },
  };
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  return (await call<{ id: string }>(env, `/workers/scripts/${script}/versions`, { method: "POST", body: fd })).id;
}

/** Адреса Worker'ов по имени: свой домен, если он есть, иначе workers.dev аккаунта. Два обращения на все имена. */
export async function urlsOf(env: Env, scripts: string[]): Promise<Record<string, string>> {
  if (!scripts.length) return {};
  const [domains, { subdomain }] = await Promise.all([
    api<Array<{ hostname: string; service: string }>>(env, "GET", "/workers/domains"),
    api<{ subdomain: string }>(env, "GET", "/workers/subdomain"),
  ]);
  return Object.fromEntries(scripts.map((s) => [s, `https://${(domains ?? []).find((d) => d.service === s)?.hostname ?? `${s}.${subdomain}.workers.dev`}`]));
}
