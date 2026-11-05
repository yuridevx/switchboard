// Монорепо как набор: папки модулей, манифесты и то, что код делает мимо манифеста: импорты и вызовы привязок.
// Контракт гейта грузится и в браузере (check), поэтому файловая система берётся при вызове.
import { order } from "./graph.ts";
import type { Manifest, Reach } from "./manifest.ts";

const fs = () => process.getBuiltinModule("node:fs") as typeof import("node:fs");
const path = () => process.getBuiltinModule("node:path") as typeof import("node:path");
const join = (...parts: string[]) => path().join(...parts);

/** Где лежат модули: папка или все папки на уровень ниже. */
const GROUPS = ["protocol", "tools/*", "workers/*", "os/*", "host/core", "host/modules/*", "web/packages/*", "web/phone", "web/pult", "web/pult/modules/*"];
const CODE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.test\.|\.spec\./;
const TEST_DIR = new Set(["test", "tests", "stand"]);
const NOT_SOURCE_DIR = new Set(["node_modules", "dist", ".wrangler"]);
const IMPORT_PREFIX = String.raw`(?:from\s*|import\s*\(\s*|import\s+)["']`;
const IMPORT = new RegExp(`${IMPORT_PREFIX}(@switchboard/[^"']+)["']`, "g");
const RELATIVE = new RegExp(`${IMPORT_PREFIX}(\\.\\.?/[^"']+)["']`, "g");
/** Импорт React: упаковка заменяет его рантаймом страницы, значит рантайм должен быть в uses. */
const REACT = /(?:from\s*|import\s+)["']react(?:-dom)?(?:\/[^"']*)?["']/;
const RUNTIME = "@switchboard/web-view";
/** Вызов через привязку Worker'а: env.GATE.revoked( */
const BINDING_CALL = /\benv\.([A-Z][A-Z0-9_]*)\.(\w+)\(/g;
/** Строка комментария: пример вызова в ней — не вызов. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*).*$/gm;

type Mod = Manifest & { dir: string };
type Source = { file: string; test: boolean };

const hasManifest = (dir: string) => fs().existsSync(join(dir, "module.json"));
const readJson = <T>(file: string) => JSON.parse(fs().readFileSync(file, "utf8")) as T;

function moduleDirs(root: string): string[] {
  return GROUPS.flatMap((group) => {
    if (!group.endsWith("/*")) return hasManifest(join(root, group)) ? [join(root, group)] : [];
    const base = join(root, group.slice(0, -2));
    if (!fs().existsSync(base)) return [];
    return fs().readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && hasManifest(join(base, e.name))).map((e) => join(base, e.name));
  });
}

/** Исходники модуля; вложенный модуль (экран пульта) считает свои сам. */
function sources(dir: string, inTest = false): Source[] {
  return fs().readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = join(dir, e.name);
    if (e.isDirectory()) return NOT_SOURCE_DIR.has(e.name) || hasManifest(file) ? [] : sources(file, inTest || TEST_DIR.has(e.name));
    if (!CODE.test(e.name) || e.name.endsWith(".d.ts")) return [];
    return [{ file, test: inTest || TEST_FILE.test(e.name) }];
  });
}

/** Модуль и путь от его корня для файла; для теста нет правила, если у модуля нет контракта. */
function reachOf(file: string, from: Source, self: Mod, mods: Mod[]): Reach[] {
  const to = mods.filter((m) => file === m.dir || file.startsWith(m.dir + path().sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!to || to === self) return [];
  if (from.test && !fs().existsSync(join(to.dir, "contract.ts"))) return [];
  return [{ to: to.name, path: path().relative(to.dir, file).replaceAll("\\", "/"), test: from.test }];
}

/** То, что код модуля делает мимо манифеста. */
function scan(self: Mod, mods: Mod[]): Pick<Manifest, "imports" | "calls" | "reach"> {
  const imports = new Set<string>();
  const calls = new Set<string>();
  const reach: Reach[] = [];
  for (const source of sources(self.dir)) {
    const text = fs().readFileSync(source.file, "utf8");
    for (const [, spec] of text.matchAll(RELATIVE)) reach.push(...reachOf(path().resolve(path().dirname(source.file), spec), source, self, mods));
    if (source.test) {
      // пакет без пути — контракт: тесту можно без uses
      for (const [, spec] of text.matchAll(IMPORT)) {
        const [scope, name, ...rest] = spec.split("/");
        const to = mods.find((m) => m.pkg === `${scope}/${name}`);
        if (to && rest.length) reach.push(...reachOf(join(to.dir, ...rest), source, self, mods));
      }
      continue;
    }
    for (const [, spec] of text.matchAll(IMPORT)) imports.add(spec);
    if (REACT.test(text)) imports.add(RUNTIME);
    for (const [, binding, method] of text.replace(COMMENT_LINE, "").matchAll(BINDING_CALL)) calls.add(`${binding.toLowerCase()}.${method}`);
  }
  return { imports: [...imports].sort(), calls: [...calls].sort(), reach };
}

/** Манифесты всех модулей монорепо с тем, что делает их код, — в порядке зависимостей; папка — от корня. */
export function loadRepo(root: string): Array<Manifest & { dir: string }> {
  const mods = moduleDirs(root).map((dir): Mod => {
    const manifest = readJson<Manifest>(join(dir, "module.json"));
    const pj = join(dir, "package.json");
    return {
      ...manifest,
      provides: manifest.provides ?? {},
      uses: manifest.uses ?? {},
      config: manifest.config ?? {},
      pkg: fs().existsSync(pj) ? readJson<{ name: string }>(pj).name : undefined,
      dir,
    };
  });
  return order(mods.map((m) => ({ ...m, ...scan(m, mods), dir: path().relative(root, m.dir) })));
}
