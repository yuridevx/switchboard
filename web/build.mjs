// Статика приложения в dist/: страница, значки, app.js и sw.js. Модулей и адресов в ней нет: их приносит сборка «Выпусков». Папка идёт в архив целиком: начинает с чистой.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const web = dirname(fileURLToPath(import.meta.url));

export async function buildShell(name) {
  const app = join(web, name);
  const dist = join(app, "dist");
  const script = (entry, file, external) => build({ entryPoints: [entry], outfile: join(dist, file), bundle: true, minify: true, external });
  rmSync(dist, { recursive: true, force: true });
  cpSync(join(app, "public"), dist, { recursive: true });
  cpSync(join(web, "icons"), dist, { recursive: true });
  await script(join(app, "src/main.ts"), "app.js", ["@switchboard/web-core"]);
  await script(join(web, "sw.ts"), "sw.js", []);
  console.log(`${name}: dist/ собран — оболочка без модулей и адресов`);
}
