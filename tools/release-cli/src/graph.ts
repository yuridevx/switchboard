// Граф пакетов монорепо: что есть в workspaces и какие пакеты @switchboard импортирует код. Один разбор для ядра Host и модулей страницы.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageFiles } from "@switchboard/release";

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](@switchboard\/[a-z0-9-]+)["'/]/g;

export const readJson = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;

/** Пакеты workspaces монорепо: имя → папка. */
export function workspaces(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (dir: string) => {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) out.set(readJson<{ name: string }>(pj).name, dir);
  };
  for (const glob of readJson<{ workspaces?: string[] }>(join(root, "package.json")).workspaces ?? []) {
    if (!glob.endsWith("/*")) add(join(root, glob));
    else {
      const base = join(root, glob.slice(0, -2));
      if (existsSync(base)) for (const d of readdirSync(base)) if (statSync(join(base, d)).isDirectory()) add(join(base, d));
    }
  }
  return out;
}

/** Пакеты @switchboard, которые импортирует код пакета; skip — файлы, которые не считаются. */
export function importsOf(dir: string, skip: (path: string) => boolean = () => false): string[] {
  const found = new Set<string>();
  for (const f of packageFiles(dir)) {
    if (!SOURCE.test(f) || f.endsWith(".d.ts") || skip(f)) continue;
    for (const m of readFileSync(join(dir, ...f.split("/")), "utf8").matchAll(IMPORT)) found.add(m[1]);
  }
  return [...found];
}
