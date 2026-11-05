// Файл модуля страницы в stdout: упаковка синхронна, а плагин esbuild — нет, поэтому отдельный процесс.
// Другие модули страницы — внешние импорты; React — из рантайма страницы; стили — текстом, с LF: это байты архива.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const VIEW = "@switchboard/web-view";
const dir = process.argv[2];
const { name } = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { name: string };
const alias = name === "web-view" ? {} : Object.fromEntries(["react", "react/jsx-runtime", "react-dom", "react-dom/client"].map((spec) => [spec, VIEW]));

const { outputFiles } = await build({
  entryPoints: [join(dir, "contract.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  write: false,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias,
  external: ["@switchboard/web-*"],
  logLevel: "warning",
  plugins: [{ name: "css", setup: (b) => void b.onLoad({ filter: /\.css$/ }, ({ path }) => ({ contents: readFileSync(path, "utf8").replaceAll("\r\n", "\n"), loader: "text" })) }],
});
process.stdout.write(outputFiles[0].contents);
