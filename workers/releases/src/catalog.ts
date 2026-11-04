// Что лежит в каталоге на один запрос: готовые версии в R2 (готова та, у которой лежит .sha256), манифесты, вид части, сборки флота, ссылки.
// Вид части — по module.json новейшей версии: workers.<флот> — часть Cloudflare; тип os, корень сборки ядра или архив без манифеста — часть машины;
// остальные модули входят в сборки и частями не бывают. Ключ сборки — <флот>/<приложение>/<номер>, версии каталога — <модуль>/<номер>.
import { BUILD_FILE, byVersion, entries, isBuild, isVersion, manifestOf, parseSha, presign, RELEASES_BUCKET, shaKey, tgzKey, type BuildList } from "@switchboard/release";
import type { Manifest } from "@switchboard/manifest-gate";
import { deployed, versions } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import type { Fleet } from "./fleet.ts";
import { Refusal } from "./refusal.ts";

export type Part = { where: "cloud"; script: string; app: boolean } | { where: "machine"; app: boolean };
export type Mod = Manifest & { into?: string[]; workers?: Record<string, string> };
export type Entry = { versions: string[]; manifest: Mod | null };
type File = { path: string; data: Buffer };

/** Начало архива, которого хватает на module.json. */
const HEAD = 64 * 1024;

/** Имя части, модуля или машины. */
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const newest = (vs: Iterable<string>) => [...vs].filter(isVersion).sort(byVersion).pop() ?? null;

export class Catalog {
  private env: Env;
  private modules?: Promise<Map<string, Entry>>;
  constructor(env: Env) {
    this.env = env;
  }

  private key(part: string, version: string, of: typeof tgzKey): string {
    return isBuild(version) ? `${this.env.FLEET}/${of(part, version)}` : of(part, version);
  }
  tgz = (part: string, version: string) => this.key(part, version, tgzKey);
  shaFile = (part: string, version: string) => this.key(part, version, shaKey);

  /** Все ключи под префиксом, сколько бы ответов ни понадобилось. */
  private async keys(prefix?: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix, cursor });
      out.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Готовые версии под папкой. */
  async ready(prefix: string): Promise<string[]> {
    const found = (await this.keys(prefix)).filter((k) => k.endsWith(".sha256")).map((k) => k.slice(prefix.length, -".sha256".length));
    return found.filter(isVersion).sort(byVersion);
  }

  /** Хэш готовой версии, иначе null. */
  async sha(part: string, version: string): Promise<string | null> {
    const o = await this.env.BUCKET.get(this.shaFile(part, version));
    return o ? parseSha(await o.text()) : null;
  }

  /** module.json версии каталога по началу архива; архив без манифеста — null. */
  async manifest(part: string, version: string): Promise<Mod | null> {
    const o = await this.env.BUCKET.get(tgzKey(part, version), { range: { offset: 0, length: HEAD } });
    return o ? ((await manifestOf(new Uint8Array(await o.arrayBuffer()))) as Mod | null) : null;
  }

  /** Каталог: модуль → готовые версии и манифест новейшей. Сборки флотов — не каталог. Читается один раз на запрос. */
  all(): Promise<Map<string, Entry>> {
    this.modules ??= (async () => {
      const ready = new Map<string, string[]>();
      for (const key of await this.keys()) {
        const m = /^([^/]*)\/(.*)\.sha256$/.exec(key);
        if (m && isVersion(m[2]) && !isBuild(m[2])) ready.set(m[1], [...(ready.get(m[1]) ?? []), m[2]]);
      }
      const read = await Promise.all(
        [...ready].map(async ([name, vs]) => {
          const sorted = vs.sort(byVersion);
          return [name, { versions: sorted, manifest: await this.manifest(name, sorted.at(-1)!) }] as const;
        }),
      );
      return new Map(read);
    })();
    return this.modules;
  }

  /** Вид части по манифесту её новейшей версии; модуль сборки — null. */
  partOf(m: Mod | null): Part | null {
    const script = m?.workers?.[this.env.FLEET];
    if (script) return { where: "cloud", script, app: m?.type === "web-app" };
    return !m || m.type === "os" || m.type === "sdk-core" ? { where: "machine", app: m?.type === "sdk-core" } : null;
  }

  async parts(): Promise<Map<string, Part>> {
    const out = new Map<string, Part>();
    for (const [name, { manifest }] of await this.all()) {
      const part = this.partOf(manifest);
      if (part) out.set(name, part);
    }
    return out;
  }

  /** Сборки приложения этого флота. */
  builds = (app: string) => this.ready(`${this.env.FLEET}/${app}/`);

  /** Готовые версии части машины: у корня сборки — сборки флота, у остальных — версии каталога. */
  async machineVersions(part: string): Promise<string[]> {
    return (await this.parts()).get(part)?.app ? this.builds(part) : this.ready(`${part}/`);
  }

  /** Worker в Cloudflare: метки версий, id выложенной и её метка. */
  async live(script: string): Promise<{ tags: Map<string, string>; id: string | null; tag: string | null }> {
    const [tags, id] = await Promise.all([versions(this.env, script), deployed(this.env, script)]);
    return { tags, id, tag: [...tags].find(([, v]) => v === id)?.[0] ?? null };
  }

  /** Номер текущей сборки приложения: Host — stable флота, страница — метка выложенной версии её Worker'а. */
  async currentBuild(app: string, fleet: Fleet): Promise<string | null> {
    const part = (await this.parts()).get(app);
    return part?.where === "cloud" ? (await this.live(part.script)).tag : (fleet.stable[app] ?? null);
  }

  /** Архив целиком: файлы с данными. */
  async files(key: string): Promise<File[]> {
    const o = await this.env.BUCKET.get(key);
    if (!o) throw new Refusal("no_release", `в R2 нет ${key}`);
    return entries(Buffer.from(await o.arrayBuffer())).filter((e) => e.data) as File[];
  }

  /** Состав приложения: из его сборки, а до первой сборки — корень и все модули каталога с into приложения, новейшие. */
  async contents(app: string, build: string | null): Promise<Map<string, string>> {
    if (build && isBuild(build)) {
      const file = (await this.files(this.tgz(app, build))).find((f) => f.path === BUILD_FILE)!;
      const list = JSON.parse(file.data.toString("utf8")) as BuildList;
      return new Map([[app, list.version.split("+")[0]], ...list.modules.map((m) => [m.name, m.version] as [string, string])]);
    }
    const all = await this.all();
    const own = [...all].filter(([, e]) => e.manifest?.into?.includes(app)).map(([n, e]) => [n, e.versions.at(-1)!] as [string, string]);
    return new Map([[app, all.get(app)!.versions.at(-1)!], ...own]);
  }

  link(method: "GET" | "PUT", key: string): Promise<string> {
    return presign(
      { accessKeyId: this.env.R2_LINK_KEY_ID, secretAccessKey: this.env.R2_LINK_SECRET },
      { method, host: `${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${RELEASES_BUCKET}/${key}`, now: new Date() },
    );
  }
}
