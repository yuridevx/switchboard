// Блоки точки: каждый файл — куски по 1 МиБ от начала, имя блока — SHA-256 содержимого, в R2 — сжатый zstd.
// Файлы разговора (.jsonl) режутся до последнего перевода строки: посреди хода последняя строка может быть недописана.
// Своего списка «что уже в R2» нет: отпечатки считаются каждый раз заново, что есть в R2 — знает реестр.
import { createHash } from "node:crypto";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const BLOCK = 1 << 20;

/** Файл точки, как его хранит реестр: путь относительно папки проекта, размер и отпечатки блоков. */
export type PointFile = { p: string; size: number; b: string[] };
/** Где лежат байты блока на машине. */
export type Ref = { file: string; off: number; len: number };
export type Scan = { files: PointFile[]; refs: Map<string, Ref>; bytes: number };

/** Папка Claude Code машины: CLAUDE_CONFIG_DIR или ~/.claude. */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
/** Папка проекта рабочей папки: так её называет Claude Code — каждый знак не буква и не цифра — «-». */
export const projectDir = (cwd: string) => join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const pack = (b: Buffer) => zstdCompressSync(b);
export const unpack = (b: Buffer) => zstdDecompressSync(b);

/** Блоки одного файла. */
export function blocksOf(abs: string, rel: string, refs: Map<string, Ref>): PointFile {
  const buf = readFileSync(abs);
  let size = buf.length;
  if (rel.endsWith(".jsonl")) size = buf.lastIndexOf(0x0a) + 1;
  const b: string[] = [];
  for (let off = 0; off < size; off += BLOCK) {
    const len = Math.min(BLOCK, size - off);
    const h = sha256(buf.subarray(off, off + len));
    b.push(h);
    if (!refs.has(h)) refs.set(h, { file: abs, off, len });
  }
  return { p: rel, size, b };
}

/** Файл разговора <sid>.jsonl и папка <sid>/ рядом — по файлам. */
export function scan(proj: string, sid: string): Scan {
  const refs = new Map<string, Ref>();
  const files: PointFile[] = [blocksOf(join(proj, `${sid}.jsonl`), `${sid}.jsonl`, refs)];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile()) files.push(blocksOf(join(dir, e.name), r, refs));
    }
  };
  const side = join(proj, sid);
  if (existsSync(side) && statSync(side).isDirectory()) walk(side, sid);
  return { files, refs, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** Байты блока с диска. */
export function readRef(r: Ref): Buffer {
  const fd = openSync(r.file, "r");
  try {
    const buf = Buffer.alloc(r.len);
    readSync(fd, buf, 0, r.len, r.off);
    return buf;
  } finally {
    closeSync(fd);
  }
}
