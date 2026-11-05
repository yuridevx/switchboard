// Страница настоящего кода в браузере: сборка, адрес и окно Chromium для снимков, жестов и эталонов (scripts/shots/*.mjs) и опции сборки для сервера стенда.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const OUT = join(ROOT, "dist", "shots");
const HOST_MODULES = join(ROOT, "host", "modules");

/** Контракт Host в roster стенда — provides его модулей, как у настоящего Host. */
const hostContract = () => Object.assign({}, ...readdirSync(HOST_MODULES).map((m) => JSON.parse(readFileSync(join(HOST_MODULES, m, "module.json"), "utf8")).provides));

/** Как собирается страница: один файл из дерева, стили — текстом для web-core. */
export const BUNDLE = { bundle: true, format: "iife", target: "es2022", loader: { ".css": "text" }, logLevel: "warning" };

/** Документ страницы: заголовки как у настоящей оболочки, скрипт — своей строкой. */
export const pageHtml = (title, script) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
${script}
</body>
</html>
`;

/** Собрать страницу снимков: подделка relay и настоящие модули. */
export async function prepare() {
  mkdirSync(OUT, { recursive: true });
  await build({ ...BUNDLE, entryPoints: [join(here, "entry.ts")], outfile: join(OUT, "bundle.js"), define: { __HOST__: JSON.stringify(hostContract()), "process.env.NODE_ENV": '"production"' } });
  writeFileSync(join(OUT, "index.html"), pageHtml("Стенд", '<script src="bundle.js"></script>'));
}

export const url = (app, kind, hash = "") => `${pathToFileURL(join(OUT, "index.html")).href}?app=${app}&kind=${kind}${hash}`;

export const launch = () => chromium.launch();
