// Сервер дизайна: страница дизайна, прототип настоящего веб-приложения этого дерева и заметки — с одного адреса.
//   node scripts/design/serve.mjs <папка дизайна> [порт] [--app pult[,phone]]
// Папка docs/designs/<имя>/: index.html — страница дизайна на /; notes.json — метки и комментарии, пишет сервер;
//   mock.ts — мок нового (есть — прототип включён, приложение по умолчанию pult); data.mjs — данные мока с диска, необязательно.
// Прототип — /app/<приложение>/: части web/<имя>/stand/parts.ts, адреса прода — https://<имя>.pfarm.app/build.json.
//   На старте старые пропуска design-<имя> отозваны, выданы новые приглашения: ссылка в чат и ссылка для снимков — в stdout.
//   Остановка (SIGINT, SIGTERM) отзывает пропуска; после жёсткого выхода — pass.mjs close <папка>.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { context } from "esbuild";
import { BUNDLE, pageHtml } from "../shots/stand.mjs";
import { close, open, workersOf } from "./pass.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const appsArg = flag("--app");
const [designArg, portArg] = args;
const LIMIT = 1 << 20;
const STOP_MS = 15_000;

function fail(word, why) {
  console.error(`${word}: ${why}`);
  process.exit(1);
}
if (!designArg) fail("no_design", "нужна папка дизайна: node scripts/design/serve.mjs <папка> [порт] [--app pult]");
const DESIGN = path.resolve(designArg);
const PAGE = path.join(DESIGN, "index.html");
const NOTES = path.join(DESIGN, "notes.json");
const MOCK = path.join(DESIGN, "mock.ts");
const DATA = path.join(DESIGN, "data.mjs");
if (!fs.existsSync(DESIGN)) fail("no_design", `${DESIGN} нет`);
const hasMock = fs.existsSync(MOCK);
if (appsArg && !hasMock) fail("no_mock", `${MOCK} нет: прототипу нужен mock.ts — export default { … } satisfies ProtoMock (scripts/design/api.ts)`);
const appNames = hasMock ? (appsArg ?? "pult").split(",") : [];
const data = fs.existsSync(DATA) ? await import(pathToFileURL(DATA).href) : {};
const port = Number(portArg ?? 4800);

