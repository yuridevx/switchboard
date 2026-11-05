// Модуль монорепо → архив каталога: страницу собирает одним файлом, оболочке собирает статику, остальное — упаковка release.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { loadRepo } from "@switchboard/manifest-gate";
import { packModule, type PackedModule } from "@switchboard/release";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** Рантайм страницы один на странице: React в модулях — внешний импорт web-view. */
const VIEW = "@switchboard/web-view";
const REACT = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"];

/** Модули страниц: внешние импорты файла модуля по имени; протокол остаётся внутри. */
const pageModules = () => loadRepo(ROOT).filter((m) => m.type === "web").map((m) => `@switchboard/${m.name}`);

/** Один ES-файл модуля страницы. web-view сам несёт React. */
function bundle(dir: string, name: string): Uint8Array {
  const self = `@switchboard/${name}`;
  const r = buildSync({
    entryPoints: [join(dir, "contract.ts")],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    external: pageModules().filter((p) => p !== self),
    alias: self === VIEW ? {} : Object.fromEntries(REACT.map((n) => [n, VIEW])),
  });
  return r.outputFiles[0].contents;
}

export function packFromRepo(dir: string): PackedModule {
  const m = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { type: string; name: string };
  if (m.type === "web") return packModule(dir, { bundle: () => bundle(dir, m.name) });
  if (m.type === "web-app") execFileSync(process.execPath, ["build.mjs"], { cwd: dir, stdio: "ignore" });
  return packModule(dir);
}
