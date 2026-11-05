// Монорепо как набор: папки модулей, их манифесты и импорты кода. Тесты и стенд не считаются.
// Контракт гейта грузится и в браузере (check), поэтому файловая система берётся при вызове.
import { order } from "./graph.ts";
import type { Manifest } from "./manifest.ts";

const fs = () => process.getBuiltinModule("node:fs") as typeof import("node:fs");
const join = (...parts: string[]) => (process.getBuiltinModule("node:path") as typeof import("node:path")).join(...parts);
const relative = (from: string, to: string) => (process.getBuiltinModule("node:path") as typeof import("node:path")).relative(from, to);

/** Где лежат модули: папка или все папки на уровень ниже. */
const GROUPS = ["protocol", "tools/*", "workers/*", "os/*", "host/core", "host/modules/*", "web/packages/*", "web/phone", "web/pult", "web/pult/modules/*"];
const CODE = /\.(ts|tsx|mts|js|mjs)$/;
const NOT_CODE_FILE = /\.test\.|\.spec\.|\.d\.ts$/;
const NOT_CODE_DIR = new Set(["node_modules", "dist", ".wrangler", "test", "tests", "stand"]);
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](@switchboard\/[^"']+)["']/g;
/** Импорт React: упаковка заменяет его рантаймом страницы, значит рантайм должен быть в uses. */
const REACT = /(?:from\s*|import\s+)["']react(?:-dom)?(?:\/[^"']*)?["']/;
const RUNTIME = "@switchboard/web-view";

const hasManifest = (dir: string) => fs().existsSync(join(dir, "module.json"));
const readJson = <T>(path: string) => JSON.parse(fs().readFileSync(path, "utf8")) as T;

function moduleDirs(root: string): string[] {
  return GROUPS.flatMap((group) => {
    if (!group.endsWith("/*")) return hasManifest(join(root, group)) ? [join(root, group)] : [];
    const base = join(root, group.slice(0, -2));
    if (!fs().existsSync(base)) return [];
    return fs().readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && hasManifest(join(base, e.name))).map((e) => join(base, e.name));
  });
}

/** Файлы кода модуля; вложенный модуль (экран пульта) считает свои сам. */
function codeFiles(dir: string): string[] {
  return fs().readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return NOT_CODE_DIR.has(e.name) || hasManifest(path) ? [] : codeFiles(path);
    return CODE.test(e.name) && !NOT_CODE_FILE.test(e.name) ? [path] : [];
  });
}

function importsOf(dir: string): string[] {
  const found = new Set<string>();
  for (const file of codeFiles(dir)) {
    const text = fs().readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) found.add(m[1]);
    if (REACT.test(text)) found.add(RUNTIME);
  }
  return [...found].sort();
}

/** Манифесты всех модулей монорепо с их импортами — в порядке зависимостей. */
export function loadRepo(root: string): Array<Manifest & { dir: string }> {
  return order(
    moduleDirs(root).map((dir) => {
      const manifest = readJson<Manifest>(join(dir, "module.json"));
      const pj = join(dir, "package.json");
      return {
        ...manifest,
        provides: manifest.provides ?? {},
        uses: manifest.uses ?? {},
        config: manifest.config ?? {},
        imports: importsOf(dir),
        pkg: fs().existsSync(pj) ? readJson<{ name: string }>(pj).name : undefined,
        dir: relative(root, dir),
      };
    }),
  );
}
