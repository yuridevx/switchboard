// Архив выпуска: ustar в gzip, только файлы и папки. Время в заголовке — 0, порядок записей задан: одно содержимое даёт один tar.
import { isAbsolute } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type TarFile = { path: string; data: Buffer; mode?: number };
export type TarEntry = { path: string; data: Buffer | null; mode: number };

/** Манифест модуля — первая запись архива: «Выпуски» читают его по началу архива. */
export const MANIFEST = "module.json";

const BLOCK = 512;
const FILE = "0";
const FOLDER = "5";

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

/** Поля name и prefix заголовка: длинный путь делится по «/», name до 100 байт, prefix до 155. */
function nameAndPrefix(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const cuts = [...path.matchAll(/\//g)].map((m) => m.index);
  for (const at of cuts) {
    const [prefix, name] = [path.slice(0, at), path.slice(at + 1)];
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`имя в архиве слишком длинное: ${path}`);
}

function headerOf(path: string, size: number, mode: number, kind: string): Buffer {
  const { name, prefix } = nameAndPrefix(path);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii");
  h.write(" ".repeat(8), 148, "ascii");
  h.write(kind, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${octal(sum, 7)} `, 148, "ascii");
  return h;
}

/** Собрать tgz: манифест первым, остальное по порядку путей, папки — из путей. */
export function pack(files: TarFile[]): Buffer {
  const rank = (f: TarFile) => (f.path === MANIFEST ? "" : f.path);
  const ordered = files.toSorted((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  const seen = new Set<string>();
  const out: Buffer[] = [];
  for (const { path, data, mode = 0o644 } of ordered) {
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const folder = `${parts.slice(0, n).join("/")}/`;
      if (!seen.has(folder)) out.push(headerOf(folder, 0, 0o755, FOLDER));
      seen.add(folder);
    }
    out.push(headerOf(path, data.length, mode, FILE), data, Buffer.alloc(-data.length & (BLOCK - 1)));
  }
  out.push(Buffer.alloc(2 * BLOCK));
  return gzipSync(Buffer.concat(out), { level: 9 });
}

function field(block: Buffer, at: number, width: number): string {
  const raw = block.subarray(at, at + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? width : end).toString("utf8");
}
const number = (block: Buffer, at: number, width: number, none: string) => parseInt(field(block, at, width).trim() || none, 8);

const pathOf = (block: Buffer) => {
  const [name, prefix] = [field(block, 0, 100), field(block, 345, 155)];
  return prefix ? `${prefix}/${name}` : name;
};

/** Записи архива; у папки data — null. Путь наружу архива или запись другого вида — исключение. */
export function entries(tgz: Buffer): TarEntry[] {
  const tar = gunzipSync(tgz);
  const out: TarEntry[] = [];
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((b) => b === 0)) break;
    at += BLOCK;
    const path = pathOf(block);
    const size = number(block, 124, 12, "0");
    const mode = number(block, 100, 8, "644");
    const kind = String.fromCharCode(block[156] || FILE.charCodeAt(0));
    if (path.split("/").includes("..") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error(`путь вне архива: ${path}`);
    if (kind !== FILE && kind !== FOLDER) throw new Error(`запись вида ${kind} в архиве: ${path}`);
    out.push({ path, mode, data: kind === FILE ? Buffer.from(tar.subarray(at, at + size)) : null });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/** Манифест по началу архива: распаковывается столько, сколько нужно на первую запись. Первая запись другая — null. */
export async function manifestOf(head: Uint8Array): Promise<Record<string, unknown> | null> {
  const reader = new Blob([new Uint8Array(head)]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let got = Buffer.alloc(0);
  try {
    while (true) {
      if (got.length >= BLOCK) {
        if (pathOf(got.subarray(0, BLOCK)) !== MANIFEST) return null;
        const end = BLOCK + number(got, 124, 12, "0");
        if (got.length >= end) return JSON.parse(got.subarray(BLOCK, end).toString("utf8")) as Record<string, unknown>;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      got = Buffer.concat([got, value]);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
