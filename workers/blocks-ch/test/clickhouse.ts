// Поддельный ClickHouse для лесов blocks-ch: HTTP-вход с теми запросами, что шлёт Worker, таблица blocks в памяти.
// Живёт в Node (привязка-функция miniflare): распаковка zstd — как у настоящего по Content-Encoding.
import { zstdDecompressSync } from "node:zlib";

const USER = "sb_test";
const KEY = "pass0";
const blocks = new Map<string, Buffer>();

const listOf = (sql: string) => [...(/IN \(([^)]*)\)/.exec(sql)?.[1].matchAll(/'([0-9a-f]{64})'/g) ?? [])].map((m) => m[1]);
const json = (rows: object[]) => new Response(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

export async function clickhouse(req: Request): Promise<Response> {
  if (req.headers.get("x-clickhouse-user") !== USER || req.headers.get("x-clickhouse-key") !== KEY) return new Response("Authentication failed", { status: 516 });
  const url = new URL(req.url);
  const body = Buffer.from(await req.arrayBuffer());
  const inUrl = url.searchParams.get("query");
  const sql = inUrl ?? body.toString("utf8");
  if (sql.startsWith("INSERT INTO blocks")) {
    if (req.headers.get("content-encoding") !== "zstd") return new Response("ожидалось тело zstd", { status: 400 });
    blocks.set(url.searchParams.get("param_hash")!, zstdDecompressSync(body));
    return new Response("");
  }
  if (sql.startsWith("TRUNCATE")) {
    blocks.clear();
    return new Response("");
  }
  if (sql.startsWith("DELETE FROM blocks")) {
    for (const h of listOf(sql)) blocks.delete(h);
    return new Response("");
  }
  if (sql.startsWith("SELECT hash, any(length(data))")) return json(listOf(sql).flatMap((hash) => (blocks.has(hash) ? [{ hash, size: String(blocks.get(hash)!.length) }] : [])));
  if (sql.startsWith("SELECT data FROM blocks")) return new Response(blocks.get(/hash = '([0-9a-f]{64})'/.exec(sql)![1]) ?? "");
  if (sql.startsWith("SELECT hash, line")) {
    const q = url.searchParams.get("param_q")!.toLowerCase();
    const limit = Number(/LIMIT (\d+) FORMAT/.exec(sql)![1]);
    const rows = listOf(sql).flatMap((hash) => {
      const line = blocks
        .get(hash)
        ?.toString("utf8")
        .split("\n")
        .find((l) => l !== "" && l.toLowerCase().includes(q) && l.includes(url.searchParams.get("param_also")!));
      return line === undefined ? [] : [{ hash, line }];
    });
    return json(rows.slice(0, limit));
  }
  return new Response(`Unknown query: ${sql.slice(0, 80)}`, { status: 400 });
}
