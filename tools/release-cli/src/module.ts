// Модуль монорепо для каталога: упаковка — общая, формата выпуска (packModule); здесь только то, что знает монорепо:
// модуль страницы собирается одним ES-файлом esbuild'ом (импорты других модулей страницы остаются внешними — страница
// разрешает их import map'ом сборки), статика оболочки — её же build.mjs в dist/.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { MANIFEST, packageFiles, packModule, type ModuleJson, type PackedModule } from "@switchboard/release";

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
      const m = existsSync(mj) ? (JSON.parse(readFileSync(mj, "utf8")) as ModuleJson) : null;
      return m?.type === "web" && m.name !== self;
    }
    return false;
  });
}

/** Модуль страницы одним ES-файлом: вход — exports["."] пакета, без пакета — contract.ts. */
function bundleWeb(dir: string, m: ModuleJson): Buffer {
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

/** Упаковать модуль монорепо: оболочке — собрать статику, модулю страницы — бандл; остальное — общая упаковка. */
export function packFromRepo(at: string): PackedModule {
  const dir = resolve(at);
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as ModuleJson;
  if (m.type === "web-app") execFileSync(process.execPath, ["build.mjs"], { cwd: dir, stdio: "pipe" });
  return packModule(dir, { bundle: bundleWeb });
}
