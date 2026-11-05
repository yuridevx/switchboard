// Сборка оболочки приложения: dist/ с нуля. В каталог идёт вся папка, поэтому адресов и модулей в ней нет: их приносит build.json.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";

const web = import.meta.dirname;

/** Классический скрипт: `defer` на странице и обработчик пушей. */
const script = (entry, outfile, external) => buildSync({ entryPoints: [entry], outfile, bundle: true, minify: true, format: "iife", target: "es2022", external, logLevel: "warning" });

export function buildShell(name) {
  const dist = join(web, name, "dist");
  rmSync(dist, { recursive: true, force: true });
  cpSync(join(web, name, "public"), dist, { recursive: true });
  cpSync(join(web, "icons"), dist, { recursive: true });
  // ядро страницы приходит по карте импорта; обработчику пушей оно не нужно: свою часть он несёт в себе
  script(join(web, name, "src/main.ts"), join(dist, "app.js"), ["@switchboard/web-core"]);
  script(join(web, "sw.ts"), join(dist, "sw.js"), []);
  console.log(`${name}: dist/ собран — оболочка без модулей и адресов`);
}
