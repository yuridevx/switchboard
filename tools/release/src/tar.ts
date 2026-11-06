// Архив выпуска: ustar в gzip. Те же файлы — те же байты: без времени и владельца, порядок задан. Формат читает и keeper на Go.
import { constants, gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const NAME = 100;
const PREFIX = 155;
const FILE = "0";
const DIR = "5";
/** Байт ОС заголовка gzip: zlib пишет свой (Windows 10, Linux 3), а архив один на все машины. */
const GZIP_OS = 9;
const UNIX = 3;

export const MANIFEST = "module.json";
export type TarFile = { path: string; data: Buffer; mode?: number };
export type TarEntry = { path: string; data?: Buffer; mode: number };

const size = (s: string) => Buffer.byteLength(s);

/** Длинный путь: начало — в поле prefix, разрез по самой левой косой черте, после которой имя влезает. */
function split(path: string): [string, string] {
  if (size(path) <= NAME) return ["", path];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    if (size(path.slice(i + 1)) <= NAME && size(path.slice(0, i)) <= PREFIX) return [path.slice(0, i), path.slice(i + 1)];
  }
  throw new Error(`имя в архиве слишком длинное: ${path}`);
}

function header(path: string, type: string, mode: number, length: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const octal = (n: number, at: number, width: number) => h.write(`${n.toString(8).padStart(width, "0")}\0`, at, "latin1");
  const [prefix, name] = split(path);
  h.write(name, 0);
  octal(mode, 100, 7);
  octal(0, 108, 7);
  octal(0, 116, 7);
  octal(length, 124, 11);
  octal(0, 136, 11);
  h.fill(" ", 148, 156);
  h.write(type, 156, "latin1");
  h.write("ustar\0" + "00", 257, "latin1");
  h.write(prefix, 345);
  h.write(`${h.reduce((a: number, b: number) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

/** Файлы и папки из их путей; module.json первым — манифест читается по началу архива. */
export function pack(files: TarFile[]): Buffer {
  const all = new Map<string, TarFile | null>();
  for (const f of files) {
    const dirs = f.path.split("/").slice(0, -1);
    dirs.forEach((_, i) => all.set(`${dirs.slice(0, i + 1).join("/")}/`, null));
    all.set(f.path, f);
  }
  const first = (p: string) => (p === MANIFEST ? 0 : 1);
  const paths = [...all.keys()].sort((a, b) => first(a) - first(b) || (a < b ? -1 : 1));
  const blocks = paths.flatMap((path) => {
    const f = all.get(path);
    if (!f) return [header(path, DIR, 0o755, 0)];
    return [header(path, FILE, f.mode ?? 0o644, f.data.length), f.data, Buffer.alloc(-f.data.length & (BLOCK - 1))];
  });
  const tgz = gzipSync(Buffer.concat([...blocks, Buffer.alloc(2 * BLOCK)]), { level: 9 });
  tgz[GZIP_OS] = UNIX;
  return tgz;
}

function read(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  for (let at = 0; at + BLOCK <= tar.length && tar[at] !== 0; ) {
    const text = (from: number, width: number) => tar.toString("utf8", at + from, at + from + width).replace(/\0.*$/s, "");
    const [prefix, name, type] = [text(345, PREFIX), text(0, NAME), text(156, 1)];
    const path = prefix ? `${prefix}/${name}` : name;
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`путь вне архива: ${path}`);
    if (type !== FILE && type !== DIR) throw new Error(`запись вида ${type} в архиве: ${path}`);
    const length = parseInt(text(124, 12), 8);
    const mode = parseInt(text(100, 8), 8);
    at += BLOCK;
    out.push(type === DIR ? { path, mode } : { path, mode, data: tar.subarray(at, at + length) });
    at += Math.ceil(length / BLOCK) * BLOCK;
  }
  return out;
}

export const entries = (tgz: Uint8Array): TarEntry[] => read(gunzipSync(tgz));

/** Манифест по началу архива: хватает первых байт, остальное не читается. Без манифеста первой записью — null. */
export function manifestOf(head: Uint8Array): Record<string, unknown> | null {
  const [first] = read(gunzipSync(head, { finishFlush: constants.Z_SYNC_FLUSH }));
  return first?.path === MANIFEST ? JSON.parse(first.data!.toString("utf8")) : null;
}
