// Архив выпуска: tar (ustar) в gzip. Только файлы и папки — ссылок и особых записей в выпуске нет.
import { isAbsolute } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type TarFile = { path: string; data: Buffer; mode?: number };

const BLOCK = 512;

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

/** Имя записи: до 100 байт в name, длиннее — делится по «/» на prefix (до 155) и name. */
function splitName(path: string): [string, string] {
  if (Buffer.byteLength(path) <= 100) return ["", path];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new Error(`имя в архиве слишком длинное: ${path}`);
}

function header(path: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(BLOCK);
  const [prefix, name] = splitName(path);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii"); // время — 0: архив одной версии всегда одинаков
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, "ascii");
  return h;
}

/** Манифест модуля в корне архива — первой записью: «Выпуски» читают его по началу архива. */
export const MANIFEST = "module.json";

/** Собрать tgz: манифест модуля первым, остальные файлы по порядку путей, папки — из путей. */
export function pack(files: TarFile[]): Buffer {
  const key = (p: string) => (p === MANIFEST ? "" : p);
  const sorted = [...files].sort((a, b) => (key(a.path) < key(b.path) ? -1 : key(a.path) > key(b.path) ? 1 : 0));
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const f of sorted) {
    const segs = f.path.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/") + "/";
      if (dirs.has(d)) continue;
      dirs.add(d);
      parts.push(header(d, 0, 0o755, "5"));
    }
    parts.push(header(f.path, f.data.length, f.mode ?? 0o644, "0"), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function str(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString("utf8");
}

/** Записи архива: путь и содержимое; папки — с data null. Путь вне архива — исключение. */
export function entries(tgz: Buffer): Array<{ path: string; data: Buffer | null; mode: number }> {
  const t = gunzipSync(tgz);
  const out: Array<{ path: string; data: Buffer | null; mode: number }> = [];
  for (let off = 0; off + BLOCK <= t.length; ) {
    const h = t.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = str(h, 0, 100);
    const prefix = str(h, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(str(h, 124, 12).trim() || "0", 8);
    const mode = parseInt(str(h, 100, 8).trim() || "644", 8);
    const type = String.fromCharCode(h[156] || 48);
    off += BLOCK;
    if (path.split("/").includes("..") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error(`путь вне архива: ${path}`);
    if (type === "5") out.push({ path, data: null, mode });
    else if (type === "0") out.push({ path, data: Buffer.from(t.subarray(off, off + size)), mode });
    else throw new Error(`запись вида ${type} в архиве: ${path}`);
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/**
 * Манифест модуля по началу архива: первая запись — module.json → его содержимое, иначе null (архив без манифеста:
 * сборка Host, keeper). Распаковывает только начало: хватает первых килобайт архива.
 */
export async function manifestOf(head: Uint8Array): Promise<Record<string, unknown> | null> {
  const r = new Blob([new Uint8Array(head)]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let buf = Buffer.alloc(0);
  try {
    for (;;) {
      if (buf.length >= BLOCK) {
        if (str(buf, 0, 100) !== MANIFEST || str(buf, 345, 155)) return null;
        const end = BLOCK + parseInt(str(buf, 124, 12).trim() || "0", 8);
        if (buf.length >= end) return JSON.parse(buf.subarray(BLOCK, end).toString("utf8")) as Record<string, unknown>;
      }
      const { done, value } = await r.read();
      if (done) return null;
      buf = Buffer.concat([buf, value]);
    }
  } finally {
    r.cancel().catch(() => {});
  }
}
