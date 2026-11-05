// Папка модуля → архив каталога: одна упаковка у CLI и инструмента сессии, вид модуля решает, что в архив идёт.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEB_FILE } from "./build.ts";
import { sha256hex } from "./sign.ts";
import { MANIFEST, pack, type TarFile } from "./tar.ts";

export type ModuleJson = { name: string; type: string; version: string; workers?: Record<string, string> };
export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

const NOT_PACKAGE = /^(\.|node_modules$|dist$|tests?$|tsconfig\.json$|vitest\.config\.ts$)|\.test\./;
const WRANGLER = "wrangler.jsonc";
/** Как git отличает двоичный файл: нулевой байт в начале. */
const TEXT_PROBE = 8000;

/** Переводы строк клона в архив не идут: текст — с LF, двоичное — как есть. */
export const lf = (data: Buffer): Buffer => (data.subarray(0, TEXT_PROBE).includes(0) ? data : Buffer.from(data.toString("latin1").replaceAll("\r\n", "\n"), "latin1"));

function walk(dir: string, keep: (name: string) => boolean = () => true, at = ""): TarFile[] {
  return readdirSync(join(dir, at), { withFileTypes: true }).filter((e) => keep(e.name)).flatMap((e) => {
    const path = at ? `${at}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, keep, path) : [{ path, data: lf(readFileSync(join(dir, path))) }];
  });
}

/** Файлы пакета без тестов, настроек и собранного. */
export const packageFiles = (dir: string): TarFile[] => walk(dir, (name) => !NOT_PACKAGE.test(name));

/** Имена Worker'а по флотам из настройки wrangler; тестовый флот — верхнее имя. */
function workersOf(dir: string): Record<string, string> {
  const keepStrings = (re: RegExp, text: string) => text.replace(re, (hit, str) => str ?? "");
  const text = readFileSync(join(dir, WRANGLER), "utf8");
  const json = keepStrings(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, keepStrings(/("(?:\\.|[^"\\])*")|\/\/.*|\/\*[\s\S]*?\*\//g, text));
  const { name, env = {} } = JSON.parse(json) as { name: string; env?: Record<string, { name?: string }> };
  return { test: name, ...Object.fromEntries(Object.entries(env).map(([fleet, c]) => [fleet, c.name ?? `${name}-${fleet}`])) };
}

/** bundle — файл модуля страницы от вызывающего; без него у страницы должен быть готовый module.js. */
export function packModule(dir: string, o: { bundle?: (dir: string) => Buffer } = {}): PackedModule {
  if (!existsSync(join(dir, MANIFEST))) throw new Error(`no_module_json: в ${dir} нет module.json`);
  const manifest = lf(readFileSync(join(dir, MANIFEST)));
  const m = JSON.parse(manifest.toString("utf8")) as ModuleJson;
  const stop = (why: string): never => {
    throw new Error(`${m.name}: ${why}`);
  };
  if (m.workers) stop("workers в module.json пишет упаковка из wrangler-настройки, не рука");
  const has = (path: string) => existsSync(join(dir, path));
  const named = (): TarFile => {
    if (!has(WRANGLER)) stop(`у модуля типа ${m.type} нет ${WRANGLER}`);
    return { path: MANIFEST, data: Buffer.from(`${JSON.stringify({ ...m, workers: workersOf(dir) }, null, 2)}\n`) };
  };
  const os = (): TarFile[] => {
    if (!has("dist/app.json") && !has("app.json")) throw new Error(`no_app_json: у приложения ОС ${m.name} нет app.json — ни в dist/, ни в корне`);
    if (!has("dist")) return packageFiles(dir);
    const mode = (f: TarFile) => (statSync(join(dir, "dist", f.path)).mode & 0o111 ? 0o755 : 0o644);
    return [{ path: MANIFEST, data: manifest }, ...walk(join(dir, "dist")).map((f) => ({ ...f, mode: mode(f) }))];
  };
  const shell = (): TarFile[] => {
    const head = named();
    if (!has("dist")) stop("у оболочки нет dist/ — собери её статику");
    return [head, ...walk(join(dir, "dist"))];
  };
  const page = (): TarFile[] => {
    const files = packageFiles(dir).filter((f) => !o.bundle || f.path !== WEB_FILE);
    if (o.bundle) return [...files, { path: WEB_FILE, data: o.bundle(dir) }];
    return files.some((f) => f.path === WEB_FILE) ? files : stop(`у модуля страницы нет ${WEB_FILE} — собери его одним файлом`);
  };
  const by: Record<string, () => TarFile[]> = { worker: () => [named()], "web-app": shell, os, web: page };
  const tgz = pack((by[m.type] ?? (() => packageFiles(dir)))());
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}
