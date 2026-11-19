// Файлы сессий: содержимое лежит в хранилище под своим хэшем SHA-256 — один раз на флот. Служба выдаёт подписанные ссылки
// на загрузку и чтение (байты идут мимо Worker'а), записывает список «путь → хэш» сайта и отдаёт сайт из хранилища.
// Записей и базы у модуля нет: список сайта — тоже объект хранилища.
import { type FileIn, Refusal } from "@sb/protocol";
import type { Env, Module } from "../../env.ts";
import { link, uploadLinks } from "../../r2.ts";

/** Содержимое у флота своё: ссылку получает только человек или машина этого флота, знающие хэш. */
const fileKey = (fleet: string, hash: string) => `files/${fleet}/${hash}`;
const siteKey = (site: string) => `sites/${site}.json`;

/** Положить содержимое в хранилище флота под его хэшем; уже лежит — не трогается. Ответ — запись файла для сообщения или тикета. */
export async function store(env: Env, fleet: string, name: string, body: Uint8Array): Promise<FileIn> {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = fileKey(fleet, hash);
  if (!(await env.FILES.head(key))) await env.FILES.put(key, body);
  return { name, hash, size: body.length };
}

/** Список сайта в хранилище: чей флот и какой файл лежит под каким путём. */
type SiteList = { fleet: string; files: Record<string, { hash: string; size: number }> };

const SITE = /^\/s\/([0-9a-f]{32})(\/.*)?$/;
/** Сайт идёт в песочнице браузера: у него свой пустой источник — пропуск пульта, cookies и localStorage страницы флота ему не видны.
 *  Файлы сайта для него «чужой источник», поэтому отдаются с разрешением читать их отовсюду.
 *  no-transform: файл уходит байт в байт — его отпечаток (etag) есть хэш содержимого. Без этого Cloudflare на своём домене вставляет
 *  в страницы сайта скрипт аналитики (живая проверка прода 17 нояб.: 525 байт вместо 158, в песочнице скрипт сыплет ошибками). */
const SITE_HEADERS = { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "cache-control": "no-cache, no-transform" };
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", wasm: "application/wasm", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
};
const typeOf = (path: string) => TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

const gone = (why: string) => new Response(why + "\n", { status: 404, headers: { ...SITE_HEADERS, "content-type": "text/plain; charset=utf-8" } });

/** Сайт сессии: /s/<номер>/<путь>. Без пропуска: номер — 128 бит из секрета машины. Путь ищется в списке сайта, файл читается из хранилища по хэшу. */
export async function site(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const m = SITE.exec(url.pathname);
  if (!m || (req.method !== "GET" && req.method !== "HEAD")) return gone("такого адреса нет");
  // адрес сайта кончается косой чертой: от неё считаются относительные ссылки страницы
  if (!m[2]) return new Response(null, { status: 301, headers: { ...SITE_HEADERS, location: `${url.pathname}/${url.search}` } });
  const list = await env.FILES.get(siteKey(m[1]!));
  if (!list) return gone("такого сайта нет");
  const { fleet, files } = await list.json<SiteList>();
  let path: string;
  try {
    path = decodeURIComponent(m[2].slice(1));
  } catch {
    return gone("такого файла нет");
  }
  if (path === "" || path.endsWith("/")) path += "index.html";
  const file = files[path];
  if (!file) return gone("такого файла нет");
  const headers = { ...SITE_HEADERS, "content-type": typeOf(path), etag: `"${file.hash}"` };
  if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  const body = await env.FILES.get(fileKey(fleet, file.hash));
  if (!body) return gone("такого файла нет");
  return new Response(req.method === "HEAD" ? null : body.body, { headers: { ...headers, "content-length": String(body.size) } });
}

export const files: Module = {
  name: "files",
  handlers: {
    async "files.put"(i: { files: { hash: string; size: number }[] }, ctx) {
      return { upload: await uploadLinks(ctx.env, [...new Set(i.files.map((f) => f.hash))], (hash) => fileKey(ctx.fleet, hash)) };
    },

    async "files.get"(i: { hash: string; name?: string }, ctx) {
      const key = fileKey(ctx.fleet, i.hash);
      if (!(await ctx.env.FILES.head(key))) throw new Refusal("no_file", `содержимого ${i.hash.slice(0, 12)} в хранилище нет`);
      // с именем ссылка отдаёт файл вложением: браузер скачивает его под этим именем
      return { url: await link(ctx.env, "GET", key, i.name ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(i.name)}` } : {}) };
    },

    async "files.site"(i: { site: string; files: { path: string; hash: string; size: number }[] }, ctx) {
      const list: SiteList = { fleet: ctx.fleet, files: Object.fromEntries(i.files.map((f) => [f.path, { hash: f.hash, size: f.size }])) };
      await ctx.env.FILES.put(siteKey(i.site), JSON.stringify(list), { httpMetadata: { contentType: "application/json" } });
      ctx.log.info("сайт записан", { site: i.site, files: i.files.length, size: i.files.reduce((n, f) => n + f.size, 0), from: ctx.who.addr });
      return { url: `${ctx.origin}/s/${i.site}/` };
    },
  },
};
