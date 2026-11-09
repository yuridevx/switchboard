// Точка → файлы: блоки по ссылкам GET, проверка SHA-256, файлы разговора в папку проекта Claude. Зовут подъём Host и switchboard pull.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { CALL_MS } from "@switchboard/protocol";
import { BUNDLE } from "./git.ts";
import { Refused } from "./refused.ts";

const unpack = promisify(zstdDecompress);

/** Файл точки: путь от папки проекта Claude, размер и отпечатки блоков по порядку. */
export type PointFile = { p: string; size: number; b: string[] };

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDirOf = (claude: string, cwd: string) => join(claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

/** Тело блока по ссылке хранилища: сеть или отказ — store_failed; не открылся или не тот — bad_point. */
async function block(hash: string, url: string | undefined): Promise<Buffer> {
  if (!url) throw new Refused("bad_point", `нет ссылки на блок ${hash}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
    throw new Refused("store_failed", `хранилище: ${e}`);
  });
  if (!res.ok) throw new Refused("store_failed", `хранилище ответило ${res.status}`);
  const part = await unpack(Buffer.from(await res.arrayBuffer())).catch(() => {
    throw new Refused("bad_point", `блок ${hash} не открылся`);
  });
  if (sha256(part) !== hash) throw new Refused("bad_point", `блок ${hash} не тот`);
  return part;
}

/** Все файлы точки в памяти: файлы на диске трогаются, только когда все блоки на руках. */
export async function download(files: PointFile[], links: Record<string, string>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of files) {
    const parts: Buffer[] = [];
    for (const hash of f.b) parts.push(await block(hash, links[hash]));
    out.set(f.p, Buffer.concat(parts));
  }
  return out;
}

/** Прежние копии разговора в других папках проектов уходят в сторону: resume находит файл по sid во всех папках. */
export function setAside(claude: string, sid: string, target: string) {
  const projects = join(claude, "projects");
  for (const name of existsSync(projects) ? readdirSync(projects) : []) {
    const old = join(projects, name, `${sid}.jsonl`);
    if (join(projects, name) !== target && existsSync(old)) renameSync(old, `${old}.aside-${Date.now()}`);
  }
}

/** Файлы точки в папку проекта: путь из реестра не выходит из неё, файл появляется целиком; source — имя, под которым ляжет разговор. */
export function writeFiles(target: string, files: Map<string, Buffer>, sid: string, source: string) {
  const paths = [...files.keys()].filter((p) => p !== BUNDLE).map((p) => [p, resolve(target, p.startsWith(sid) ? source + p.slice(sid.length) : p)]);
  for (const [p, file] of paths) if (!file.startsWith(resolve(target) + sep)) throw new Refused("bad_point", `путь файла точки вне папки проекта: ${p}`);
  for (const [p, file] of paths) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, files.get(p)!);
    renameSync(`${file}.tmp`, file);
  }
}
