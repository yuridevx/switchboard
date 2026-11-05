// Стенд фронта: настоящий код пульта и телефона из рабочего дерева на настоящих флотах — тест и прод, у каждого свой адрес, свой пропуск и свои комментарии.
// npm run stand. Правка кода перезагружает страницу. Комментарии по C — dist/stand/comments-<флот>.json: агент читает файл, закрывает удалением записи, метка снимается сама.
// Без настоящих флотов (STAND_CHECK=fake npm run stand:check): STAND_PAGES — страницы флотов, STAND_ENTRY — страница стенда.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.STAND_OUT ?? join(here, "..", "..", "dist", "stand");
const PORT = Number(process.env.STAND_PORT ?? 4791);
// страница флота отдаёт build.json с адресами его Worker'ов: своего списка адресов у стенда нет
const PAGES = process.env.STAND_PAGES ? JSON.parse(process.env.STAND_PAGES) : { test: "https://switchboard-pult.yuridevx1608.workers.dev", prod: "https://pult.pfarm.app" };
const FLEETS = [
  { name: "test", port: PORT, page: PAGES.test },
  { name: "prod", port: PORT + 1, page: PAGES.prod },
];
const BODY_LIMIT = 64 * 1024;
const FETCH_MS = 10_000;
const STOP_MS = 3000;
const LIVE_JS = join(OUT, "live.js");

mkdirSync(OUT, { recursive: true });

// Телефон на широком окне — в рамке 390 пикселей: своё окно, чтобы @media видели ширину телефона; в режиме устройства DevTools рамки нет.
const pageHtml = (fleet) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${fleet}</title></head><body><div id="app"></div><script>
if (new URLSearchParams(location.search).get("app") === "phone" && innerWidth > 500 && self === top) {
  document.body.style.cssText = "margin:0;height:100dvh;display:grid;place-items:center;background:#777";
  const f = document.createElement("iframe");
  f.src = location.href;
  f.style.cssText = "width:390px;height:min(844px,100dvh);border:0;background:#fff";
  document.body.replaceChildren(f);
  f.addEventListener("load", () => f.contentWindow.focus());
  addEventListener("pointerdown", () => setTimeout(() => f.contentWindow.focus()));
} else {
  const s = document.createElement("script");
  s.src = "live.js";
  document.body.append(s);
}
</script></body></html>`;

/** Кто слушает события страниц: на флот свой набор. */
const streams = new Map(FLEETS.map((f) => [f.name, new Set()]));
const notify = (fleet, event) => {
  for (const stream of streams.get(fleet)) stream.write(`event: ${event}\ndata: \n\n`);
};

const bundler = await context({
  entryPoints: [process.env.STAND_ENTRY ?? join(here, "live.ts")],
  bundle: true,
  outfile: LIVE_JS,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "info",
  plugins: [{ name: "reload", setup: (b) => b.onEnd((r) => void (r.errors.length || FLEETS.forEach((f) => notify(f.name, "reload")))) }],
});
// первая сборка — до открытия адреса: страница не остаётся без бандла
await bundler.rebuild();
await bundler.watch();

/** Файл комментариев флота: его читает и правит агент. */
function commentsFile(fleet) {
  const file = join(OUT, `comments-${fleet}.json`);
  return {
    file,
    read: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { comments: [] }),
    // без временного файла: на Windows rename падает, пока файл читает агент
    write: (data) => writeFileSync(file, JSON.stringify(data, null, 1)),
  };
}

const fileWatch = watch(OUT, (_, name) => {
  const fleet = FLEETS.find((f) => name === `comments-${f.name}.json`);
  if (fleet) notify(fleet.name, "comments");
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > BODY_LIMIT) reject(new Error("тело больше 64 КиБ"));
    });
    req.on("end", () => resolve(text));
  });
}

const sendJson = (res, code, value) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const sendFresh = (res, type, body) => {
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
};

async function fleetJson(res, fleet) {
  const r = await fetch(`${fleet.page}/build.json`, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!r.ok) return sendJson(res, 502, { error: `build.json флота ${fleet.name}: ${r.status}` });
  sendJson(res, 200, { fleet: fleet.name, workers: (await r.json()).workers });
}

function openStream(req, res, fleet) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.write(":\n\n");
  streams.get(fleet.name).add(res);
  req.on("close", () => streams.get(fleet.name).delete(res));
}

async function addComment(req, res, fleet) {
  const draft = JSON.parse(await readBody(req));
  if (typeof draft.text !== "string" || !draft.text.trim() || typeof draft.selector !== "string") return sendJson(res, 400, { error: "text и selector — непустые строки" });
  const store = commentsFile(fleet.name);
  const data = store.read();
  const comment = { ...draft, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
  data.comments.push(comment);
  store.write(data);
  // агент может следить за выводом: новый комментарий — строка
  console.log(`комментарий ${comment.id} · ${fleet.name} · ${comment.app} ${comment.hash} · ${comment.selector} · ${comment.text}`);
  sendJson(res, 200, comment);
}

function removeComment(res, fleet, id) {
  const store = commentsFile(fleet.name);
  const data = store.read();
  store.write({ ...data, comments: data.comments.filter((c) => c.id !== id) });
  sendJson(res, 200, {});
}

function route(req, res, fleet) {
  const { pathname } = new URL(req.url, "http://stand");
  const key = `${req.method} ${pathname}`;
  if (key === "GET /") return sendFresh(res, "text/html", pageHtml(fleet.name));
  if (key === "GET /live.js") return sendFresh(res, "text/javascript", readFileSync(LIVE_JS));
  if (key === "GET /fleet.json") return fleetJson(res, fleet);
  if (key === "GET /events") return openStream(req, res, fleet);
  if (key === "GET /api/comments") return sendJson(res, 200, commentsFile(fleet.name).read());
  if (key === "POST /api/comments") return addComment(req, res, fleet);
  const removal = req.method === "DELETE" && /^\/api\/comments\/([\w-]+)$/.exec(pathname);
  if (removal) return removeComment(res, fleet, removal[1]);
  sendJson(res, 404, { error: "нет такого адреса" });
}

function serve(fleet) {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, fleet);
    } catch (e) {
      // файл могут читать посреди чужой записи: отказ словом, следующее событие comments перечитает
      console.error(`${fleet.name} ${req.method} ${req.url}: ${e.message}`);
      sendJson(res, 400, { error: e.message });
    }
  });
  server.listen(fleet.port, "127.0.0.1", () => console.log(`стенд ${fleet.name}: http://localhost:${fleet.port}/ · телефон http://localhost:${fleet.port}/?app=phone · C — комментарий · ${commentsFile(fleet.name).file}`));
  return server;
}

const servers = FLEETS.map(serve);

// штатная остановка: новое не принимаем, соединения закрываем с концом потока, сборку снимаем; не успели — жёсткий выход
async function stop() {
  setTimeout(() => process.exit(1), STOP_MS).unref();
  fileWatch.close();
  await bundler.dispose();
  for (const set of streams.values()) for (const stream of set) stream.end();
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop());
