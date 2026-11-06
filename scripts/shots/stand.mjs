// Стенд снимков: страница настоящего кода в папке сборки и браузер к ней. BUNDLE и pageHtml берёт и сервер дизайна.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_MS = 60_000;
const HOST_MODULES = path.join(here, "..", "..", "host", "modules");

/** Контракт Host в roster — provides его модулей: экраны спрашивают app.can. */
const hostContract = () => Object.assign({}, ...readdirSync(HOST_MODULES).map((m) => JSON.parse(readFileSync(path.join(HOST_MODULES, m, "module.json"), "utf8")).provides));

export const OUT = path.join(here, "..", "..", "dist", "shots");
export const BUNDLE = { bundle: true, format: "iife", target: "es2022", loader: { ".css": "text" }, logLevel: "warning" };

export const pageHtml = (title, body) => `<!doctype html>
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
${body}
</body>
</html>
`;

export async function prepare() {
  mkdirSync(OUT, { recursive: true });
  await build({ ...BUNDLE, entryPoints: [path.join(here, "entry.ts")], outfile: path.join(OUT, "bundle.js"), jsx: "automatic", define: { __HOST__: JSON.stringify(hostContract()), "process.env.NODE_ENV": '"production"' } });
  writeFileSync(path.join(OUT, "index.html"), pageHtml("Стенд", '<script src="bundle.js"></script>'));
}

export const url = (app, kind, hash) => `${pathToFileURL(path.join(OUT, "index.html"))}?app=${app}&kind=${kind}${hash}`;

export const launch = () => chromium.launch({ timeout: LAUNCH_MS });
