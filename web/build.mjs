// Статика приложения в dist/: страница, значки, app.js и sw.js. Модулей и адресов в ней нет: их приносит сборка «Выпусков». Папка идёт в архив целиком: начинает с чистой.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";

const web = import.meta.dirname;

/** out — папка вывода, по умолчанию dist/ приложения: тест собирает в свою, чтобы не делить dist/ с упаковщиком модулей. */
export function buildShell(name, out) {
  const app = join(web, name);
  const dist = out ?? join(app, "dist");
  const script = (entry, file, external) => buildSync({ entryPoints: [entry], outfile: join(dist, file), bundle: true, minify: true, external });
  rmSync(dist, { recursive: true, force: true });
  cpSync(join(app, "public"), dist, { recursive: true });
  cpSync(join(web, "icons"), dist, { recursive: true });
  // ядро страницы приходит по карте импорта; у обработчика пушей загрузчика нет: своё он несёт в себе
  script(join(app, "src/main.ts"), "app.js", ["@switchboard/web-core"]);
  script(join(web, "sw.ts"), "sw.js", []);
  console.log(`${name}: dist/ собран — оболочка без модулей и адресов`);
}
