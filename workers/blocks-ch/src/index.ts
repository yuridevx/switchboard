// Worker blocks-ch: контракт blocks на ClickHouse. Одна таблица blocks (hash, data), сжатие — кодек ZSTD самого ClickHouse.
// Ссылки ведут в этот Worker: PUT передаёт тело zstd в INSERT как есть (распаковывает ClickHouse по Content-Encoding),
// GET отдаёт блок сжатым zstd — формат контракта. Формата разговора не знает: поиск — строки с q в названных блоках.
import { zstdCompressSync } from "node:zlib";
import { WorkerEntrypoint } from "cloudflare:workers";
import { CONTRACT, HASH } from "@switchboard/blocks";
import { accepts, fail, ok, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

/** Срок ссылки — как у ссылок R2. */
const LINK_S = 3600;
/** Предел одного запроса к ClickHouse. */
const CH_MS = 60_000;
/** Блок — не больше 1 МиБ содержимого, сжатый — тем более. */
const MAX_BLOCK = 1024 * 1024;
const MAX_Q = 200;

const log = (row: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "blocks-ch", ...row }));

class Refusal extends Error {
  word: string;
  constructor(word: string, why: string) {
    super(why);
    this.word = word;
  }
}

function hashesOf(f: Frame): string[] {
  const { hashes } = f;
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && HASH.test(h))) throw new Refusal("bad_frame", "hashes — не отпечатки SHA-256");
  return [...new Set(hashes as string[])];
}

type Ask = { body?: BodyInit | null; params?: Record<string, string>; headers?: Record<string, string> };

