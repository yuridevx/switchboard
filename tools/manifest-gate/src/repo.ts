// node:fs и node:path берутся при вызове: контракт гейта грузится и в браузере (check), а loadRepo — только в Node
const fs = () => process.getBuiltinModule("node:fs") as typeof import("node:fs");
const path = () => process.getBuiltinModule("node:path") as typeof import("node:path");
const join = (...p: string[]) => path().join(...p);
const existsSync = (p: string) => fs().existsSync(p);
const readdirSync = ((p: string, o?: unknown) => fs().readdirSync(p, o as never)) as typeof import("node:fs").readdirSync;
const readFileSync = (p: string, e: "utf8") => fs().readFileSync(p, e);
const statSync = (p: string) => fs().statSync(p);
const relative = (a: string, b: string) => path().relative(a, b);
import { order, type Manifest } from "./check.ts";

const GROUPS = ["protocol", "tools/*", "workers/*", "os/*", "host/core", "host/modules/*", "web/packages/*", "web/phone", "web/pult", "web/pult/modules/*"];
const SRC = /\.(ts|tsx|mts|js|mjs)$/;
const SKIP = new Set(["node_modules", "dist", ".wrangler", "test", "tests", "stand"]);
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](@switchboard\/[^"']+)["']/g;

function dirs(root: string): string[] {
  const out: string[] = [];
  for (const g of GROUPS) {
    if (!g.endsWith("/*")) {
      if (existsSync(join(root, g, "module.json"))) out.push(join(root, g));
      continue;
    }
    const base = join(root, g.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const p = join(base, d);
      if (statSync(p).isDirectory() && existsSync(join(p, "module.json"))) out.push(p);
    }
  }
  return out;
}

/** Импорт React: упаковка заменяет его рантаймом страницы, значит рантайм должен быть в uses. */
const REACT = /(?:from\s*|import\s+)["']react(?:-dom)?(?:\/[^"']*)?["']/;

function imports(dir: string): string[] {
  const found = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(d, e.name));
      } else if (SRC.test(e.name) && !/\.test\.|\.spec\./.test(e.name) && !e.name.endsWith(".d.ts")) {
        const text = readFileSync(join(d, e.name), "utf8");
        for (const m of text.matchAll(IMPORT)) found.add(m[1]);
        if (REACT.test(text)) found.add("@switchboard/web-view");
      }
    }
  };
  walk(dir);
  return [...found].sort();
}

/** Манифесты всех модулей монорепо с их импортами (тесты и стенд не считаются) — в порядке зависимостей. */
export function loadRepo(root: string): Array<Manifest & { dir: string }> {
  return order(dirs(root).map((d) => {
    const m = JSON.parse(readFileSync(join(d, "module.json"), "utf8")) as Manifest & { dir: string };
    const pj = join(d, "package.json");
    if (existsSync(pj)) m.pkg = JSON.parse(readFileSync(pj, "utf8")).name;
    m.imports = imports(d);
    m.provides ??= {};
    m.uses ??= {};
    m.config ??= {};
    m.dir = relative(root, d);
    return m;
  }));
}
