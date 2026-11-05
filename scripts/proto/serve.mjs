// Сервер прототипа: настоящее веб-приложение этого дерева на проде только на чтение, мок дизайна, комментарии в файл.
//   node scripts/proto/serve.mjs <папка дизайна> [порт] [--app pult]
// Папка дизайна: mock.ts (обязательно), data.mjs (необязательно: данные с диска), comments.json (пишет сервер).
// Приложение: --app или ?app= на странице; части — web/<имя>/stand/parts.ts, адреса прода — https://<имя>.pfarm.app/build.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { context } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const DEFAULT_APP = flag("--app") ?? "pult";
const [designArg, portArg] = args;
const BUILD_MS = 10_000;

function fail(word, why) {
  console.error(`${word}: ${why}`);
  process.exit(1);
}
if (!designArg) fail("no_design", "нужна папка дизайна: node scripts/proto/serve.mjs <папка> [порт] [--app pult]");
const DESIGN = path.resolve(designArg);
const MOCK = path.join(DESIGN, "mock.ts");
if (!fs.existsSync(MOCK)) fail("no_mock", `${MOCK} нет: в папке дизайна нужен mock.ts — export default { … } satisfies ProtoMock (scripts/proto/api.ts)`);
const COMMENTS = path.join(DESIGN, "comments.json");
const DATA = path.join(DESIGN, "data.mjs");
const data = fs.existsSync(DATA) ? await import(pathToFileURL(DATA).href) : {};
const port = Number(portArg ?? 4800);

const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());
/** Приложение: части стенда, настройки оболочки, адреса прода. Нет частей — отказ словом с подсказкой. */
async function appOf(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Object.assign(new Error(`имя приложения «${name}» — не папка web/`), { word: "bad_app" });
  const parts = path.join(ROOT, "web", name, "stand", "parts.ts");
  const fn = `${camel(name)}Parts`;
  if (!fs.existsSync(parts) || !new RegExp(`export function ${fn}\\b`).test(fs.readFileSync(parts, "utf8")))
    throw Object.assign(new Error(`нет web/${name}/stand/parts.ts с export function ${fn}(): AppPart[] — добавьте его по образцу web/pult/stand/parts.ts: части страницы, как в сборке приложения`), { word: "no_stand" });
  const opts = path.join(ROOT, "web", name, "src", "options.ts");
  const optName = name.toUpperCase().replace(/-/g, "_");
  const hasOpts = fs.existsSync(opts) && new RegExp(`export const ${optName}\\b`).test(fs.readFileSync(opts, "utf8"));
  const url = `https://${name}.pfarm.app/build.json`;
  const list = await fetch(url, { signal: AbortSignal.timeout(BUILD_MS) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))).catch((e) => { throw Object.assign(new Error(`${url}: ${e.message}`), { word: "no_build" }); });
  if (!list.workers?.relay || !list.workers?.gate) throw Object.assign(new Error(`${url}: нет адресов relay и gate`), { word: "no_build" });
  const virtual = [
    `import * as stand from ${JSON.stringify(parts)};`,
    `export const parts = () => stand.${fn}();`,
    hasOpts ? `export { ${optName} as options } from ${JSON.stringify(opts)};` : "export const options = {};",
    `export const app = ${JSON.stringify(name)};`,
  ].join("\n");
  const ctx = await context({
    entryPoints: [path.join(here, "entry.tsx")],
    bundle: true,
    write: false,
    outfile: "bundle.js",
    format: "iife",
    target: "es2022",
    loader: { ".css": "text" },
    jsx: "automatic",
    logLevel: "silent",
    sourcemap: "inline",
    nodePaths: [path.join(ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"', __PROTO__: JSON.stringify({ app: name, workers: list.workers }) },
    plugins: [
      {
        name: "proto",
        setup(b) {
          b.onResolve({ filter: /^@proto\/app$/ }, () => ({ path: "app", namespace: "proto" }));
          b.onResolve({ filter: /^@proto\/mock$/ }, () => ({ path: MOCK }));
          b.onResolve({ filter: /^@proto\/api$/ }, () => ({ path: path.join(here, "api.ts") }));
          b.onLoad({ filter: /.*/, namespace: "proto" }, () => ({ contents: virtual, loader: "ts", resolveDir: ROOT }));
        },
      },
    ],
  });
  return { ctx, version: list.version };
}
const apps = new Map();
const appFor = (name) => {
  if (!apps.has(name)) apps.set(name, appOf(name).catch((e) => (apps.delete(name), Promise.reject(e))));
  return apps.get(name);
};

const page = (name) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${name} · прототип</title>
</head>
<body>
<div id="app"></div>
<script src="bundle.js?app=${name}"></script>
</body>
</html>
`;
const readComments = () => (fs.existsSync(COMMENTS) ? JSON.parse(fs.readFileSync(COMMENTS, "utf8")) : []);
const body = (req) => new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 1 << 20) no(new Error("too_large")); }); req.on("end", () => ok(s)); });
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(v)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const name = u.searchParams.get("app") ?? DEFAULT_APP;
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      await appFor(name);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page(name));
    }
    if (u.pathname === "/bundle.js") {
      const { ctx } = await appFor(name);
      const r = await ctx.rebuild();
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(r.outputFiles[0].contents);
    }
    if (u.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("// прототип: пушей нет");
    }
    if (u.pathname.startsWith("/api/data/")) {
      const fn = data[decodeURIComponent(u.pathname.slice("/api/data/".length))];
      if (typeof fn !== "function") return json(res, 404, { error: `no_data: в ${DATA} нет export ${u.pathname.slice(10)}` });
      return json(res, 200, await fn(JSON.parse(u.searchParams.get("p") ?? "{}")));
    }
    if (u.pathname === "/api/comments" && req.method === "GET") return json(res, 200, readComments());
    if (u.pathname === "/api/comments" && req.method === "POST") {
      const c = JSON.parse(await body(req));
      const all = readComments();
      const next = c.delete ? all.filter((x) => x.id !== c.delete) : [...all, { ...c, app: name, id: `c${Date.now().toString(36)}`, at: new Date().toISOString() }];
      fs.writeFileSync(COMMENTS, JSON.stringify(next, null, 1));
      return json(res, 200, next);
    }
    res.writeHead(404);
    res.end("нет");
  } catch (e) {
    if (e.errors) return json(res, 500, { error: "build", errors: e.errors.map((x) => x.text) });
    res.writeHead(e.word ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${e.word ?? "error"}: ${e.message}`);
  }
}).listen(port, "127.0.0.1", () => console.log(`прототип: http://localhost:${port} (?app=…, по умолчанию ${DEFAULT_APP}) · дизайн: ${DESIGN} · комментарии: ${COMMENTS}`));
