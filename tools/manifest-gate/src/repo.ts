// Манифесты монорепо и факты их кода. Модули Node берутся при вызове: контракт грузится и там, где их нет.
import { readCode } from "./code.ts";
import { order, type Manifest } from "./manifest.ts";

const MANIFESTS = ["protocol", "tools/*", "workers/*", "os/*", "host/core", "host/modules/*", "web/packages/*", "web/*", "web/*/modules/*"].map((dir) => `${dir}/module.json`);
const CODE = "**/*.{ts,tsx,mts,mjs,js}";
const NOT_CODE = (name: string) => name === "node_modules" || name === "dist" || name.startsWith(".");
const TEST = /(^|[\\/])(test|tests|stand)[\\/]|\.(test|spec)\.[^\\/]+$/;
/** Что тесту можно у чужого модуля без uses. */
const OPEN_TO_TESTS = /^(contract\.ts|module\.json|stand\/)/;
const REACT = /^react(-dom)?(\/|$)/;
const VIEW = "@switchboard/web-view";
const SCOPE = "@switchboard/";

export function loadRepo(root: string): (Manifest & { dir: string })[] {
  const { existsSync, globSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { dirname, join, relative, sep } = process.getBuiltinModule("node:path");
  const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

  const mods = globSync(MANIFESTS, { cwd: root }).map((file) => {
    const dir = dirname(file);
    const pkg = join(dir, "package.json");
    return { provides: {}, uses: {}, config: {}, ...json(file), dir, pkg: existsSync(join(root, pkg)) ? json(pkg).name : undefined } as Manifest & { dir: string };
  });
  const deepestFirst = [...mods].sort((a, b) => b.dir.length - a.dir.length);
  const moduleAt = (path: string) => deepestFirst.find((m) => path.startsWith(m.dir + sep));
  const byPkg = new Map(mods.map((m) => [m.pkg, m]));

  /** Чужой модуль и путь внутри него; не чужой или не модуль — ничего. */
  function target(self: Manifest, file: string, spec: string) {
    if (spec.startsWith(".")) {
      const path = join(dirname(file), spec);
      const to = moduleAt(path);
      return to && to !== self ? { to, inner: relative(to.dir, path).replaceAll(sep, "/") } : undefined;
    }
    const [scope, name, ...inner] = spec.split("/");
    const to = byPkg.get(`${scope}/${name}`);
    return to && to !== self ? { to, inner: inner.join("/") } : undefined;
  }

  for (const m of mods) {
    const imports = new Set<string>();
    const reach = new Set<string>();
    const testReach = new Set<string>();
    const rpc = new Set<string>();
    for (const inner of globSync(CODE, { cwd: join(root, m.dir), exclude: NOT_CODE })) {
      const file = join(m.dir, inner);
      if (inner.endsWith(".d.ts") || moduleAt(file) !== m) continue;
      const code = readCode(file, readFileSync(join(root, file), "utf8"));
      if (TEST.test(inner)) {
        for (const spec of code.specs) {
          const hit = target(m, file, spec);
          if (hit?.inner && !OPEN_TO_TESTS.test(hit.inner) && existsSync(join(root, hit.to.dir, "contract.ts"))) testReach.add(`${hit.to.name}/${hit.inner}`);
        }
        continue;
      }
      code.rpc.forEach((name) => rpc.add(name));
      for (const spec of code.specs) {
        if (REACT.test(spec)) imports.add(VIEW);
        else if (spec.startsWith(SCOPE)) imports.add(spec);
        else if (spec.startsWith(".")) {
          const hit = target(m, file, spec);
          if (hit) reach.add(`${hit.to.name}/${hit.inner}`);
        }
      }
    }
    Object.assign(m, { imports: [...imports].sort(), reach: [...reach], testReach: [...testReach], rpc: [...rpc] });
  }
  return order(mods);
}
