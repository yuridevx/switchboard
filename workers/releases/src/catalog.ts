// Каталог в R2: версии части, сборки флота, манифесты и архивы. Версия готова, когда лежит её хэш.
import { entries, BUILD_FILE, byVersion, isBuild, isVersion, manifestOf, parseSha, shaKey, tgzKey, type BuildList } from "@switchboard/release";
import type { Manifest } from "@switchboard/manifest-gate";
import type { Env } from "./env.ts";

/** Начала архива хватает на манифест: он первая запись. */
const HEAD_BYTES = 64 * 1024;

export type Listed = Manifest & { into?: string[]; workers?: Record<string, string> };
/** Запись каталога: часть или модуль с новейшей версией. */
export type Entry = { name: string; versions: string[]; newest: string; manifest: Listed | null };

const SUFFIX = /^(.+)\.(tgz|sha256)$/;

/** Список R2 до конца: хранилище отдаёт кусками. */
async function listAll(env: Env, options: R2ListOptions): Promise<{ keys: string[]; prefixes: string[] }> {
  const keys: string[] = [];
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.BUCKET.list({ ...options, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    prefixes.push(...page.delimitedPrefixes);
    if (!page.truncated) return { keys, prefixes };
    cursor = page.cursor;
  }
}

/** Готовые версии под префиксом: и архив, и хэш; вложенные папки не считаются. */
async function readyUnder(env: Env, prefix: string, known: (v: string) => boolean): Promise<string[]> {
  const { keys } = await listAll(env, { prefix: `${prefix}/` });
  const seen = new Map<string, Set<string>>();
  for (const key of keys) {
    const m = SUFFIX.exec(key.slice(prefix.length + 1));
    if (!m || !known(m[1])) continue;
    if (!seen.has(m[1])) seen.set(m[1], new Set());
    seen.get(m[1])!.add(m[2]);
  }
  return [...seen].filter(([, kinds]) => kinds.size === 2).map(([v]) => v).sort(byVersion);
}

export const catalogVersions = (env: Env, part: string) => readyUnder(env, part, isVersion);
export const buildVersions = (env: Env, part: string) => readyUnder(env, `${env.FLEET}/${part}`, isBuild);

/** Папка версии: сборки лежат под именем флота. */
export const baseOf = (env: Env, part: string, version: string) => (isBuild(version) ? `${env.FLEET}/${part}` : part);
export const archiveKey = (env: Env, part: string, version: string) => tgzKey(baseOf(env, part, version), version);

/** Хэш готовой версии; не готова — null. */
export async function shaOf(env: Env, part: string, version: string): Promise<string | null> {
  const o = await env.BUCKET.get(shaKey(baseOf(env, part, version), version));
  return o ? parseSha(await o.text()) : null;
}

export async function archive(env: Env, part: string, version: string): Promise<Buffer> {
  const o = await env.BUCKET.get(archiveKey(env, part, version));
  return Buffer.from(await o!.arrayBuffer());
}

/** Манифест версии по началу архива; архив без манифеста (прежняя сборка Host) — null. */
export async function manifestAt(env: Env, part: string, version: string): Promise<Listed | null> {
  const o = await env.BUCKET.get(tgzKey(part, version), { range: { offset: 0, length: HEAD_BYTES } });
  if (!o) return null;
  const m = await manifestOf(new Uint8Array(await o.arrayBuffer()));
  return m ? ({ provides: {}, uses: {}, config: {}, ...m } as Listed) : null;
}

/** Запись каталога одного имени; версий нет — null. */
export async function entryOf(env: Env, name: string): Promise<Entry | null> {
  const versions = await catalogVersions(env, name);
  const newest = versions.at(-1);
  return newest ? { name, versions, newest, manifest: await manifestAt(env, name, newest) } : null;
}

/** Все имена бакета, одновременно. Папка другого флота готовых версий не содержит и отпадает. */
export async function scan(env: Env): Promise<Map<string, Entry>> {
  const { prefixes } = await listAll(env, { delimiter: "/" });
  const found = await Promise.all(prefixes.map((p) => entryOf(env, p.slice(0, -1))));
  return new Map(found.flatMap((e) => (e ? [[e.name, e] as const] : [])));
}

/** Список выложенной сборки. */
export async function buildListOf(env: Env, app: string, version: string): Promise<BuildList> {
  const file = entries(await archive(env, app, version)).find((e) => e.path === BUILD_FILE);
  return JSON.parse(file!.data!.toString("utf8")) as BuildList;
}

export const isRoot = (m: Listed | null) => m?.type === "sdk-core" || m?.type === "web-app";
export const isModule = (m: Listed | null) => !!m?.into?.length && (m.type === "sdk" || m.type === "web");
/** Часть Cloudflare этого флота: Worker или оболочка страницы с именем Worker'а. */
export const scriptOf = (env: Env, m: Listed | null) => (m?.type === "worker" || m?.type === "web-app" ? m.workers?.[env.FLEET] : undefined);
/** Вид части: модули сборки и библиотеки частями не бывают. */
export function whereOf(env: Env, m: Listed | null): "machine" | "cloud" | null {
  if (scriptOf(env, m)) return "cloud";
  return !m || m.type === "os" || m.type === "sdk-core" ? "machine" : null;
}
