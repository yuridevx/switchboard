// Каталог в R2 глазами одного запроса: части, их версии и манифесты, выложенные сборки. Вид части выводится из манифеста, списков нет.
import type { Manifest } from "@switchboard/manifest-gate";
import { BUILD_FILE, entries, manifestOf, presign, type BuildList } from "@switchboard/release";
import { stateOf, type CloudState } from "./cloud.ts";
import type { Env } from "./env.ts";
import type { Row } from "./fleet.ts";

const BUCKET = "switchboard-releases";
/** Манифест — первая запись архива: хватает начала. */
const HEAD_BYTES = 65_536;
const ROOTS = ["sdk-core", "web-app"];
const MACHINE = ["os", "sdk-core"];
const CLOUD = ["worker", "web-app"];

export const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
export const isBuild = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+\+\d+$/.test(v);
/** Сборка «+n» новее своего ядра. */
const numbers = (v: string) => [...v.split(/[.+]/).map(Number), 0];
export const byVersion = (a: string, b: string) => {
  const y = numbers(b);
  return numbers(a).reduce((order, n, i) => order || n - (y[i] ?? 0), 0);
};

export type ModuleManifest = Manifest & { workers?: Record<string, string> };
export type Part = {
  name: string;
  /** готовые версии каталога: лежит хэш */
  versions: string[];
  /** манифест новейшей версии; у архива без манифеста — null */
  manifest: ModuleManifest | null;
  kind: "machine" | "cloud" | "module" | null;
  /** корень сборки: его версии — сборки флота */
  root: boolean;
  /** имя Worker'а части в этом флоте */
  script?: string;
};
export type Cloud = { tags: string[]; stable: string | null; idOf(tag: string): string | undefined; live: string | null };
export type Catalog = ReturnType<typeof catalog>;

const once = <T>(load: (key: string) => Promise<T>) => {
  const seen = new Map<string, Promise<T>>();
  return (key: string): Promise<T> => {
    if (!seen.has(key)) seen.set(key, load(key));
    return seen.get(key)!;
  };
};

function cloudOf({ versions, live }: CloudState): Cloud {
  const tagged = versions.filter((v) => isVersion(v.tag) || isBuild(v.tag));
  return {
    tags: tagged.map((v) => v.tag!).sort(byVersion),
    stable: tagged.find((v) => v.id === live)?.tag ?? null,
    idOf: (tag) => tagged.find((v) => v.tag === tag)?.id,
    live,
  };
}

export function catalog(env: Env, row: Row) {
  async function listing(prefix?: string) {
    const out = { keys: [] as string[], prefixes: [] as string[] };
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, delimiter: "/", ...(cursor && { cursor }) });
      out.keys.push(...page.objects.map((o) => o.key));
      out.prefixes.push(...page.delimitedPrefixes);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  const ready = async (prefix: string) => {
    const hashes = (await listing(prefix)).keys.filter((k) => k.endsWith(".sha256"));
    return hashes.map((k) => k.slice(prefix.length, -".sha256".length)).filter((v) => isVersion(v) || isBuild(v)).sort(byVersion);
  };

  /** Ключ версии без расширения: сборки лежат под именем флота. */
  const key = (part: string, version: string) => (isBuild(version) ? `${env.FLEET}/${part}/${version}` : `${part}/${version}`);

  const manifest = once(async (at: string): Promise<ModuleManifest | null> => {
    const o = await env.BUCKET.get(`${at}.tgz`, { range: { offset: 0, length: HEAD_BYTES } });
    const raw = o && manifestOf(new Uint8Array(await o.arrayBuffer()));
    return raw ? ({ provides: {}, uses: {}, config: {}, ...raw } as ModuleManifest) : null;
  });

  const part = once(async (name: string): Promise<Part> => {
    const versions = await ready(`${name}/`);
    const edge = versions.at(-1);
    const m = edge ? await manifest(`${name}/${edge}`) : null;
    const script = m?.workers?.[env.FLEET];
    const kind = !m || MACHINE.includes(m.type) ? "machine" : m.into ? "module" : CLOUD.includes(m.type) && script ? "cloud" : null;
    return { name, versions, manifest: m, kind, root: !!m && ROOTS.includes(m.type), script };
  });

  const cloud = once(async (script: string) => cloudOf(await stateOf(env, script)));
  const builds = once((name: string) => ready(`${env.FLEET}/${name}/`));
  /** Номера части машины: сборки флота, а до первой сборки — версии каталога. */
  const onMachine = async (p: Part) => {
    const own = await builds(p.name);
    return own.length ? own : p.versions;
  };

  /** Все части каталога; папки флотов версий не держат и частями не считаются. */
  const all = async () => {
    const names = (await listing()).prefixes.map((p) => p.slice(0, -1));
    return (await Promise.all(names.map(part))).filter((p) => p.versions.length);
  };

  /** Выложенное у части: номер из строки флота, у части Cloudflare — метка выложенной версии. */
  const stableOf = async (p: Part) => (p.kind === "cloud" ? (await cloud(p.script!)).stable : (row.stable[p.name] ?? null));

  /** Список выложенной сборки; выложена не сборка — null. */
  const deployed = once(async (app: string): Promise<BuildList | null> => {
    const stable = await stableOf(await part(app));
    const o = isBuild(stable) ? await env.BUCKET.get(`${key(app, stable)}.tgz`) : null;
    return o && JSON.parse(entries(new Uint8Array(await o.arrayBuffer())).find((e) => e.path === BUILD_FILE)!.data!.toString("utf8"));
  });

  return {
    all,
    part,
    cloud,
    builds,
    onMachine,
    key,
    stableOf,
    deployed,
    manifest: (name: string, version: string) => manifest(key(name, version)),
    /** Архив версии. */
    archive: async (name: string, version: string) => new Uint8Array(await (await env.BUCKET.get(`${key(name, version)}.tgz`))!.arrayBuffer()),
    /** Хэш готовой версии; нет — null. */
    sha: async (name: string, version: string) => (await (await env.BUCKET.get(`${key(name, version)}.sha256`))?.text())?.split(/\s+/)[0] ?? null,
    link: (method: string, path: string) => presign({ accessKeyId: env.R2_LINK_KEY_ID, secretAccessKey: env.R2_LINK_SECRET }, { method, host: `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${BUCKET}/${path}` }),
  };
}
