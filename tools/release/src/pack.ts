// Архив модуля для каталога — одна упаковка для монорепо (release-cli) и чужого репо (parts.upload): папка модуля
// по её module.json → tgz, module.json первой записью, номер — из module.json.
//   sdk, библиотека   файлы пакета
//   web               module.json, WEB_FILE — сам модуль одним ES-файлом, рядом файлы пакета (контракт и стенд — чужим
//                     репо для тестов). Файл даёт bundle вызывающего (монорепо собирает его esbuild'ом), без bundle — тот,
//                     что лежит в папке (чужой репо собрал сам)
//   worker            только module.json, а в нём имена Worker'а по флотам из wrangler.jsonc (workers: {test, prod}) —
//                     руками имя пишется в одном месте, в wrangler
//   web-app           module.json с workers и статика оболочки — её dist/ (собирает вызывающий)
//   os                папка приложения: dist/ с app.json, иначе файлы пакета с app.json в корне
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { sha256hex } from "./hash.ts";
import { MANIFEST, pack, type TarFile } from "./tar.ts";
import { WEB_FILE } from "./web.ts";

/** Флот верхнего уровня wrangler-настройки; остальные — её env. */
export const BASE_FLEET = "test";

/** JSON с комментариями и запятыми в конце (wrangler.jsonc) → объект. */
export function jsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const s = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(s, i + 1);
    } else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i + 2) + 1;
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Имена Worker'а по флотам: верхний уровень — test, env.<флот> — свой name или name-<флот>, как у wrangler. */
export function workerNames(wrangler: { name: string; env?: Record<string, { name?: string }> }): Record<string, string> {
  const out: Record<string, string> = { [BASE_FLEET]: wrangler.name };
  for (const [fleet, e] of Object.entries(wrangler.env ?? {})) out[fleet] = e.name ?? `${wrangler.name}-${fleet}`;
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "test", "tests"]);
const SKIP_FILE = /(\.test\.|\.spec\.|^vitest\.config\.|^tsconfig.*\.json$|^wrangler\.(jsonc?|toml)$|^\.dev\.vars)/;

/** Файлы пакета, которые идут в выпуск: без тестов, настроек сборки и node_modules. Пути — через «/». */
export function packageFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(relative(dir, join(d, e.name)).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Все файлы папки с путями от неё; exec — исполняемые с режимом 755 (приложение ОС). */
function allFiles(dir: string, exec = false): TarFile[] {
  const out: TarFile[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) {
        const p = join(d, e.name);
        out.push({ path: relative(dir, p).split(sep).join("/"), data: readFileSync(p), ...(exec && statSync(p).mode & 0o111 ? { mode: 0o755 } : {}) });
      }
    }
  };
  walk(dir);
  return out;
}

export type ModuleJson = { name: string; version: string; type: string; workers?: unknown };
export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

/** Упаковать модуль из папки. bundle — модуль страницы одним файлом (монорепо); нет — файл из папки. Нет нужного — исключение словами. */
export function packModule(at: string, o: { bundle?: (dir: string, m: ModuleJson) => Buffer } = {}): PackedModule {
  const dir = resolve(at);
  if (!existsSync(join(dir, MANIFEST))) throw new Error(`no_module_json: в ${dir} нет ${MANIFEST}`);
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as ModuleJson;
  if (m.workers) throw new Error(`${m.name}: workers в module.json пишет упаковка из wrangler-настройки, не рука`);
  const json = (x: object): TarFile => ({ path: MANIFEST, data: Buffer.from(JSON.stringify(x, null, 2) + "\n") });
  // module.json как есть — тот же модуль даёт тот же архив и хэш, что и раньше
  const raw: TarFile = { path: MANIFEST, data: readFileSync(join(dir, MANIFEST)) };
  const pkg = (skip: string[] = []) => packageFiles(dir).filter((p) => p !== MANIFEST && !skip.includes(p)).map((p) => ({ path: p, data: readFileSync(join(dir, ...p.split("/"))) }));
  let files: TarFile[];
  if (m.type === "worker" || m.type === "web-app") {
    const w = join(dir, "wrangler.jsonc");
    if (!existsSync(w)) throw new Error(`${m.name}: у модуля типа ${m.type} нет wrangler.jsonc`);
    const head = json({ ...m, workers: workerNames(jsonc(readFileSync(w, "utf8")) as never) });
    if (m.type === "worker") files = [head];
    else {
      if (!existsSync(join(dir, "dist"))) throw new Error(`${m.name}: у оболочки нет dist/ — собери её статику`);
      files = [head, ...allFiles(join(dir, "dist")).filter((f) => f.path !== MANIFEST)];
    }
  } else if (m.type === "web") {
    const own = join(dir, WEB_FILE);
    if (!o.bundle && !existsSync(own)) throw new Error(`${m.name}: у модуля страницы нет ${WEB_FILE} — собери его одним файлом`);
    files = [json(m), { path: WEB_FILE, data: o.bundle ? o.bundle(dir, m) : readFileSync(own) }, ...pkg([WEB_FILE])];
  } else if (m.type === "os") {
    const app = existsSync(join(dir, "dist", "app.json")) ? join(dir, "dist") : existsSync(join(dir, "app.json")) ? dir : null;
    if (!app) throw new Error(`no_app_json: у приложения ОС ${m.name} нет app.json — ни в dist/, ни в корне`);
    files = [raw, ...(app === dir ? pkg() : allFiles(app, true).filter((f) => f.path !== MANIFEST))];
  } else files = [raw, ...pkg()];
  const tgz = pack(files);
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}
