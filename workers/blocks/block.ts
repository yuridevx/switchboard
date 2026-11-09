// Блок по ссылке GET — формат контракта: тело zstd, имя — SHA-256 содержимого. Одно чтение у points.history, подъёма Host и pull.
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

const unpack = promisify(zstdDecompress);
/** Предел чтения одного блока по ссылке. */
const BLOCK_MS = 120_000;

/** Отказ чтения блока: store_failed — хранилище не ответило или отказало; bad_block — тело не открылось или не тот SHA-256. */
export class BlockError extends Error {
  word: "store_failed" | "bad_block";
  constructor(word: "store_failed" | "bad_block", why: string) {
    super(why);
    this.word = word;
  }
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Содержимое блока по ссылке: сверено с именем. */
export async function fetchBlock(hash: string, url: string | undefined): Promise<Buffer> {
  if (!url) throw new BlockError("bad_block", `нет ссылки на блок ${hash}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(BLOCK_MS) }).catch((e) => {
    throw new BlockError("store_failed", `хранилище: ${e}`);
  });
  if (!res.ok) throw new BlockError("store_failed", `хранилище ответило ${res.status}`);
  const part = await unpack(Buffer.from(await res.arrayBuffer())).catch(() => {
    throw new BlockError("bad_block", `блок ${hash} не открылся`);
  });
  if (sha256(part) !== hash) throw new BlockError("bad_block", `блок ${hash} не тот`);
  return part;
}

/** Файлы точки целиком: блоки по порядку, каждый сверен. */
export async function fetchFiles(files: Array<{ p: string; b: string[] }>, links: Record<string, string>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of files) {
    const parts: Buffer[] = [];
    for (const hash of f.b) parts.push(await fetchBlock(hash, links[hash]));
    out.set(f.p, Buffer.concat(parts));
  }
  return out;
}
