// Локальный показ дизайна: страница, комментарии к блокам и метки «прочитал» в JSON рядом со страницей.
//   node serve-design.mjs <страница.html> [порт]
// Данные — <страница>.notes.json: { marks: { id: true }, comments: [{ id, block, text, at }] }.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const page = process.argv[2];
const port = Number(process.argv[3] ?? 4790);
const notes = page.replace(/\.html$/, "") + ".notes.json";
const LIMIT = 64 * 1024;

const load = () => (existsSync(notes) ? JSON.parse(readFileSync(notes, "utf8")) : { marks: {}, comments: [] });
function save(d) {
  writeFileSync(notes + ".tmp", JSON.stringify(d, null, 1));
  renameSync(notes + ".tmp", notes);
}

// скелет как у публикации: страница пишется без html/head/body
const shell = (body) =>
  `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      s += c;
      if (s.length > LIMIT) reject(new Error("тело больше 64 КиБ"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(s || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const json = (code, v) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(shell(readFileSync(page, "utf8")));
    }
    if (req.method === "GET" && req.url === "/api/state") return json(200, load());
    if (req.method === "POST" && req.url === "/api/mark") {
      const { id, on } = await body(req);
      if (typeof id !== "string") return json(400, { error: "id — строка" });
      const d = load();
      if (on) d.marks[id] = true;
      else delete d.marks[id];
      save(d);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/comment") {
      const { block, text } = await body(req);
      if (typeof block !== "string" || typeof text !== "string" || !text.trim()) return json(400, { error: "block и text — непустые строки" });
      const d = load();
      const c = { id: randomUUID(), block, text: text.trim(), at: new Date().toISOString() };
      d.comments.push(c);
      save(d);
      return json(200, c);
    }
    json(404, { error: "нет такого адреса" });
  } catch (e) {
    json(400, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`дизайн: http://localhost:${port} · заметки: ${notes}`));
// штатная остановка: новое не принимаем, текущие ответы доходят
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
