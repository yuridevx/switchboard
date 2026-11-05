// Архив выпуска: tar в gzip с постоянными байтами: одно содержимое — один хэш на любой машине.
import { constants, gunzipSync, gzipSync } from "node:zlib";

export type TarFile = { path: string; data: Uint8Array; mode?: number };
export type TarEntry = { path: string; data?: Buffer; mode: number };

/** Манифест модуля: первая запись архива, чтобы читать его по началу файла. */
export const MANIFEST = "module.json";

const BLOCK = 512;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";

/** Поля name и prefix ustar: путь режется по косой черте. */
function nameFields(path: string): [string, string] {
  if (Buffer.byteLength(path) <= 100) return [path, ""];
  for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [name, prefix];
  }
  throw new Error(`имя в архиве слишком длинное: ${path}`);
}

function header(path: string, size: number, mode: number, type: string): Buffer {
  const [name, prefix] = nameFields(path);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0);
  h.write(octal(mode, 8), 100, "latin1");
  h.write(octal(0, 8), 108, "latin1");
  h.write(octal(0, 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(0, 12), 136, "latin1");
  h.write(" ".repeat(8), 148, "latin1");
  h.write(type, 156, "latin1");
  h.write("ustar\0" + "00", 257, "latin1");
  h.write(prefix, 345);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(octal(sum, 7) + " ", 148, "latin1");
  return h;
}

/** Сравнение путей по байтам, манифест первым. */
function pathOrder(a: string, b: string): number {
  if (a === MANIFEST || b === MANIFEST) return a === b ? 0 : a === MANIFEST ? -1 : 1;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Папки — из путей файлов. */
function foldersOf(files: TarFile[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.path.indexOf("/"); i > 0; i = f.path.indexOf("/", i + 1)) dirs.add(f.path.slice(0, i + 1));
  return [...dirs];
}

export function pack(files: TarFile[]): Buffer {
  const items = [...files.map((f) => ({ path: f.path, file: f })), ...foldersOf(files).map((path) => ({ path, file: null }))].sort((a, b) => pathOrder(a.path, b.path));
  const blocks: Buffer[] = [];
  for (const { path, file } of items) {
    if (!file) {
      blocks.push(header(path, 0, DIR_MODE, "5"));
      continue;
    }
    blocks.push(header(path, file.data.length, file.mode ?? FILE_MODE, "0"), Buffer.from(file.data));
    const rest = file.data.length % BLOCK;
    if (rest) blocks.push(Buffer.alloc(BLOCK - rest));
  }
  blocks.push(Buffer.alloc(2 * BLOCK));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

const text = (b: Buffer, at: number, width: number) => {
  const raw = b.subarray(at, at + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? width : end).toString("utf8");
};

/** Путь записи: name и prefix. */
const pathOf = (block: Buffer) => [text(block, 345, 155), text(block, 0, 100)].filter(Boolean).join("/");

/** Записи tar: файлы с данными, папки без них. Путь вне папки и особые записи — исключение. */
function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  for (let at = 0; at + BLOCK <= tar.length && tar[at] !== 0; ) {
    const block = tar.subarray(at, at + BLOCK);
    const path = pathOf(block);
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`путь вне архива: ${path}`);
    const mode = parseInt(text(block, 100, 8), 8);
    const size = parseInt(text(block, 124, 12), 8);
    const type = String.fromCharCode(block[156] || 48);
    if (type !== "0" && type !== "5") throw new Error(`запись вида ${type} в архиве: ${path}`);
    at += BLOCK;
    out.push(type === "5" ? { path, mode } : { path, mode, data: Buffer.from(tar.subarray(at, at + size)) });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export const entries = (tgz: Uint8Array): TarEntry[] => readTar(gunzipSync(tgz));

/** Манифест по началу архива: без полного скачивания. Первая запись не манифест — null. */
export async function manifestOf(start: Uint8Array): Promise<Record<string, unknown> | null> {
  const tar = gunzipSync(start, { finishFlush: constants.Z_SYNC_FLUSH });
  if (tar.length < BLOCK || pathOf(tar.subarray(0, BLOCK)) !== MANIFEST) return null;
  const size = parseInt(text(tar, 124, 12), 8);
  return JSON.parse(tar.subarray(BLOCK, BLOCK + size).toString("utf8")) as Record<string, unknown>;
}
