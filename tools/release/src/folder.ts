// Папка модуля → архив каталога: одна упаковка у CLI и инструмента сессии, вид модуля решает, что в архив идёт.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEB_FILE } from "./build.ts";
import { sha256hex } from "./sign.ts";
import { MANIFEST, pack, type TarFile } from "./tar.ts";

type Tool = { about: string; type: string; omit?: string[]; input?: Record<string, unknown> };
export type ModuleJson = { name: string; type: string; version: string; workers?: Record<string, string>; tools?: Record<string, Tool> };
/** Схема входа инструмента из типа запроса в contract.ts папки модуля. */
export type SchemaOf = (dir: string, type: string, omit?: string[]) => Record<string, unknown>;
export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

const NOT_PACKAGE = /^(\.|node_modules$|dist$|tests?$|tsconfig\.json$|vitest\.config\.ts$)|\.test\./;
const WRANGLER = "wrangler.jsonc";

function walk(dir: string, keep: (name: string) => boolean = () => true, at = ""): TarFile[] {
  return readdirSync(join(dir, at), { withFileTypes: true }).filter((e) => keep(e.name)).flatMap((e) => {
    const path = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(dir, keep, path);
    const full = join(dir, path);
    return [{ path, data: readFileSync(full), mode: statSync(full).mode & 0o111 ? 0o755 : 0o644 }];
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

/** bundle — файл модуля страницы от вызывающего; без него у страницы должен быть готовый module.js. schema — схемы входа инструментов MCP Worker-модуля. */
export function packModule(dir: string, o: { bundle?: (dir: string) => Buffer; schema?: SchemaOf } = {}): PackedModule {
  if (!existsSync(join(dir, MANIFEST))) throw new Error(`no_module_json: в ${dir} нет module.json`);
  const manifest = readFileSync(join(dir, MANIFEST));
  const m = JSON.parse(manifest.toString("utf8")) as ModuleJson;
  const stop = (why: string): never => {
    throw new Error(`${m.name}: ${why}`);
  };
  if (m.workers) stop("workers в module.json пишет упаковка из wrangler-настройки, не рука");
  if (Object.values(m.tools ?? {}).some((t) => t.input)) stop("input инструмента пишет упаковка из типа запроса, не рука");
  const tools = () => {
    if (!m.tools) return {};
    if (!o.schema) stop("у модуля есть tools — упаковке нужна схема входа (schema)");
    return { tools: Object.fromEntries(Object.entries(m.tools).map(([name, t]) => [name, { ...t, input: o.schema!(dir, t.type, t.omit) }])) };
  };
  const has = (path: string) => existsSync(join(dir, path));
  const named = (): TarFile => {
    if (!has(WRANGLER)) stop(`у модуля типа ${m.type} нет ${WRANGLER}`);
    return { path: MANIFEST, data: Buffer.from(`${JSON.stringify({ ...m, workers: workersOf(dir), ...tools() }, null, 2)}\n`) };
  };
  const os = (): TarFile[] => {
    if (!has("dist/app.json") && !has("app.json")) throw new Error(`no_app_json: у приложения ОС ${m.name} нет app.json — ни в dist/, ни в корне`);
    if (!has("dist/app.json")) return packageFiles(dir);
    return [{ path: MANIFEST, data: manifest }, ...walk(join(dir, "dist"))];
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
