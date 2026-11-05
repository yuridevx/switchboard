// Упаковка папки модуля в архив каталога: одна на CLI и инструмент сессии; вид архива задаёт тип модуля.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, pack, type TarFile } from "./archive.ts";
import { sha256hex } from "./layout.ts";
import { WEB_FILE } from "./page.ts";

export type ModuleJson = { name: string; version: string; type: string; workers?: Record<string, string>; [field: string]: unknown };
export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

const WRANGLER = "wrangler.jsonc";
const IS_TEST = /\.test\.|^tsconfig\.json$|^vitest\.config\.ts$/;
const NEVER = new Set(["node_modules", "test", "tests", "dist", ".wrangler"]);

/** Файлы папки от её корня, по именам. */
function walk(dir: string, keep: (name: string, isDir: boolean) => boolean, at = ""): TarFile[] {
  return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
    const path = at ? `${at}/${e.name}` : e.name;
    if (!keep(e.name, e.isDirectory())) return [];
    if (e.isDirectory()) return walk(dir, keep, path);
    const full = join(dir, path);
    return [{ path, data: readFileSync(full), mode: statSync(full).mode & 0o111 ? 0o755 : 0o644 }];
  });
}

/** Файлы пакета: всё, кроме тестов, настроек и собранного. */
export const packageFiles = (dir: string): TarFile[] => walk(dir, (name, isDir) => (isDir ? !NEVER.has(name) : !IS_TEST.test(name)));

const allFiles = (dir: string): TarFile[] => walk(dir, () => true);

/** JSON с комментариями и висячими запятыми: строки остаются как есть. */
function parseJsonc(text: string): Record<string, unknown> {
  const plain = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_all, str: string | undefined) => str ?? "");
  return JSON.parse(plain.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_all, str: string | undefined, end: string) => str ?? end)) as Record<string, unknown>;
}

/** Имя Worker'а по флотам: основное имя — флот test, у прочих своё name или «имя-флот». */
function workerNames(dir: string): Record<string, string> {
  const w = parseJsonc(readFileSync(join(dir, WRANGLER), "utf8")) as { name: string; env?: Record<string, { name?: string }> };
  return { test: w.name, ...Object.fromEntries(Object.entries(w.env ?? {}).map(([fleet, x]) => [fleet, x.name ?? `${w.name}-${fleet}`])) };
}

/** Манифест с именами Worker'а: их пишет упаковка, не рука. */
function namedManifest(dir: string, m: ModuleJson): TarFile {
  return { path: MANIFEST, data: Buffer.from(JSON.stringify({ ...m, workers: workerNames(dir) }, null, 2) + "\n") };
}

function needWrangler(dir: string, m: ModuleJson): void {
  if (!existsSync(join(dir, WRANGLER))) throw new Error(`${m.name}: у модуля типа ${m.type} нет ${WRANGLER}`);
}

/** Архив модуля по его типу. raw — module.json байт в байт; bundle — один файл страницы от вызывающего. */
function filesOf(dir: string, m: ModuleJson, raw: TarFile, bundle?: () => Uint8Array): TarFile[] {
  const dist = join(dir, "dist");
  switch (m.type) {
    case "worker":
      needWrangler(dir, m);
      return [namedManifest(dir, m)];
    case "web-app":
      needWrangler(dir, m);
      if (!existsSync(dist)) throw new Error(`${m.name}: у оболочки нет dist/ — собери её статику`);
      return [namedManifest(dir, m), ...allFiles(dist)];
    case "web": {
      const file = bundle?.() ?? (existsSync(join(dir, WEB_FILE)) ? readFileSync(join(dir, WEB_FILE)) : null);
      if (!file) throw new Error(`${m.name}: у модуля страницы нет ${WEB_FILE} — собери его одним файлом`);
      return [raw, ...packageFiles(dir).filter((f) => f.path !== MANIFEST && f.path !== WEB_FILE), { path: WEB_FILE, data: file }];
    }
    case "os":
      if (existsSync(join(dist, "app.json"))) return [raw, ...allFiles(dist)];
      if (!existsSync(join(dir, "app.json"))) throw new Error(`no_app_json: у приложения ОС ${m.name} нет app.json — ни в dist/, ни в корне`);
      return [raw, ...packageFiles(dir).filter((f) => f.path !== MANIFEST)];
    default:
      return [raw, ...packageFiles(dir).filter((f) => f.path !== MANIFEST)];
  }
}

export function packModule(dir: string, o: { bundle?: () => Uint8Array } = {}): PackedModule {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) throw new Error(`no_module_json: в ${dir} нет ${MANIFEST}`);
  const data = readFileSync(path);
  const m = JSON.parse(data.toString("utf8")) as ModuleJson;
  if (m.workers) throw new Error(`${m.name}: workers в ${MANIFEST} пишет упаковка из wrangler-настройки, не рука`);
  const tgz = pack(filesOf(dir, m, { path: MANIFEST, data }, o.bundle));
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}
