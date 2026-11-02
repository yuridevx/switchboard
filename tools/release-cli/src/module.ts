// Архив модуля для каталога: module.json первой записью; номер — из module.json.
// Модуль Host, библиотека — папка пакета. Модуль страницы (web) — module.json и один ES-файл WEB_FILE: импорты других
// модулей страницы остаются внешними (страница разрешает их import map'ом сборки), остальное вкладывается внутрь.
// Worker — только module.json, а в нём имена Worker'а по флотам из wrangler-настройки (workers: {test, prod}) — руками
// имя пишется в одном месте, в wrangler. Оболочка страницы (web-app) — Worker со статикой: module.json с workers и
// статика из её dist/ после её же build.mjs — страница, обработчик пушей, значки; адресов relay и Worker'ов в ней нет.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { buildSync } from "esbuild";
import { MANIFEST, pack, sha256hex, WEB_FILE, type TarFile } from "@switchboard/release";
import { packageFiles } from "./build.ts";

/** Типы модулей, которые выкладываются версией Worker'а. */
export const CLOUD_TYPES = new Set(["worker", "web-app"]);

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

export type PackedModule = { name: string; version: string; tgz: Buffer; sha: string };

type Json = { name: string; version: string; type: string; workers?: unknown };
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](@switchboard\/[a-z0-9-]+)["'/]/g;
const SRC = /\.(ts|mts|js|mjs)$/;

/** Пакеты @switchboard — модули страницы, которые импортирует код модуля в dir: они остаются внешними. */
function webImports(dir: string, self: string): string[] {
  const req = createRequire(join(dir, "noop.js"));
  const found = new Set<string>();
  for (const f of packageFiles(dir)) {
    if (!SRC.test(f) || f.endsWith(".d.ts") || f.startsWith("stand/")) continue;
    for (const m of readFileSync(join(dir, ...f.split("/")), "utf8").matchAll(IMPORT)) found.add(m[1]);
  }
  return [...found].filter((spec) => {
    // папка пакета — вверх от его входа до package.json; модуль страницы — module.json типа web рядом
    for (let d = dirname(req.resolve(spec)); dirname(d) !== d; d = dirname(d)) {
      if (!existsSync(join(d, "package.json"))) continue;
      const mj = join(d, MANIFEST);
      const m = existsSync(mj) ? (JSON.parse(readFileSync(mj, "utf8")) as Json) : null;
      return m?.type === "web" && m.name !== self;
    }
    return false;
  });
}

/** Модуль страницы одним ES-файлом: вход — exports["."] пакета, без пакета — contract.ts. */
function bundleWeb(dir: string, m: Json): Buffer {
  const pj = join(dir, "package.json");
  const exp = existsSync(pj) ? (JSON.parse(readFileSync(pj, "utf8")) as { exports?: Record<string, string> }).exports?.["."] : undefined;
  const r = buildSync({
    entryPoints: [join(dir, exp ?? "contract.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    external: webImports(dir, m.name),
    logLevel: "silent",
  });
  return Buffer.from(r.outputFiles[0].contents);
}

/** Статика оболочки: её build.mjs кладёт её в dist/. */
function shellFiles(dir: string): TarFile[] {
  execFileSync(process.execPath, ["build.mjs"], { cwd: dir, stdio: "pipe" });
  const out: TarFile[] = [];
  const dist = join(dir, "dist");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) out.push({ path: relative(dist, join(d, e.name)).split(sep).join("/"), data: readFileSync(join(d, e.name)) });
    }
  };
  walk(dist);
  return out;
}

/** Упаковать модуль из папки. */
export function packModule(at: string): PackedModule {
  const dir = resolve(at);
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Json;
  if (m.workers) throw new Error(`${m.name}: workers в module.json пишет загрузка из wrangler-настройки, не рука`);
  const json = (x: object): TarFile => ({ path: MANIFEST, data: Buffer.from(JSON.stringify(x, null, 2) + "\n") });
  let files: TarFile[];
  if (CLOUD_TYPES.has(m.type)) {
    const w = join(dir, "wrangler.jsonc");
    if (!existsSync(w)) throw new Error(`${m.name}: у модуля типа ${m.type} нет wrangler.jsonc`);
    files = [json({ ...m, workers: workerNames(jsonc(readFileSync(w, "utf8")) as never) }), ...(m.type === "web-app" ? shellFiles(dir) : [])];
  } else if (m.type === "web") files = [json(m), { path: WEB_FILE, data: bundleWeb(dir, m) }];
  else files = packageFiles(dir).map((p) => ({ path: p, data: readFileSync(join(dir, ...p.split("/"))) }));
  const tgz = pack(files);
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}
