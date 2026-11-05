// Стенд снимков: настоящий код страниц на поддельном relay, малый и большой флот. Собирается в dist/shots; браузер — Chromium из playwright-core
// (нет его — npx playwright-core install chromium). Флоты и ответы владельцев — fleets.ts и answers.ts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
export const OUT = process.env.SHOTS_OUT ?? join(root, "dist", "shots");

const PAGE = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Стенд</title></head><body><div id="app"></div><script src="bundle.js"></script></body></html>';

/** Манифесты папки: node_modules не в счёт. */
function manifests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return manifests(path);
    return e.name === "module.json" ? [JSON.parse(readFileSync(path, "utf8"))] : [];
  });
}

/** Контракт Host на стенде: provides ядра и всех его модулей, как Host шлёт его в hello. */
const hostContract = () => Object.assign({}, ...manifests(join(root, "host")).filter((m) => m.name === "host" || m.name.startsWith("host-")).map((m) => m.provides));

/** Собрать страницу стенда. */
export async function prepare() {
  await build({
    entryPoints: [join(here, "entry.ts")],
    bundle: true,
    outfile: join(OUT, "bundle.js"),
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    loader: { ".css": "text" },
    define: { __HOST__: JSON.stringify(hostContract()), "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  writeFileSync(join(OUT, "index.html"), PAGE);
}

/** Адрес страницы стенда: приложение pult или phone, флот small или big. */
export const url = (app, kind, hash = "") => `${pathToFileURL(join(OUT, "index.html")).href}?app=${app}&kind=${kind}${hash}`;

export const launch = () => chromium.launch();
