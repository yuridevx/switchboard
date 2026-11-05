// Стенд фронта: настоящий код пульта и телефона из рабочего дерева на настоящих флотах — тест и прод, у каждого свой адрес, свой пропуск и свои комментарии.
// npm run stand. Правка кода перезагружает страницу. Комментарии по C — dist/stand/comments-<флот>.json: агент читает файл, закрывает удалением записи, метка снимается сама.
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
  { fleet: "test", port: PORT, page: PAGES.test },
  { fleet: "prod", port: PORT + 1, page: PAGES.prod },
];
const BODY_LIMIT = 64 * 1024;
const FETCH_MS = 10_000;
const STOP_MS = 3000;
mkdirSync(OUT, { recursive: true });

// Телефон на широком окне — в рамке 390 пикселей: своё окно, чтобы @media видели ширину телефона; в режиме устройства DevTools рамки нет.
const page = (fleet) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${fleet}</title></head><body><div id="app"></div><script>
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

const clients = new Map(FLEETS.map((f) => [f.fleet, new Set()]));
const send = (fleet, event) => {
  for (const c of clients.get(fleet)) c.write(`event: ${event}\ndata: \n\n`);
};

const ctx = await context({
  entryPoints: [process.env.STAND_ENTRY ?? join(here, "live.ts")],
  bundle: true,
  outfile: join(OUT, "live.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "info",
  plugins: [{ name: "reload", setup: (b) => b.onEnd((r) => void (r.errors.length || FLEETS.forEach((f) => send(f.fleet, "reload")))) }],
});
// первая сборка — до открытия адреса: страница не остаётся без бандла
await ctx.rebuild();
await ctx.watch();

const fileOf = (fleet) => join(OUT, `comments-${fleet}.json`);
const changes = watch(OUT, (_, name) => {
  const f = FLEETS.find((x) => name === `comments-${x.fleet}.json`);
  if (f) send(f.fleet, "comments");
});

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      s += c;
      if (s.length > BODY_LIMIT) reject(new Error("тело больше 64 КиБ"));
    });
    req.on("end", () => resolve(s));
  });
}

function serve({ fleet, port, page: fleetPage }) {
  const file = fileOf(fleet);
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { comments: [] });
  // без временного файла: на Windows rename падает, пока файл читает агент
  const save = (d) => writeFileSync(file, JSON.stringify(d, null, 1));
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://stand");
    const json = (code, v) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(v));
    };
    try {
      if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(page(fleet));
      }
      if (req.method === "GET" && pathname === "/live.js") {
        const js = readFileSync(join(OUT, "live.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(js);
      }
      if (req.method === "GET" && pathname === "/fleet.json") {
        const r = await fetch(`${fleetPage}/build.json`, { signal: AbortSignal.timeout(FETCH_MS) });
        if (!r.ok) return json(502, { error: `build.json флота ${fleet}: ${r.status}` });
        return json(200, { fleet, workers: (await r.json()).workers });
      }
      if (req.method === "GET" && pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(":\n\n");
        clients.get(fleet).add(res);
        return void req.on("close", () => clients.get(fleet).delete(res));
      }
      if (req.method === "GET" && pathname === "/api/comments") return json(200, load());
      if (req.method === "POST" && pathname === "/api/comments") {
        const f = JSON.parse(await body(req));
        if (typeof f.text !== "string" || !f.text.trim() || typeof f.selector !== "string") return json(400, { error: "text и selector — непустые строки" });
        const d = load();
        const c = { ...f, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
        d.comments.push(c);
        save(d);
        // агент может следить за выводом: новый комментарий — строка
        console.log(`комментарий ${c.id} · ${fleet} · ${c.app} ${c.hash} · ${c.selector} · ${c.text}`);
        return json(200, c);
      }
      const del = /^\/api\/comments\/([\w-]+)$/.exec(pathname);
      if (req.method === "DELETE" && del) {
        const d = load();
        save({ ...d, comments: d.comments.filter((c) => c.id !== del[1]) });
        return json(200, {});
      }
      json(404, { error: "нет такого адреса" });
    } catch (e) {
      // файл могут читать посреди чужой записи: отказ словом, следующее событие comments перечитает
      console.error(`${fleet} ${req.method} ${pathname}: ${e.message}`);
      json(400, { error: e.message });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`стенд ${fleet}: http://localhost:${port}/ · телефон http://localhost:${port}/?app=phone · C — комментарий · ${file}`));
  return server;
}

const servers = FLEETS.map(serve);

// штатная остановка: новое не принимаем, соединения закрываем с концом потока, сборку снимаем; не успели — жёсткий выход
async function stop() {
  setTimeout(() => process.exit(1), STOP_MS).unref();
  changes.close();
  await ctx.dispose();
  for (const set of clients.values()) for (const c of set) c.end();
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void stop());
