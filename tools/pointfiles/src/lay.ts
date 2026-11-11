// Точка → файлы: блоки по ссылкам GET, проверка SHA-256, файлы разговора в папку проекта Claude. Зовут подъём Host и switchboard pull.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BlockError, fetchFiles } from "@switchboard/blocks";
import { BUNDLE } from "./git.ts";
import { Refused } from "./refused.ts";

/** Файл точки: путь от папки проекта Claude, размер и отпечатки блоков по порядку. */
export type PointFile = { p: string; size: number; b: string[] };

export { sha256 } from "@switchboard/blocks";

/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDirOf = (claude: string, cwd: string) => join(claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

/** Все файлы точки в памяти: файлы на диске трогаются, только когда все блоки на руках. Блок не тот — bad_point. */
export async function download(files: PointFile[], links: Record<string, string>): Promise<Map<string, Buffer>> {
  return fetchFiles(files, links).catch((e) => {
    throw e instanceof BlockError ? new Refused(e.word === "bad_block" ? "bad_point" : e.word, e.message) : e;
  });
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
