// Запрос к провайдеру: ровно те заголовки, что дали, в их порядке. Без decode тело ответа идёт как есть, со сжатием провайдера —
// так прокси отдаёт его claude байт в байт; с decode — распаковано (перевод Muse читает поток сам). Fetch так не умеет: он сжимает и распаковывает сам.
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

/** Тишина провайдера дольше этого — запрос оборван: столько же ждёт ответа сам claude (API_TIMEOUT_MS по умолчанию). */
export const IDLE_MS = 600_000;

const agents = { "http:": new http.Agent({ keepAlive: true }), "https:": new https.Agent({ keepAlive: true }) };

export type Upstream = { status: number; headers: IncomingMessage["headers"]; body: Readable };

function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  if (enc === "gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  return res;
}

/** Ответ — когда пришли заголовки. Сеть или тишина дольше IDLE_MS — отказ словами. */
export function send(url: string, o: { method: string; headers: Record<string, string | string[]>; body?: Buffer; signal: AbortSignal; decode?: boolean }): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    // как у reqwest Muse CLI: сжатие, хост и длина — последними
    const headers = { ...o.headers, ...(o.decode ? { "accept-encoding": "gzip,deflate,br" } : {}), host: u.host, ...(o.body ? { "content-length": String(o.body.length) } : {}) };
    const req = mod.request(u, { method: o.method, headers, signal: o.signal, agent: agents[u.protocol as "http:" | "https:"] }, (res) => {
      res.setTimeout(IDLE_MS, () => res.destroy(new Error(`провайдер молчит ${IDLE_MS / 1000} с`)));
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: o.decode ? decoded(res) : res });
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error(`провайдер не ответил за ${IDLE_MS / 1000} с`)));
    req.on("error", reject);
    req.end(o.body);
  });
}

export async function textOf(r: Upstream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
