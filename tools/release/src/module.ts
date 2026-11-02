// Архив модуля для каталога: папка пакета с module.json первой записью; номер — из module.json.
// Worker и оболочка страницы — части Cloudflare: в архиве только module.json, а в нём имена Worker'а по флотам
// из wrangler-настройки (workers: {test, prod}) — руками имя пишется в одном месте, в wrangler.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageFiles } from "./build.ts";
import { sha256hex } from "./hash.ts";
import { MANIFEST, pack, type TarFile } from "./tar.ts";

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

/** Упаковать модуль из папки. */
export function packModule(dir: string): PackedModule {
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { name: string; version: string; type: string; workers?: unknown };
  if (m.workers) throw new Error(`${m.name}: workers в module.json пишет загрузка из wrangler-настройки, не рука`);
  let files: TarFile[];
  if (CLOUD_TYPES.has(m.type)) {
    const w = join(dir, "wrangler.jsonc");
    if (!existsSync(w)) throw new Error(`${m.name}: у модуля типа ${m.type} нет wrangler.jsonc`);
    const manifest = { ...m, workers: workerNames(jsonc(readFileSync(w, "utf8")) as never) };
    files = [{ path: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }];
  } else files = packageFiles(dir).map((p) => ({ path: p, data: readFileSync(join(dir, ...p.split("/"))) }));
  const tgz = pack(files);
  return { name: m.name, version: m.version, tgz, sha: sha256hex(tgz) };
}
