// Блоки точки: файл режется по 1 МиБ, имя блока — SHA-256 содержимого, в R2 лежит zstd. Машина ходит в R2 только по ссылкам реестра.
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { CALL_MS } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

export type PointFile = { p: string; size: number; b: string[] };

const BLOCK = 1 << 20;
const pack = promisify(zstdCompress);
const unpack = promisify(zstdDecompress);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Файл и его блоки; у разговора — до последнего перевода строки: хвост ещё дописывается. */
export function cut(buf: Buffer, p: string, parts: Map<string, Buffer>): PointFile {
  const size = p.endsWith(".jsonl") ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const b: string[] = [];
  for (let off = 0; off < size; off += BLOCK) {
    const part = buf.subarray(off, Math.min(size, off + BLOCK));
    const h = sha256(part);
    b.push(h);
    parts.set(h, part);
  }
  return { p, size, b };
}

/** Запрос к R2: сеть или отказ — слово r2_failed, причина вызывающему в журнал. */
async function r2(link: string, init: RequestInit): Promise<Response> {
  const r = await fetch(link, { ...init, signal: AbortSignal.timeout(CALL_MS) }).catch((e: unknown) => {
    throw refuse("r2_failed", `R2: ${String(e)}`);
  });
  if (!r.ok) throw refuse("r2_failed", `R2 ответил ${r.status}`);
  return r;
}

export async function upload(links: Record<string, string>, parts: Map<string, Buffer>): Promise<void> {
  for (const [h, link] of Object.entries(links)) await r2(link, { method: "PUT", body: new Uint8Array(await pack(parts.get(h)!)) });
}

/** Блоки по порядку файлов; повреждённый — bad_point: файлы на машине ещё не тронуты. */
export async function download(files: PointFile[], links: Record<string, string>): Promise<Map<string, Buffer>> {
  const parts = new Map<string, Buffer>();
  for (const h of files.flatMap((f) => f.b)) {
    if (parts.has(h)) continue;
    const packed = Buffer.from(await (await r2(links[h], { method: "GET" })).arrayBuffer());
    const part = await unpack(packed).catch(() => {
      throw refuse("bad_point", `блок ${h} не открылся`);
    });
    if (sha256(part) !== h) throw refuse("bad_point", `блок ${h} не тот`);
    parts.set(h, part);
  }
  return parts;
}

/** Байты файла точки из блоков. */
export const joined = (f: PointFile, parts: Map<string, Buffer>) => Buffer.concat(f.b.map((h) => parts.get(h)!));