const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());
/** Сборка прототипа приложения: части стенда, настройки оболочки, адреса прода. Нет частей — отказ словом с подсказкой. */
async function appOf(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Object.assign(new Error(`имя приложения «${name}» — не папка web/`), { word: "bad_app" });
  const parts = path.join(ROOT, "web", name, "stand", "parts.ts");
  const fn = `${camel(name)}Parts`;
  if (!fs.existsSync(parts) || !new RegExp(`export function ${fn}\\b`).test(fs.readFileSync(parts, "utf8")))
    throw Object.assign(new Error(`нет web/${name}/stand/parts.ts с export function ${fn}(): AppPart[] — добавьте его по образцу web/pult/stand/parts.ts: части страницы, как в сборке приложения`), { word: "no_stand" });
  const opts = path.join(ROOT, "web", name, "src", "options.ts");
  const optName = name.toUpperCase().replace(/-/g, "_");
  const hasOpts = fs.existsSync(opts) && new RegExp(`export const ${optName}\\b`).test(fs.readFileSync(opts, "utf8"));
  const workers = await workersOf(name);
  const virtual = [
    `import * as stand from ${JSON.stringify(parts)};`,
    `export const parts = () => stand.${fn}();`,
    hasOpts ? `export { ${optName} as options } from ${JSON.stringify(opts)};` : "export const options = {};",
    `export const app = ${JSON.stringify(name)};`,
  ].join("\n");
  const ctx = await context({
    ...BUNDLE,
    entryPoints: [path.join(here, "entry.tsx")],
    write: false,
    outfile: "bundle.js",
    jsx: "automatic",
    logLevel: "silent",
    sourcemap: "inline",
    nodePaths: [path.join(ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"', __PROTO__: JSON.stringify({ app: name, workers }) },
    plugins: [
      {
        name: "design",
        setup(b) {
          b.onResolve({ filter: /^@proto\/app$/ }, () => ({ path: "app", namespace: "design" }));
          b.onResolve({ filter: /^@proto\/mock$/ }, () => ({ path: MOCK }));
          b.onResolve({ filter: /^@proto\/api$/ }, () => ({ path: path.join(here, "api.ts") }));
          b.onLoad({ filter: /.*/, namespace: "design" }, () => ({ contents: virtual, loader: "ts", resolveDir: ROOT }));
        },
      },
    ],
  });
  return { ctx, workers };
}

/** Приложения прототипа собираются до старта: отказ любого — сервер не стартует. */
const apps = new Map();
try {
  for (const name of appNames) apps.set(name, await appOf(name));
} catch (e) {
  for (const a of apps.values()) await a.ctx.dispose();
  fail(e.word ?? "error", e.message);
}

// Заметки: метки «прочитал» и комментарии одной формы { id, at, text, where }; where.page — "doc" или "app:<имя>".
const loadNotes = () => (fs.existsSync(NOTES) ? JSON.parse(fs.readFileSync(NOTES, "utf8")) : { marks: {}, comments: [] });
function saveNotes(d) {
  fs.writeFileSync(`${NOTES}.tmp`, JSON.stringify(d, null, 1));
  fs.renameSync(`${NOTES}.tmp`, NOTES);
}

// страница дизайна пишется без html/head/body, как для публикации; полный документ отдаётся как есть
const shell = (b) => (/^\s*<!doctype/i.test(b) ? b : `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${b}</body></html>`);
const body = (req) => new Promise((ok, no) => {
  let s = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { s += c; if (s.length > LIMIT) no(Object.assign(new Error("тело больше 1 МиБ"), { word: "too_large" })); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { no(Object.assign(e, { word: "bad_json" })); } });
});
const send = (res, code, type, v) => { res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); res.end(v); };
const json = (res, code, v) => send(res, code, "application/json", JSON.stringify(v));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      if (!fs.existsSync(PAGE)) return send(res, 404, "text/plain", `no_page: ${PAGE} нет`);
      return send(res, 200, "text/html", shell(fs.readFileSync(PAGE, "utf8")));
    }
    const m = /^\/app\/([a-z][a-z0-9-]*)\/(.*)$/.exec(u.pathname);
    if (m) {
      const a = apps.get(m[1]);
      if (!a) return send(res, 404, "text/plain", `no_app: прототип ${m[1]} не запущен — serve.mjs --app ${[...apps.keys(), m[1]].join(",")}`);
      if (m[2] === "") return send(res, 200, "text/html", pageHtml(`${m[1]} · прототип`, '<script src="bundle.js"></script>'));
      if (m[2] === "bundle.js") return send(res, 200, "text/javascript", (await a.ctx.rebuild()).outputFiles[0].contents);
      if (m[2] === "sw.js") return send(res, 200, "text/javascript", "// прототип: пушей нет");
    }
    if (u.pathname === "/sw.js") return send(res, 200, "text/javascript", "// прототип: пушей нет");
    if (req.method === "GET" && u.pathname.startsWith("/api/data/")) {
      const name = decodeURIComponent(u.pathname.slice("/api/data/".length));
      if (typeof data[name] !== "function") return json(res, 404, { error: `no_data: в ${DATA} нет export ${name}` });
      return json(res, 200, await data[name](JSON.parse(u.searchParams.get("p") ?? "{}")));
    }
    if (req.method === "GET" && u.pathname === "/api/state") return json(res, 200, loadNotes());
    if (req.method === "POST" && u.pathname === "/api/mark") {
      const { id, on } = await body(req);
      if (typeof id !== "string") return json(res, 400, { error: "bad_request: id — строка" });
      const d = loadNotes();
      if (on) d.marks[id] = true;
      else delete d.marks[id];
      saveNotes(d);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/comment") {
      const c = await body(req);
      const d = loadNotes();
      if (typeof c.delete === "string") {
        d.comments = d.comments.filter((x) => x.id !== c.delete);
        saveNotes(d);
        return json(res, 200, d);
      }
      if (typeof c.text !== "string" || !c.text.trim() || typeof c.where?.page !== "string") return json(res, 400, { error: "bad_request: text — непустая строка, where.page — doc или app:<имя>" });
      d.comments.push({ id: randomUUID(), at: new Date().toISOString(), text: c.text.trim(), where: c.where });
      saveNotes(d);
      return json(res, 200, d);
    }
    send(res, 404, "text/plain", "нет такого адреса");
  } catch (e) {
    if (e.errors) return json(res, 500, { error: "build", errors: e.errors.map((x) => x.text) });
    send(res, e.word ? 400 : 500, "text/plain", `${e.word ?? "error"}: ${e.message}`);
  }
});

const first = apps.values().next().value;
let links = null;
if (first) {
  try {
    links = await open(first.workers, DESIGN);
  } catch (e) {
    for (const a of apps.values()) await a.ctx.dispose();
    fail(e.word ?? "error", `приглашение у gate прода: ${e.message}`);
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`дизайн: http://localhost:${port}/ · заметки: ${NOTES}`);
  if (links) {
    if (links.closed.length) console.log(`старые пропуска отозваны: ${links.closed.join(", ")}`);
    // приглашение одноразовое: оно впускает браузер, остальные приложения прототипа открываются тем же браузером без него
    const [main, ...rest] = apps.keys();
    console.log(`в чат: http://localhost:${port}/app/${main}/#invite=${encodeURIComponent(links.user)}`);
    for (const name of rest) console.log(`ещё: http://localhost:${port}/app/${name}/`);
    console.log(`снимки: http://localhost:${port}/app/${main}/#invite=${encodeURIComponent(links.shots)}`);
  }
});

// штатная остановка: новое не принимаем, сборки закрыты, пропуска дизайна отозваны; не успели — жёсткий выход
let stopping = false;
async function stop(sig) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), STOP_MS).unref();
  server.close();
  for (const a of apps.values()) await a.ctx.dispose();
  if (first) {
    const gone = await close(first.workers, DESIGN).catch((e) => (console.error(`отзыв пропусков: ${e.message} — pass.mjs close ${designArg}`), []));
    console.log(`${sig}: пропуска отозваны: ${gone.join(", ") || "нет"}`);
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void stop(sig));
