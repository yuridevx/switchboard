// Модуль монорепо для каталога: упаковка — формата выпуска; здесь то, что знает монорепо. Модуль страницы собирается одним ES-файлом
// (импорты других модулей страницы остаются внешними: страница разрешает их картой импорта сборки), статика оболочки — её build.mjs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { MANIFEST, packModule, type ModuleJson, type PackedModule } from "@switchboard/release";
import { importsOf, readJson } from "./graph.ts";

/** Рантайм страницы: модуль пишет импорт из "react", в файле модуля остаётся импорт этого модуля. */
const VIEW = "@switchboard/web-view";
const VIEW_NAME = "web-view";

/** Модуль страницы ли пакет: папка пакета — вверх от его входа до package.json, рядом module.json типа web. */
function isPageModule(entry: string, self: string): boolean {
  for (let d = dirname(entry); dirname(d) !== d; d = dirname(d)) {
    if (!existsSync(join(d, "package.json"))) continue;
    const mj = join(d, MANIFEST);
    const m = existsSync(mj) ? readJson<ModuleJson>(mj) : null;
    return m?.type === "web" && m.name !== self;
  }
  return false;
}

/** Модуль страницы одним файлом: вход — exports["."] пакета, без пакета — contract.ts. */
function bundleWeb(dir: string, m: ModuleJson): Buffer {
  const pj = join(dir, "package.json");
  const entry = existsSync(pj) ? readJson<{ exports?: Record<string, string> }>(pj).exports?.["."] : undefined;
  const req = createRequire(join(dir, "noop.js"));
  const external = importsOf(dir, (f) => f.startsWith("stand/") || f.startsWith("test/")).filter((spec) => isPageModule(req.resolve(spec), m.name));
  const { outputFiles } = buildSync({
    entryPoints: [join(dir, entry ?? "contract.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    jsx: "automatic",
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    ...(m.name === VIEW_NAME ? { external } : { alias: { "react/jsx-runtime": VIEW, "react-dom/client": VIEW, "react-dom": VIEW, react: VIEW }, external: [...new Set([VIEW, ...external])] }),
  });
  return Buffer.from(outputFiles[0].contents);
}

/** Упаковать модуль монорепо: оболочке — собрать статику, модулю страницы — бандл. */
export function packFromRepo(at: string): PackedModule {
  const dir = resolve(at);
  if (readJson<ModuleJson>(join(dir, MANIFEST)).type === "web-app") execFileSync(process.execPath, ["build.mjs"], { cwd: dir, stdio: "pipe" });
  return packModule(dir, { bundle: bundleWeb });
}
