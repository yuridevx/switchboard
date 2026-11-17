// Страница дизайна локально: node docs/designs/v2-model-switch/serve.mjs [порт=4841]
// Отдаёт index.html в той же обёртке, что и публикация (кодировка, ширина экрана), и картинки из shots/. Правка файла видна после обновления страницы.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4841);
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const wrap = (html) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${html}</body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(wrap(fs.readFileSync(path.join(here, "index.html"), "utf8")));
  }
  const file = path.join(here, url);
  // только картинки из папки снимков
  if (!file.startsWith(path.join(here, "shots") + path.sep) || !TYPES[path.extname(file)] || !fs.existsSync(file)) return void res.writeHead(404).end("нет");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)], "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, () => console.log(`страница дизайна: http://localhost:${port}/`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
