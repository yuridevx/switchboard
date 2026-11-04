// Блоки точки: файл режется на куски по 1 МиБ, имя блока — SHA-256 содержимого, в R2 блок лежит сжатым zstd.
// Файл разговора (.jsonl) берётся до последнего перевода строки: посреди хода последняя строка бывает недописана.
// Что уже в R2, знает реестр; модуль считает отпечатки заново на каждую точку и ходит в R2 по его ссылкам, без ключа и подписи.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { claudeDir } from "@switchboard/host";

const BLOCK = 1 << 20;

export type PointFile = { p: string; size: number; b: string[] };
export type Links = Record<string, string>;
export type Fetch = typeof fetch;
type Place = { file: string; off: number; len: number };
/** Файлы точки и где лежат байты каждого блока. */
export type Scan = { files: PointFile[]; places: Map<string, Place>; bytes: number };

/** Папка проекта рабочей папки: так её называет Claude Code — каждый знак не буква и не цифра — «-». */
export const projectDir = (cwd: string) => join(claudeDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Нарезать файл и запомнить, где лежат новые блоки. */
export function addFile(scan: Scan, abs: string, rel: string): void {
  const buf = readFileSync(abs);
  const size = rel.endsWith(".jsonl") ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const b: string[] = [];
  for (let off = 0; off < size; off += BLOCK) {
    const len = Math.min(BLOCK, size - off);
    const hash = sha256(buf.subarray(off, off + len));
    b.push(hash);
    if (!scan.places.has(hash)) scan.places.set(hash, { file: abs, off, len });
  }
  scan.files.push({ p: rel, size, b });
  scan.bytes += size;
}

/** Файл разговора <sid>.jsonl и всё в папке <sid>/ рядом с ним. */
export function scanSession(proj: string, sid: string): Scan {
  const scan: Scan = { files: [], places: new Map(), bytes: 0 };
  addFile(scan, join(proj, `${sid}.jsonl`), `${sid}.jsonl`);
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
      else if (e.isFile()) addFile(scan, join(dir, e.name), `${rel}/${e.name}`);
    }
  };
  const side = join(proj, sid);
  if (existsSync(side) && statSync(side).isDirectory()) walk(side, sid);
  return scan;
}

function readPlace({ file, off, len }: Place): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, off);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Запрос по ссылке: нет ссылки, обрыв сети или статус не 2xx — одна ошибка «R2 <метод> f/<отпечаток>: причина». */
export class R2Error extends Error {}

async function call(method: "GET" | "PUT", links: Links, hash: string, f: Fetch, body?: Buffer): Promise<Response> {
  const fail = (why: unknown) => new R2Error(`R2 ${method} f/${hash}: ${String(why)}`);
  const url = links[hash];
  if (!url) throw fail("ссылки нет");
  let r: Response;
  try {
    r = await f(url, { method, ...(body ? { body: new Uint8Array(body) } : {}) });
  } catch (e) {
    throw fail(e);
  }
  if (!r.ok) throw fail(r.status);
  return r;
}

/** Положить в R2 блоки, которых там нет. */
export async function upload(missing: string[], links: Links, scan: Scan, f: Fetch): Promise<void> {
  for (const hash of missing) {
    const place = scan.places.get(hash);
    if (!place) throw new R2Error(`блока ${hash} нет на машине`);
    await call("PUT", links, hash, f, zstdCompressSync(readPlace(place)));
  }
}

/** Байты файла точки из R2, сверенные по отпечаткам и длине. Несовпадение — Error с причиной, сбой R2 — R2Error. */
export async function download(file: PointFile, links: Links, f: Fetch): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const hash of file.b) {
    const packed = Buffer.from(await (await call("GET", links, hash, f)).arrayBuffer());
    let raw: Buffer;
    try {
      raw = zstdDecompressSync(packed);
    } catch {
      throw new Error(`блок ${hash} не распаковался`);
    }
    if (sha256(raw) !== hash) throw new Error(`блок ${hash} — другое содержимое`);
    parts.push(raw);
  }
  const body = Buffer.concat(parts);
  if (body.length !== file.size) throw new Error(`длина ${body.length}, в точке ${file.size}`);
  return body;
}
