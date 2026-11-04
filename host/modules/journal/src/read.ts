// Чтение журнала машины: файлы host и keeper по дням UTC в папке данных Host. Предел запроса останавливает чтение: день, где набралось больше limit, — последний.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Line = { t: string; kind?: string; callsign?: string; part?: string; [k: string]: unknown };
export type Query = { since: string; kind?: string[]; session?: string; part?: string; limit: number };

const FILE = /^(?:host|keeper)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Файлы журнала по дням от дня since. Папки ещё нет — журнал пуст. */
async function days(dir: string, from: string): Promise<Array<[string, string[]]>> {
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  });
  const byDay = new Map<string, string[]>();
  for (const name of names) {
    const day = FILE.exec(name)?.[1];
    if (day && day >= from) byDay.set(day, [...(byDay.get(day) ?? []), name]);
  }
  return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1));
}

const matches = (l: Line, q: Query) =>
  l.t > q.since && (!q.kind || q.kind.includes(l.kind ?? "note")) && (q.session === undefined || l.callsign === q.session) && (q.part === undefined || l.part === q.part);

/** Строки после since, старые первыми; kind, session и part — по желанию. part — чья строка: host, keeper или имя приложения. */
export async function read(dir: string, q: Query): Promise<{ records: Line[]; more: boolean }> {
  const found: Line[] = [];
  for (const [, files] of await days(dir, q.since.slice(0, 10))) {
    const today: Line[] = [];
    for (const file of files) {
      const body = await readFile(join(dir, file), "utf8");
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        const l = JSON.parse(line) as Line;
        if (matches(l, q)) today.push(l);
      }
    }
    found.push(...today.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)));
    if (found.length > q.limit) break;
  }
  return { records: found.slice(0, q.limit), more: found.length > q.limit };
}
