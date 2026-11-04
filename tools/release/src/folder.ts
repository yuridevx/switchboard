// Папка модуля → архив каталога по её module.json: одна упаковка для монорепо и чужого репо. module.json первым, номер — из него.
//   worker    только module.json с именами Worker'а по флотам из wrangler.jsonc: руками имя пишется в одном месте
//   web-app   то же плюс статика оболочки — dist/
//   web       module.json, модуль одним ES-файлом (WEB_FILE: собирает bundle вызывающего или лежит в папке), рядом файлы пакета — контракт и стенд чужим репо
//   os        module.json и папка приложения: dist/ с app.json, иначе файлы пакета с app.json в корне
//   иначе     файлы пакета
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MANIFEST, pack, type TarFile } from "./archive.ts";
import { sha256hex } from "./layout.ts";
import { WEB_FILE } from "./page.ts";

export type ModuleJson = { name: string; version: string; type: string; workers?: unknown };
export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

/** Флот верхнего уровня wrangler-настройки; остальные — её env. */
const BASE_FLEET = "test";

/** JSON с комментариями и запятой в конце → объект. */
function parseJsonc(text: string): unknown {
  const bare = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ""));
  return JSON.parse(bare.replace(/,(\s*[}\]])/g, "$1"));
}

/** Имена Worker'а по флотам, как у wrangler: env.<флот> — свой name или name-<флот>. */
function workerNames(dir: string): Record<string, string> {
  const w = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as { name: string; env?: Record<string, { name?: string }> };
  return { [BASE_FLEET]: w.name, ...Object.fromEntries(Object.entries(w.env ?? {}).map(([fleet, e]) => [fleet, e.name ?? `${w.name}-${fleet}`])) };
}

const NOT_RELEASED_FOLDER = new Set(["node_modules", "dist", ".wrangler", "test", "tests"]);
const NOT_RELEASED_FILE = /\.test\.|\.spec\.|^vitest\.config\.|^tsconfig.*\.json$|^wrangler\.(jsonc?|toml)$|^\.dev\.vars/;

/** Пути всех файлов папки от неё, через «/»; into — заходить ли в подпапку. */
function walk(dir: string, into: (name: string) => boolean = () => true): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const at = join(dir, e.name);
    if (e.isDirectory()) return into(e.name) ? walk(at, into).map((p) => `${e.name}/${p}`) : [];
    return e.isFile() ? [e.name] : [];
  });
}

/** Файлы пакета, которые идут в выпуск: без тестов, настроек сборки и node_modules. */
export function packageFiles(dir: string): string[] {
  return walk(dir, (name) => !NOT_RELEASED_FOLDER.has(name))
    .filter((p) => !NOT_RELEASED_FILE.test(p.slice(p.lastIndexOf("/") + 1)))
    .sort();
}

/** Упаковать модуль из папки. bundle — модуль страницы одним файлом; нет — файл из папки. Нет нужного — исключение словами. */
export function packModule(at: string, o: { bundle?: (dir: string, m: ModuleJson) => Buffer } = {}): PackedModule {
  const dir = resolve(at);
  const manifestFile = join(dir, MANIFEST);
  if (!existsSync(manifestFile)) throw new Error(`no_module_json: в ${dir} нет ${MANIFEST}`);
  const raw = readFileSync(manifestFile);
  const m = JSON.parse(raw.toString("utf8")) as ModuleJson;
  if (m.workers) throw new Error(`${m.name}: workers в module.json пишет упаковка из wrangler-настройки, не рука`);
  const tgz = pack(filesOf(dir, m, raw, o.bundle));
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}

function filesOf(dir: string, m: ModuleJson, raw: Buffer, bundle?: (dir: string, m: ModuleJson) => Buffer): TarFile[] {
  const manifest = (x: object): TarFile => ({ path: MANIFEST, data: Buffer.from(`${JSON.stringify(x, null, 2)}\n`) });
  const asIs: TarFile = { path: MANIFEST, data: raw };
  const inFolder = (paths: string[]): TarFile[] => paths.filter((p) => p !== MANIFEST).map((path) => ({ path, data: readFileSync(join(dir, ...path.split("/"))) }));
  const pkg = () => inFolder(packageFiles(dir));
  const named = () => {
    if (!existsSync(join(dir, "wrangler.jsonc"))) throw new Error(`${m.name}: у модуля типа ${m.type} нет wrangler.jsonc`);
    return manifest({ ...m, workers: workerNames(dir) });
  };
  switch (m.type) {
    case "worker":
      return [named()];
    case "web-app": {
      const head = named();
      const dist = join(dir, "dist");
      if (!existsSync(dist)) throw new Error(`${m.name}: у оболочки нет dist/ — собери её статику`);
      return [head, ...distFiles(dist)];
    }
    case "web": {
      const own = join(dir, WEB_FILE);
      if (!bundle && !existsSync(own)) throw new Error(`${m.name}: у модуля страницы нет ${WEB_FILE} — собери его одним файлом`);
      return [manifest(m), { path: WEB_FILE, data: bundle ? bundle(dir, m) : readFileSync(own) }, ...pkg().filter((f) => f.path !== WEB_FILE)];
    }
    case "os": {
      const dist = join(dir, "dist");
      if (existsSync(join(dist, "app.json"))) return [asIs, ...distFiles(dist, true)];
      if (existsSync(join(dir, "app.json"))) return [asIs, ...pkg()];
      throw new Error(`no_app_json: у приложения ОС ${m.name} нет app.json — ни в dist/, ни в корне`);
    }
    default:
      return [asIs, ...pkg()];
  }
}

/** Все файлы dist/ без манифеста; приложению ОС исполняемые остаются исполняемыми. */
function distFiles(dist: string, keepExec = false): TarFile[] {
  return walk(dist)
    .filter((p) => p !== MANIFEST)
    .map((path) => {
      const at = join(dist, ...path.split("/"));
      return { path, data: readFileSync(at), ...(keepExec && statSync(at).mode & 0o111 ? { mode: 0o755 } : {}) };
    });
}
