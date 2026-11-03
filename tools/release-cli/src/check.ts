// Проверка номеров до push: код под нынешним номером и то, что лежит под ним в каталоге. Содержимое разное — CI откажет version_exists:
// называем, чей номер поднять, не дожидаясь прогона. Ничего не загружает. Архив ядра сравнивается по исходникам: его package-lock
// зависит от ОС, и пишет его npm. keeper не сверяется: собирать его здесь незачем, его номер поднимают только при правке самого keeper.
import { entries, type FetchReply, type Get } from "@switchboard/release";

export type Look = (part: string, version: string) => Promise<FetchReply>;
export type Local = { name: string; version: string; files: Array<{ path: string; data: Buffer }> };
export type CheckResult = { same: string[]; fresh: string[]; stale: string[] };

/** Предел скачивания одного архива: архивы каталога — мегабайты, вдвое выше самого долгого замера с запасом на сеть. */
const GET_MS = 60_000;

/** Различия файлов: добавленные, убранные и изменённые пути. */
export function differ(local: Local["files"], remote: Local["files"]): string[] {
  const there = new Map(remote.map((f) => [f.path, f.data]));
  const out: string[] = [];
  for (const f of local) {
    const r = there.get(f.path);
    if (!r || !r.equals(f.data)) out.push(f.path);
    there.delete(f.path);
  }
  return [...out, ...there.keys()];
}

/** Сверить части с каталогом. skip — пути архива, которые не сравниваются. Отказ каталога, кроме «такой версии нет», — исключение словами. */
export async function check(parts: Local[], look: Look, get: Get, skip: (part: string, path: string) => boolean = () => false): Promise<CheckResult> {
  const res: CheckResult = { same: [], fresh: [], stale: [] };
  await Promise.all(
    parts.map(async (p) => {
      const r = await look(p.name, p.version);
      if (!r.ok) {
        if (r.error !== "no_release") throw new Error(`releases.fetch ${p.name} ${p.version}: ${r.error}`);
        res.fresh.push(`${p.name} ${p.version}`);
        return;
      }
      const got = await get(r.result.url, { signal: AbortSignal.timeout(GET_MS) });
      if (!got.ok) throw new Error(`${p.name} ${p.version}: R2 ответил ${got.status}`);
      const remote = entries(Buffer.from(await got.arrayBuffer())).flatMap((e) => (e.data ? [{ path: e.path, data: e.data }] : []));
      const diff = differ(p.files, remote).filter((f) => !skip(p.name, f));
      if (diff.length) res.stale.push(`${p.name} ${p.version}: ${diff.slice(0, 3).join(", ")}${diff.length > 3 ? ` и ещё ${diff.length - 3}` : ""}`);
      else res.same.push(`${p.name} ${p.version}`);
    }),
  );
  return res;
}
