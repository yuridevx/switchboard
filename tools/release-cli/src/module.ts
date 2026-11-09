// Папка модуля монорепо → архив: страницу и оболочку сначала собирает, остальное пакует как есть.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { packModule, type PackedModule } from "@switchboard/release";
import { inputSchema } from "./schema.ts";

const BUILD_MS = 120_000;
const VIEW = "@switchboard/web-view";
const REACT = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];

/** Один ES-файл модуля страницы: другие модули — внешние импорты, React — из рантайма страницы, стили — текстом. */
function bundle(dir: string, name: string): Buffer {
  const { outputFiles } = buildSync({
    entryPoints: [join(dir, "contract.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: name === "web-view" ? {} : Object.fromEntries(REACT.map((spec) => [spec, VIEW])),
    external: ["@switchboard/web-*"],
    loader: { ".css": "text" },
    logLevel: "warning",
  });
  return Buffer.from(outputFiles[0].contents);
}

export function packFromRepo(dir: string): PackedModule {
  const { type, name } = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { type: string; name: string };
  if (type === "web-app") execFileSync(process.execPath, ["build.mjs"], { cwd: dir, timeout: BUILD_MS, stdio: "pipe" });
  return packModule(dir, type === "web" ? { bundle: () => bundle(dir, name) } : { schema: inputSchema });
}
