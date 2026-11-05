// Запрос session.open: что открыть. Отказ — до того, как появится папка или процесс.
import { statSync } from "node:fs";
import { clientPath, refuse } from "@switchboard/host";
import type { Frame } from "@switchboard/host";
import { specOf } from "./spec.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Проверенный запрос: папка на диске; создать её можно только по просьбе — опечатка агента даёт отказ. */
export function parseOpen(req: Frame, machine: string, home: string) {
  const { name, dir, number } = req;
  if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_name", `session.open: имя ${JSON.stringify(name)}`);
  if (number !== undefined && typeof number !== "boolean") throw refuse("bad_spec", `session.open ${name}: number`);
  const asked = `${name}@${machine}`;
  const cwd = typeof dir === "string" ? clientPath(dir, home) : null;
  if (!cwd) throw refuse("bad_dir", `session.open ${asked}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
  if (req.mkdir !== undefined && typeof req.mkdir !== "boolean") throw refuse("bad_spec", `session.open ${asked}: mkdir`);
  const exists = isDir(cwd);
  if (!exists && req.mkdir !== true) throw refuse("bad_dir", `session.open ${asked}: папки ${String(dir)} нет`);
  specOf(req);
  if (req.resume !== undefined && typeof req.resume !== "string") throw refuse("bad_spec", `session.open ${asked}: resume`);
  if (req.fork !== undefined && typeof req.fork !== "boolean") throw refuse("bad_spec", `session.open ${asked}: fork`);
  if (req.point !== undefined && typeof req.point !== "number") throw refuse("bad_spec", `session.open ${asked}: point`);
  return { name, numbered: number === true, cwd, make: !exists, dir: dir as string };
}

/** Имя сессии: с номером — первый свободный на машине (disk-full-1, disk-full-2); без номера занятое — отказ. */
export function pickCallsign(name: string, numbered: boolean, machine: string, taken: (callsign: string) => boolean): string {
  if (numbered) {
    let n = 1;
    while (taken(`${name}-${n}@${machine}`)) n++;
    return `${name}-${n}@${machine}`;
  }
  const callsign = `${name}@${machine}`;
  if (taken(callsign)) throw refuse("name_taken", `session.open: ${callsign} уже есть`);
  return callsign;
}