/** Запрос к ClickHouse. Текст запроса — в теле, кроме INSERT: там тело — данные. Отпечатки в тексте — только проверенные HASH. */
async function ch(env: Env, query: string, o: Ask = {}): Promise<Response> {
  const url = new URL("http://clickhouse/");
  if (o.body !== undefined) url.searchParams.set("query", query);
  for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, v);
  const res = await env.CH.fetch(url, {
    method: "POST",
    headers: { "X-ClickHouse-User": env.CH_USER, "X-ClickHouse-Key": env.CH_PASSWORD, ...o.headers },
    body: o.body === undefined ? query : o.body,
    signal: AbortSignal.timeout(CH_MS),
  }).catch((e: unknown) => {
    throw new Refusal("store_failed", `ClickHouse не ответил: ${e}`);
  });
  if (!res.ok) throw new Refusal("store_failed", `ClickHouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function rows<T>(env: Env, query: string, params?: Record<string, string>): Promise<T[]> {
  const text = await (await ch(env, `${query} FORMAT JSONEachRow`, { params })).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}
const list = (hashes: string[]) => `(${hashes.map((h) => `'${h}'`).join(",")})`;

/** Лежащие блоки с размером содержимого: до слияния в таблице бывают копии строки — по одной на отпечаток. */
async function sizes(env: Env, hashes: string[]): Promise<Record<string, number>> {
  if (!hashes.length) return {};
  const found = await rows<{ hash: string; size: string | number }>(env, `SELECT hash, any(length(data)) AS size FROM blocks WHERE hash IN ${list(hashes)} GROUP BY hash`);
  return Object.fromEntries(found.map((r) => [r.hash, Number(r.size)]));
}

const encoder = new TextEncoder();
async function sign(env: Env, method: string, hash: string, until: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.CH_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`blocks ${method} ${hash} ${until}`)));
  return btoa(String.fromCharCode(...mac))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function link(env: Env, method: "GET" | "PUT", hash: string): Promise<string> {
  const until = Math.floor(Date.now() / 1000) + LINK_S;
  return `${env.BLOCKS_URL.replace(/\/$/, "")}/b/${hash}?m=${method}&e=${until}&s=${await sign(env, method, hash, until)}`;
}
const links = async (env: Env, method: "GET" | "PUT", hashes: string[]) => Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await link(env, method, h)])));

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  async "blocks.links"(env, f) {
    const hashes = hashesOf(f);
    if (f.method === "GET") return { links: await links(env, "GET", hashes) };
    if (f.method !== "PUT") throw new Refusal("bad_frame", `метод ${String(f.method)}`);
    const have = await sizes(env, hashes);
    return { have, links: await links(env, "PUT", hashes.filter((h) => !(h in have))) };
  },

  async "blocks.drop"(env, f) {
    const have = await sizes(env, hashesOf(f));
    const gone = Object.keys(have);
    if (gone.length) await ch(env, `DELETE FROM blocks WHERE hash IN ${list(gone)}`);
    return { blocks: gone.length, bytes: Object.values(have).reduce((n, s) => n + s, 0) };
  },

  async "blocks.search"(env, f) {
    const hashes = hashesOf(f);
    const { q, limit, also = "" } = f;
    if (typeof q !== "string" || q.length > MAX_Q) throw new Refusal("bad_frame", `q — строка до ${MAX_Q} знаков`);
    if (typeof also !== "string" || also.length > MAX_Q) throw new Refusal("bad_frame", `also — строка до ${MAX_Q} знаков`);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw new Refusal("bad_frame", "limit — целое больше 0");
    if (!hashes.length) return [];
    return rows<{ hash: string; line: string }>(
      env,
      `SELECT hash, line FROM blocks ARRAY JOIN splitByChar('\\n', data) AS line WHERE hash IN ${list(hashes)} AND line != '' AND positionCaseInsensitiveUTF8(line, {q:String}) > 0 AND position(line, {also:String}) > 0 LIMIT 1 BY hash LIMIT ${limit}`,
      { param_q: q, param_also: also },
    );
  },
};

export class Blocks extends WorkerEntrypoint<Env> {
  /** Кадр от points по привязке → ответ. Отказ — словом и строкой журнала. */
  async frame(f: Frame): Promise<Frame[]> {
    const { id, type } = f;
    try {
      const off = accepts(f, CONTRACT);
      if (off) throw new Refusal(off.word, off.why);
      return [ok(id as string, await REQUESTS[type as keyof typeof CONTRACT](this.env, f))];
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      log({ kind: "refuse", ev: type, word: e.word, why: e.message });
      return [fail(id as string, e.word)];
    }
  }
}

function refuse(status: number, why: string): Response {
  log({ kind: "refuse", ev: "link", status, why });
  return new Response(why, { status });
}

/** Ссылка на блок: метод, срок и подпись сверены — PUT кладёт тело в таблицу, GET отдаёт блок сжатым. */
async function serve(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const hash = /^\/b\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
  const method = url.searchParams.get("m");
  const until = Number(url.searchParams.get("e"));
  if (!hash || method !== req.method || (method !== "GET" && method !== "PUT")) return new Response(null, { status: 404 });
  if (!(until > Date.now() / 1000) || url.searchParams.get("s") !== (await sign(env, method, hash, until))) return refuse(403, "ссылка не подписана или истекла");
  try {
    if (method === "PUT") {
      // блок мал: тело целиком — длина известна ClickHouse, предел — по настоящим байтам, а не по заголовку
      const body = await req.arrayBuffer();
      if (!(body.byteLength > 0 && body.byteLength <= MAX_BLOCK)) return refuse(413, `тело блока — от 1 байта до ${MAX_BLOCK}`);
      await ch(env, "INSERT INTO blocks SELECT {hash:String}, data FROM input('data String') FORMAT RawBLOB", {
        body,
        params: { param_hash: hash, async_insert: "0" },
        headers: { "Content-Encoding": "zstd" },
      });
      return new Response(null, { status: 200 });
    }
    // ClickHouse отдаёт сжатым, платформа распаковывает сама — Worker сжимает zstd снова: тело уходит в формате контракта
    const res = await ch(env, `SELECT data FROM blocks WHERE hash = '${hash}' LIMIT 1 FORMAT RawBLOB`, { params: { enable_http_compression: "1" }, headers: { "Accept-Encoding": "zstd" } });
    const data = new Uint8Array(await res.arrayBuffer());
    if (!data.length) return refuse(404, `блока ${hash} нет`);
    return new Response(zstdCompressSync(data), { headers: { "content-type": "application/octet-stream" } });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return refuse(502, e.message);
  }
}

export default { fetch: serve };
