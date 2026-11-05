// Стенд фронта: настоящий код из дерева на настоящих флотах, тест и прод на своих адресах, перезагрузка при правке.
// npm run stand. Комментарии по C — в dist/stand/comments-<флот>.json: агент читает файл и закрывает удалением записи.
// Окружение для проверок: STAND_OUT, STAND_PORT, STAND_PAGES (флот → адрес страницы), STAND_ENTRY (страница вместо настоящей).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { text as readBody } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { BUNDLE, pageHtml, ROOT } from "./stand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.STAND_OUT ?? join(ROOT, "dist", "stand");
const PORT = Number(process.env.STAND_PORT ?? 4791);
const PAGES = JSON.parse(process.env.STAND_PAGES ?? '{"test":"https://switchboard-pult.yuridevx1608.workers.dev","prod":"https://pult.pfarm.app"}');
const ENTRY = process.env.STAND_ENTRY ?? join(here, "live.ts");
const BODY_LIMIT = 64 * 1024;
const FETCH_MS = 10_000;

const BUNDLE_FILE = join(OUT, "live.js");
const fileOf = (fleet) => join(OUT, `comments-${fleet}.json`);
const readComments = (fleet) => (existsSync(fileOf(fleet)) ? JSON.parse(readFileSync(fileOf(fleet), "utf8")).comments : []);
const writeComments = (fleet, comments) => writeFileSync(fileOf(fleet), JSON.stringify({ comments }, null, 1));

/** Страница: телефон на широком окне — в рамке 390, иначе сразу код. */
const PAGE_SCRIPT = `<script>
if (self === top && innerWidth > 480 && new URLSearchParams(location.search).get("app") === "phone") {
  document.body.innerHTML = '<iframe style="display:block;width:390px;height:100dvh;margin:auto;border:0"></iframe>';
  const frame = document.body.firstChild;
  frame.onload = () => frame.contentWindow.focus();
  frame.src = location.href;
} else {
  const s = document.createElement("script");
  s.src = "live.js";
  document.body.append(s);
}
</script>`;

/** Подписчики событий по флотам. */
const streams = new Map(Object.keys(PAGES).map((fleet) => [fleet, new Set()]));
const send = (fleet, event) => {
  for (const res of streams.get(fleet)) res.write(`event: ${event}\ndata: {}\n\n`);
};

const refuse = (status, error) => Object.assign(new Error(error), { status });

/** Маршруты одного флота: ответ — данные (200 JSON), отказ — брошенная ошибка. */
const routes = (fleet) => ({
  async "GET /fleet.json"() {
    const r = await fetch(new URL("/build.json", PAGES[fleet]), { signal: AbortSignal.timeout(FETCH_MS) });
    if (!r.ok) throw refuse(502, `build.json флота ${fleet}: ${r.status}`);
    return { fleet, workers: (await r.json()).workers };
  },
  async "GET /api/comments"() {
    return { comments: readComments(fleet) };
  },
  async "POST /api/comments"(q) {
    const raw = await readBody(q);
    if (Buffer.byteLength(raw) > BODY_LIMIT) throw refuse(400, "тело больше 64 КиБ");
    const body = JSON.parse(raw);
    if (![body.text, body.selector].every((s) => typeof s === "string" && s.trim())) throw refuse(400, "text и selector — непустые строки");
    const comment = { ...body, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
    writeComments(fleet, [...readComments(fleet), comment]);
    console.log(`комментарий ${comment.id} · ${fleet} · ${body.app} ${body.hash} · ${body.selector} · ${body.text}`);
    return comment;
  },
  async "DELETE /api/comments"(_q, id) {
    writeComments(fleet, readComments(fleet).filter((c) => c.id !== id));
    return { ok: true };
  },
});

function serve(fleet, port) {
  const api = routes(fleet);
  const server = createServer(async (q, res) => {
    const path = new URL(q.url, "http://stand").pathname;
    res.setHeader("cache-control", "no-store");
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(pageHtml(fleet, PAGE_SCRIPT));
    }
    if (path === "/events") {
      res.setHeader("content-type", "text/event-stream");
      res.write(": поток открыт\n\n");
      streams.get(fleet).add(res);
      res.on("close", () => streams.get(fleet).delete(res));
      return;
    }
    res.setHeader("content-type", path === "/live.js" ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8");
    if (path === "/live.js") return res.end(readFileSync(BUNDLE_FILE));
    const [, id] = /^\/api\/comments\/(.+)$/.exec(path) ?? [];
    const route = api[`${q.method} ${id ? "/api/comments" : path}`];
    try {
      if (!route) throw refuse(404, "нет такого адреса");
      res.end(JSON.stringify(await route(q, id)));
    } catch (e) {
      res.statusCode = e.status ?? 400;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return server.listen(port, "127.0.0.1", () => console.log(`стенд ${fleet}: http://localhost:${port}/ · телефон http://localhost:${port}/?app=phone · C — комментарий · ${fileOf(fleet)}`));
}

mkdirSync(OUT, { recursive: true });
const firstBuild = Promise.withResolvers();
let built = false;
const build = await context({
  ...BUNDLE,
  entryPoints: [ENTRY],
  outfile: BUNDLE_FILE,
  plugins: [
    {
      name: "reload",
      setup: (b) =>
        b.onEnd((r) => {
          if (!built) firstBuild.resolve();
          else if (!r.errors.length) for (const fleet of streams.keys()) send(fleet, "reload");
          built = true;
        }),
    },
  ],
});
await build.watch();
await firstBuild.promise;

const watcher = watch(OUT, (_, name) => {
  const [, fleet] = /^comments-(.+)\.json$/.exec(name ?? "") ?? [];
  if (streams.has(fleet)) send(fleet, "comments");
});
const servers = Object.keys(PAGES).map((fleet, i) => serve(fleet, PORT + i));

async function stop() {
  watcher.close();
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  await build.dispose();
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
