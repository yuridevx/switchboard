// Статика оболочки: <приложение>/dist/ — содержимое архива оболочки в каталоге. Модулей, адресов relay и Worker'ов,
// пропусков и секретов в ней нет: их страница берёт из build.json сборки «Выпусков».
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { icon } from "./icon.mjs";

const web = dirname(fileURLToPath(import.meta.url));
const ICONS = { "icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180 };

/** Классический скрипт: карта импорта должна встать раньше первого модуля, обработчик регистрируется без type: "module". */
const script = (entry, outfile) => build({ entryPoints: [entry], outfile, bundle: true, minify: true, format: "iife", target: "es2022", logLevel: "warning" });

/** Собрать приложение из папки app (src/main.ts, public/) под именем name. */
export async function buildApp(app, name) {
  const dist = join(app, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  await script(join(app, "src/main.ts"), join(dist, "app.js"));
  await script(join(web, "sw.ts"), join(dist, "sw.js"));
  cpSync(join(app, "public"), dist, { recursive: true });
  for (const [file, size] of Object.entries(ICONS)) writeFileSync(join(dist, file), icon(size));
  console.log(`${name}: dist/ собран — оболочка без модулей и адресов`);
}
