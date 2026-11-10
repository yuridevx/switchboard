// Файлы точки: блоки по ссылкам хранилища и запись на диск. Общие для подъёма сессии на машине и выгрузки сессии архива на компьютер без Host.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { CALL_MS, Refusal } from "@sb/protocol";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Запрос к хранилищу по ссылке: блока нет — слово missing; сеть или другой отказ — store_failed. */
export async function storeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
    throw new Refusal("store_failed", `хранилище: ${e}`);
  });
  if (res.status === 404) throw new Refusal("missing", "блока точки нет в хранилище");
  if (!res.ok) throw new Refusal("store_failed", `хранилище ответило ${res.status}`);
  return res;
}

export type PointFileLinks = { path: string; blocks: Array<{ hash: string; url: string }> };

/** Блоки точки по ссылкам: каждый сверен по SHA-256; файлы на диске трогаются, только когда все на руках. */
export async function download(files: PointFileLinks[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of files) {
    const parts: Buffer[] = [];
    for (const b of f.blocks) {
      const buf = Buffer.from(await (await storeFetch(b.url)).arrayBuffer());
      if (sha256(buf) !== b.hash) throw new Refusal("bad_point", `${f.path}: блок ${b.hash.slice(0, 12)} пришёл не тот`);
      parts.push(buf);
    }
    out.set(f.path, Buffer.concat(parts));
  }
  return out;
}

/** Файлы точки в папку: путь из архива не выходит из неё, файл появляется целиком. skip — имена, которые на диск не идут. */
export function writeFiles(target: string, files: Map<string, Buffer>, skip: string[] = []): string[] {
  const paths = [...files.keys()].filter((p) => !skip.includes(p)).map((p) => [p, resolve(target, p)] as const);
  for (const [p, file] of paths) if (!file.startsWith(resolve(target) + sep)) throw new Refusal("bad_point", `путь файла точки вне папки: ${p}`);
  for (const [p, file] of paths) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, files.get(p)!);
    renameSync(`${file}.tmp`, file);
  }
  return paths.map(([p]) => p);
}
