// API Cloudflare: версии Worker'ов с меткой-номером, выкладка, адреса, загрузка статики. Предел обращения 8 с: вдвое выше самого долгого замера выкладки одной части (3,6 с, три обращения).
import { byVersion, isBuild, isVersion } from "@switchboard/release";
import type { Env } from "./env.ts";
import { Refusal } from "./refusal.ts";

const CALL_MS = 8_000;
/** Worker'а во флоте нет: модуль в каталоге есть, но не выложен. */
const NO_SCRIPT = 10007;
const COMPATIBILITY_DATE = "2026-10-01";
const TYPES: Record<string, string> = { html: "text/html", js: "application/javascript", json: "application/json", webmanifest: "application/manifest+json", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", css: "text/css" };

class NoScript extends Error {}

async function api<T>(env: Env, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token = env.CLOUDFLARE_API_TOKEN, ...rest } = init;
  const ac = new AbortController();
  const late = setTimeout(() => ac.abort(new Error("late")), CALL_MS);
  let r: Response;
  try {
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, { ...rest, headers: { ...rest.headers, authorization: `Bearer ${token}` }, signal: ac.signal });
  } catch (e) {
    throw new Refusal("cf_failed", ac.signal.aborted ? `API Cloudflare: не ответил за ${CALL_MS / 1000} с` : `API Cloudflare: ${String(e)}`);
  } finally {
    clearTimeout(late);
  }
  const body = (await r.json().catch(() => null)) as { success?: boolean; result?: T; errors?: Array<{ code?: number }> } | null;
  if (body?.errors?.some((x) => x.code === NO_SCRIPT)) throw new NoScript();
  if (!r.ok || !body?.success) throw new Refusal("cf_failed", `API Cloudflare ответил ${r.status}`, { status: r.status, errors: body?.errors });
  return body.result as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export type Versions = { tags: string[]; idOf: Map<string, string>; live: string | null };

/** Версии Worker'а с меткой-номером по порядку и выложенная. Выложено мимо «Выпусков» — live null. */
export async function versionsOf(env: Env, script: string): Promise<Versions> {
  try {
    const base = `/workers/scripts/${script}`;
    const [{ items }, { deployments }] = await Promise.all([
      api<{ items: Array<{ id: string; annotations?: Record<string, string> }> }>(env, `${base}/versions?per_page=100`),
      api<{ deployments: Array<{ versions: Array<{ version_id: string }> }> }>(env, `${base}/deployments`),
    ]);
    const tagged = items.flatMap((v) => {
      const tag = v.annotations?.["workers/tag"];
      return isVersion(tag) || isBuild(tag) ? [[tag, v.id] as const] : [];
    });
    const idOf = new Map(tagged);
    const liveId = deployments[0]?.versions[0]?.version_id;
    return { tags: [...idOf.keys()].sort(byVersion), idOf, live: tagged.find(([, id]) => id === liveId)?.[0] ?? null };
  } catch (e) {
    if (e instanceof NoScript) return { tags: [], idOf: new Map(), live: null };
    throw e;
  }
}

export async function deployVersion(env: Env, script: string, versionId: string): Promise<void> {
  await api(env, `/workers/scripts/${script}/deployments`, json({ strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }));
}

/** Адреса Worker'ов: свой домен, иначе workers.dev. */
export async function addressesOf(env: Env, scripts: Map<string, string>): Promise<Record<string, string>> {
  if (!scripts.size) return {};
  const [domains, { subdomain }] = await Promise.all([api<Array<{ hostname: string; service: string }>>(env, "/workers/domains"), api<{ subdomain: string }>(env, "/workers/subdomain")]);
  return Object.fromEntries([...scripts].map(([name, script]) => [name, `https://${domains?.find((d) => d.service === script)?.hostname ?? `${script}.${subdomain}.workers.dev`}`]));
}

const extension = (path: string) => path.split(".").pop() ?? "";

/** Хэш файла статики в манифесте загрузки: 32 знака от содержимого и расширения. */
async function assetHash(path: string, data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([...data, ...new TextEncoder().encode(extension(path))]));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

type File_ = { path: string; data: Buffer };

/** Загрузить статику: сессия, недостающие файлы пачками; ответ — ключ для версии. */
async function uploadAssets(env: Env, script: string, files: File_[]): Promise<string> {
  const byHash = new Map<string, File_>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const hash = await assetHash(f.path, f.data);
    manifest[`/${f.path}`] = { hash, size: f.data.length };
    byHash.set(hash, f);
  }
  const session = await api<{ jwt: string; buckets?: string[][] }>(env, `/workers/scripts/${script}/assets-upload-session`, json({ manifest }));
  let done = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) {
      const f = byHash.get(hash)!;
      form.append(hash, new File([f.data.toString("base64")], hash, { type: TYPES[extension(f.path)] ?? "application/octet-stream" }));
    }
    const r = await api<{ jwt?: string } | null>(env, "/workers/assets/upload?base64=true", { method: "POST", token: session.jwt, body: form });
    if (r?.jwt) done = r.jwt;
  }
  return done;
}

/** Версия Worker'а со статикой и меткой-номером, сразу выложена. _headers — правила, а не файл. */
export async function publishStatic(env: Env, script: string, tag: string, files: File_[]): Promise<void> {
  const rules = files.find((f) => f.path === "_headers");
  const jwt = await uploadAssets(env, script, files.filter((f) => f !== rules));
  const metadata = { compatibility_date: COMPATIBILITY_DATE, assets: { jwt, config: rules ? { _headers: rules.data.toString("utf8") } : {} }, annotations: { "workers/tag": tag } };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  const { id } = await api<{ id: string }>(env, `/workers/scripts/${script}/versions`, { method: "POST", body: form });
  await deployVersion(env, script, id);
}
