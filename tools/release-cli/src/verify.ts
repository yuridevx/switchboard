// Проверка номеров до push: код под нынешним номером и то, что лежит под ним в каталоге. Содержимое разное — CI откажет version_exists:
// называем, чей номер поднять, не дожидаясь прогона. Ничего не загружает. keeper не сверяется: собирать его здесь незачем.
import { entries, type FetchReply } from "@switchboard/release";

export type Local = { name: string; version: string; files: Array<{ path: string; data: Buffer }> };
export type Verdict = { same: string[]; fresh: string[]; stale: string[] };
export type Look = (part: string, version: string) => Promise<FetchReply>;
export type Get = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Предел скачивания одного архива: архивы каталога — мегабайты, вдвое выше самого долгого замера с запасом на сеть. */
const GET_MS = 60_000;
const SHOWN = 3;

function differing(local: Local["files"], remote: Local["files"]): string[] {
  const there = new Map(remote.map((f) => [f.path, f.data]));
  const changed = local.filter((f) => !there.get(f.path)?.equals(f.data)).map((f) => f.path);
  for (const f of local) there.delete(f.path);
  return [...changed, ...there.keys()];
}

/** Сверить части с каталогом. skip — пути архива, которые не сравниваются. Отказ каталога, кроме «такой версии нет», — исключение словами. */
export async function verify(parts: Local[], look: Look, get: Get, skip: (part: string, path: string) => boolean): Promise<Verdict> {
  const verdict: Verdict = { same: [], fresh: [], stale: [] };
  await Promise.all(
    parts.map(async ({ name, version, files }) => {
      const id = `${name} ${version}`;
      const r = await look(name, version);
      if (!r.ok && r.error !== "no_release") throw new Error(`releases.fetch ${id}: ${r.error}`);
      if (!r.ok) return void verdict.fresh.push(id);
      const res = await get(r.result.url, { signal: AbortSignal.timeout(GET_MS) });
      if (!res.ok) throw new Error(`${id}: R2 ответил ${res.status}`);
      const remote = entries(Buffer.from(await res.arrayBuffer())).flatMap((e) => (e.data ? [{ path: e.path, data: e.data }] : []));
      const diff = differing(files, remote).filter((path) => !skip(name, path));
      if (!diff.length) return void verdict.same.push(id);
      verdict.stale.push(`${id}: ${diff.slice(0, SHOWN).join(", ")}${diff.length > SHOWN ? ` и ещё ${diff.length - SHOWN}` : ""}`);
    }),
  );
  return verdict;
}
