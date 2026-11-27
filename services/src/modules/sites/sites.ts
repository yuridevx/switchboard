// Сайты флота: папка статики сессии на своём поддомене. У сайта три места хранения: строка «имя → адрес» в записях флота (по ней сайт
// находят выкладка, удаление и запрос сессии к базе), запись сайта под адресом в хранилище (флот, проект, список «путь → хэш», настройки —
// по ней Worker отдаёт сайт, не зная флота) и своя база SQLite (таблицы страницы, комментарии и метки панели). Содержимое файлов держит служба файлов.
// Входа у сайта нет: адрес с секретом знает тот, у кого ссылка; адрес, названный вручную, открыт каждому.
import { CALL_MS, kindOf, MAX_FRAME, newId, Refusal, within } from "@sb/protocol";
import { log, outbound, type Ctx, type Deps, type Env, type Module, type Outside } from "../../env.ts";
import { records, type Db } from "../../records.ts";
import { raise } from "../factory/contract.ts";
import { read } from "../files/contract.ts";

const NAME = "sites";
/** Адрес автора у тикета с комментариями. */
const FROM = ".sites";
/** Срок работы тикета с комментариями, когда исполнитель — сессия: у поста срок свой. */
const FEEDBACK_TERM = "1d";

const NAMES = ["CREATE TABLE IF NOT EXISTS sites (name TEXT PRIMARY KEY, label TEXT NOT NULL)"];
/** Таблицы панели в базе сайта: комментарий привязан к элементу блока, метка — блок и правки, которые человек в нём видел. */
const KIT = [
  "CREATE TABLE IF NOT EXISTS sb_comments (id INTEGER PRIMARY KEY, block TEXT NOT NULL, el TEXT NOT NULL, label TEXT NOT NULL, quote TEXT, text TEXT NOT NULL, ticket TEXT, reply TEXT, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sb_marks (block TEXT PRIMARY KEY, seen TEXT NOT NULL)",
];

/** Запись сайта под его адресом. */
type Site = {
  fleet: string; name: string;
  /** сессия, которая выложила: ей идёт тикет с комментариями, если исполнитель не назван */
  callsign: string;
  project?: string; commit?: string; dirty?: boolean;
  comments: boolean; marks: boolean; feedback?: string;
  files: Record<string, { hash: string; size: number }>;
};

const siteKey = (label: string) => `sites/${label}.json`;
const names = (env: Env, fleet: string) => records(env, fleet, NAME, NAMES);
const base = (env: Env, s: Pick<Site, "fleet">, label: string) => records(env, s.fleet, NAME, KIT, label);

/** Секрет адреса: 80 случайных бит шестнадцатью знаками. */
function secret(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0n;
  for (const b of crypto.getRandomValues(new Uint8Array(10))) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) out += abc[Number((bits >> BigInt(5 * i)) & 31n)];
  return out;
}

/** Хвост адресов сайтов этого флота, например «-t.pfarm.app»; не задан — сайтов у флота нет. */
function tail(env: Env): string {
  if (!env.SITES_HOST) throw new Refusal("no_sites", "адрес сайтов у флота не задан: настройка SITES_HOST");
  return env.SITES_HOST;
}

async function labelOf(ctx: Ctx, name: string): Promise<string> {
  const row = await names(ctx.env, ctx.fleet).first<{ label: string }>("SELECT label FROM sites WHERE name = ?", name);
  if (!row) throw new Refusal("no_site", `сайта ${name} во флоте нет`);
  return row.label;
}

