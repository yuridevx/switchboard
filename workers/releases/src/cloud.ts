// API Cloudflare: версии Worker'а с меткой-номером, выложенная, выкладка, статика страницы, адреса.
import { sha256hex, type TarFile } from "@switchboard/release";
import { refuse, type Env } from "./env.ts";

const API = "https://api.cloudflare.com/client/v4/accounts/";
/** Вдвое выше самого долгого замера выкладки одной части целиком (3,6 с, три обращения). */
const API_MS = 8_000;
const NO_SCRIPT = 10007;
const COMPATIBILITY_DATE = "2026-10-01";
const TAG = "workers/tag";
const HEADERS_FILE = "_headers";
const TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  css: "text/css",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

type Body<T> = { success?: boolean; errors?: Array<{ code?: number }>; result: T };
const asJson = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value), headers: { "content-type": "application/json" } });

/** Результат; Worker'а нет — null. Ни запрос, ни токен в журнал не идут. */
async function call<T>(env: Env, path: string, init: RequestInit = {}, token = env.CLOUDFLARE_API_TOKEN): Promise<T | null> {
  const headers = { ...init.headers, authorization: `Bearer ${token}` };
  let r: Response;
  try {
    r = await fetch(`${API}${env.CF_ACCOUNT_ID}${path}`, { ...init, headers, signal: AbortSignal.timeout(API_MS) });
  } catch (e) {
    return refuse("cf_failed", (e as Error).name === "TimeoutError" ? "API Cloudflare: не ответил за 8 с" : `API Cloudflare: ${e}`);
  }
  const body = (await r.json().catch(() => null)) as Body<T> | null;
  if (body?.errors?.some((x) => x.code === NO_SCRIPT)) return null;
  if (r.ok && body?.success) return body.result;
  return refuse("cf_failed", `API Cloudflare ответил ${r.status}`, { status: r.status, errors: body?.errors });
}

export type CloudState = { versions: Array<{ id: string; tag?: string }>; live: string | null };

export async function stateOf(env: Env, script: string): Promise<CloudState> {
  const base = `/workers/scripts/${script}`;
  const [listed, deployed] = await Promise.all([
    call<{ items: Array<{ id: string; annotations?: Record<string, string> }> }>(env, `${base}/versions?per_page=100`),
    call<{ deployments: Array<{ versions: Array<{ version_id: string }> }> }>(env, `${base}/deployments`),
  ]);
  return { versions: (listed?.items ?? []).map((v) => ({ id: v.id, tag: v.annotations?.[TAG] })), live: deployed?.deployments[0]?.versions[0]?.version_id ?? null };
}

export const release = (env: Env, script: string, id: string) => call(env, `/workers/scripts/${script}/deployments`, asJson({ strategy: "percentage", versions: [{ version_id: id, percentage: 100 }] }));

/** Статика страницы новой версией Worker'а с меткой-номером и выкладка. */
export async function publish(env: Env, script: string, files: TarFile[], tag: string) {
  const extension = (path: string) => (path.includes(".") ? path.split(".").pop()! : "");
  const assets = files.filter((f) => f.path !== HEADERS_FILE).map((f) => ({ ...f, hash: sha256hex(Buffer.concat([f.data, Buffer.from(extension(f.path))])).slice(0, 32) }));
  const manifest = Object.fromEntries(assets.map((f) => [`/${f.path}`, { hash: f.hash, size: f.data.length }]));
  const session = (await call<{ jwt: string; buckets?: string[][] }>(env, `/workers/scripts/${script}/assets-upload-session`, asJson({ manifest })))!;
  let jwt = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const f of assets.filter((a) => bucket.includes(a.hash))) form.append(f.hash, new File([f.data.toString("base64")], f.hash, { type: TYPES[extension(f.path)] ?? "application/octet-stream" }));
    jwt = (await call<{ jwt: string }>(env, "/workers/assets/upload?base64=true", { method: "POST", body: form }, session.jwt))!.jwt ?? jwt;
  }
  const headers = files.find((f) => f.path === HEADERS_FILE)!.data.toString("utf8");
  const metadata = { compatibility_date: COMPATIBILITY_DATE, assets: { jwt, config: { _headers: headers } }, annotations: { [TAG]: tag } };
  const form = new FormData();
  form.append("metadata", new File([JSON.stringify(metadata)], "metadata", { type: "application/json" }));
  const { id } = (await call<{ id: string }>(env, `/workers/scripts/${script}/versions`, { method: "POST", body: form }))!;
  await release(env, script, id);
}

/** Адрес Worker'а: свой домен, иначе workers.dev. */
export async function addressing(env: Env): Promise<(script: string) => string> {
  const [sub, domains] = await Promise.all([call<{ subdomain: string }>(env, "/workers/subdomain"), call<Array<{ hostname: string; service: string }>>(env, "/workers/domains")]);
  return (script) => `https://${domains?.find((d) => d.service === script)?.hostname ?? `${script}.${sub!.subdomain}.workers.dev`}`;
}