/** Запрос SQL к базе сайта: ошибка запроса — отказ словом с текстом SQLite. */
async function query(db: Db, sql: string, params: (string | number | null)[]): Promise<Record<string, unknown>[]> {
  try {
    return await db.all(sql, ...params);
  } catch (e) {
    throw new Refusal("bad_sql", e instanceof Refusal ? e.why : String(e));
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", wasm: "application/wasm", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
};
const typeOf = (path: string) => TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** no-transform: файл уходит байт в байт — Cloudflare на своём домене иначе вставляет в страницы скрипт аналитики. */
const HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-cache, no-transform" };
/** Скрипт панели в странице: строка одна и всегда та же, её добавляет только сервер. Настройки сайта приходят вместе со скриптом. */
export const KIT_LINE = `\n<script src="/_sb/kit.js"></script>\n`;
const KIT_PATH = "/_sb/kit.js";

const text = (body: string, status: number) => new Response(body + "\n", { status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Текст тикета с комментариями: адрес сайта, коммит и пункты по порядку — блок, элемент, цитата, комментарий. */
function feedbackText(url: string, s: Site, rows: { block: string; label: string; quote: string | null; text: string }[]): string {
  const head = `${url}${s.commit ? ` · коммит ${s.commit}${s.dirty ? " (в папке были правки вне коммита)" : ""}` : ""}`;
  const items = rows.map((r, i) => `${i + 1}. Блок «${r.block || "страница"}» · элемент «${r.label}»${r.quote ? `\n   > ${r.quote}` : ""}\n   ${r.text.replace(/\n/g, "\n   ")}`);
  return `${head}\n\n${items.join("\n\n")}`;
}

/** Все неотправленные комментарии — одним тикетом исполнителю, названному при выкладке; строки получают его номер. */
async function submit(env: Env, w: Outside, label: string, s: Site, url: string): Promise<{ ticket: string | null; comments: number }> {
  const db = base(env, s, label);
  const rows = await db.all<{ id: number; block: string; label: string; quote: string | null; text: string }>("SELECT id, block, label, quote, text FROM sb_comments WHERE ticket IS NULL ORDER BY id");
  if (!rows.length) return { ticket: null, comments: 0 };
  if (!s.project) throw new Refusal("no_project", `сайт ${s.name} выложила сессия без проекта: тикет завести негде — выложите сайт из сессии проекта`);
  const to = s.feedback ?? s.callsign;
  const { id } = await raise(env, w, s.fleet, {
    project: s.project, to, title: `Комментарии к сайту ${s.name} · ${rows.length}`, text: feedbackText(url, s, rows), by: FROM, trace: newId("t"),
    ...(kindOf(to) === "session" ? { for: FEEDBACK_TERM } : {}),
  });
  await db.run(`UPDATE sb_comments SET ticket = ? WHERE id IN (${rows.map(() => "?").join(",")})`, id, ...rows.map((r) => r.id));
  w.log.info("комментарии сайта ушли тикетом", { site: s.name, label, ticket: id, comments: rows.length, to });
  return { ticket: id, comments: rows.length };
}

/** Тело запроса страницы: JSON не больше предела кадра. */
async function body<T>(req: Request): Promise<T> {
  const raw = await req.text();
  if (raw.length > MAX_FRAME) throw new Refusal("too_large", "запрос больше предела");
  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    throw new Refusal("bad_input", "тело запроса — не JSON");
  }
}

/** Запрос на адрес сайта: файлы сайта, скрипт панели, база и отправка комментариев. Адрес не сайта — null: запрос идёт дальше по входу служб. */
export async function site(req: Request, env: Env, deps: Deps): Promise<Response | null> {
  const url = new URL(req.url);
  if (!env.SITES_HOST || !url.hostname.endsWith(env.SITES_HOST)) return null;
  const label = url.hostname.slice(0, -env.SITES_HOST.length);
  if (!label || label.includes(".")) return null;
  const rec = await env.FILES.get(siteKey(label));
  if (!rec) return text("такого сайта нет", 404);
  const s = await rec.json<Site>();
  const w: Outside = { platform: deps.platform ?? env.PLATFORM, fetch: deps.fetch ?? outbound, log: log.with({ module: NAME, fleet: s.fleet }) };

  if (url.pathname.startsWith("/_sb/")) {
    try {
      if (url.pathname === KIT_PATH && req.method === "GET") {
        // сам скрипт — файл страницы флота; настройки сайта дописываются перед ним
        const kit = env.ASSETS ? await env.ASSETS.fetch(new Request(new URL(KIT_PATH, req.url))) : null;
        if (!kit?.ok) return text("скрипта панели в этой сборке нет", 404);
        const about = { name: s.name, comments: s.comments, marks: s.marks, ...(s.commit ? { commit: s.commit, dirty: !!s.dirty } : {}) };
        return new Response(`window.sbSite=${JSON.stringify(about)};\n${await kit.text()}`, { headers: { ...HEADERS, "content-type": "text/javascript; charset=utf-8" } });
      }
      if (url.pathname === "/_sb/db" && req.method === "POST") {
        const q = await body<{ sql?: unknown; params?: unknown }>(req);
        if (typeof q.sql !== "string" || !q.sql || (q.params !== undefined && !Array.isArray(q.params))) throw new Refusal("bad_input", "нужен sql строкой и params списком");
        return json({ rows: await within(query(base(env, s, label), q.sql, (q.params ?? []) as (string | number | null)[]), CALL_MS, "база сайта не ответила") });
      }
      if (url.pathname === "/_sb/submit" && req.method === "POST" && s.comments) return json(await within(submit(env, w, label, s, `${url.origin}/`), CALL_MS, "тикет не завёлся в предел"));
      return text("такого адреса нет", 404);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      w.log.warn("отказ сайту", { site: s.name, label, path: url.pathname, word: e.word, why: e.why });
      return json({ error: e.word, why: e.why }, 400);
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return text("такого адреса нет", 404);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return text("такого файла нет", 404);
  }
  if (path === "" || path.endsWith("/")) path += "index.html";
  const file = s.files[path];
  if (!file) return text("такого файла нет", 404);
  const type = typeOf(path);
  const page = type.startsWith("text/html");
  // у страницы HTML отпечаток — хэш файла со строкой панели: строка постоянна, отпечаток меняется только с файлом
  const headers = { ...HEADERS, "content-type": type, etag: `"${file.hash}${page ? "-kit" : ""}"` };
  if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  const got = await read(env, s.fleet, file.hash);
  if (!got) return text("такого файла нет", 404);
  if (!page) return new Response(req.method === "HEAD" ? null : got.body, { headers: { ...headers, "content-length": String(got.size) } });
  const out = new TextEncoder().encode(KIT_LINE);
  const whole = new Uint8Array(got.size + out.length);
  whole.set(new Uint8Array(await got.arrayBuffer()), 0);
  whole.set(out, got.size);
  return new Response(req.method === "HEAD" ? null : whole, { headers: { ...headers, "content-length": String(whole.length) } });
}

export const sites: Module = {
  name: NAME,
  handlers: {
    async "sites.put"(i: { name: string; address?: string; callsign: string; files: { path: string; hash: string; size: number }[]; commit?: string; dirty?: boolean; comments?: boolean; marks?: boolean; feedback?: string }, ctx) {
      const host = tail(ctx.env);
      const db = names(ctx.env, ctx.fleet);
      const was = await db.first<{ label: string }>("SELECT label FROM sites WHERE name = ?", i.name);
      if (was && i.address && i.address !== was.label) throw new Refusal("bad_input", `адрес сайта ${i.name} уже выдан: ${was.label}${host}. Сменить адрес — удалить сайт (site_remove) и выложить снова`);
      const label = was?.label ?? i.address ?? `${i.name}-${secret()}`;
      // занятый адрес не перезаписывается: под ним уже лежит запись другого сайта — этого флота под другим именем или чужого
      if (!was && (await ctx.env.FILES.head(siteKey(label)))) throw new Refusal("taken", `адрес ${label}${host} занят другим сайтом`);
      const project = (await within(ctx.platform.sessions(ctx.fleet), CALL_MS, "платформа не назвала сессии")).find((s) => s.callsign === i.callsign)?.spec.project;
      const rec: Site = {
        fleet: ctx.fleet, name: i.name, callsign: i.callsign, comments: i.comments ?? true, marks: i.marks ?? true,
        ...(project ? { project } : {}), ...(i.commit ? { commit: i.commit, dirty: !!i.dirty } : {}), ...(i.feedback ? { feedback: i.feedback } : {}),
        files: Object.fromEntries(i.files.map((f) => [f.path, { hash: f.hash, size: f.size }])),
      };
      await ctx.env.FILES.put(siteKey(label), JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
      if (!was) await db.run("INSERT INTO sites (name, label) VALUES (?, ?)", i.name, label);
      ctx.log.info("сайт записан", { site: i.name, label, files: i.files.length, size: i.files.reduce((n, f) => n + f.size, 0), from: i.callsign, ...(was ? {} : { why: "новый" }) });
      return { url: `https://${label}${host}/` };
    },

    async "site.remove"(i: { name: string }, ctx) {
      const label = await labelOf(ctx, i.name);
      await ctx.env.FILES.delete(siteKey(label));
      await base(ctx.env, ctx, label).wipe();
      await names(ctx.env, ctx.fleet).run("DELETE FROM sites WHERE name = ?", i.name);
      ctx.log.info("сайт удалён", { site: i.name, label, from: ctx.who.addr });
      return { removed: true };
    },

    async "site.db"(i: { name: string; sql: string; params?: (string | number | null)[] }, ctx) {
      return { rows: await query(base(ctx.env, ctx, await labelOf(ctx, i.name)), i.sql, i.params ?? []) };
    },
  },
};
