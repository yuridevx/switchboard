// Модуль machine: папки машины. Что стоит и работает на машине, отвечает keeper.state. Событий Claude не слушает, хранить нечего.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

/** Слово отказа по коду ошибки ОС; незнакомая ошибка идёт дальше — это ошибка модуля. */
const WORD: Record<string, string> = { ENOENT: "not_found", ENOTDIR: "not_found", ENAMETOOLONG: "not_found", EACCES: "no_access", EPERM: "no_access" };

export function make(o: { home?: string } = {}): Module {
  const home = o.home ?? homedir();
  return {
    requests: {
      "machine.dirs"(req, ctx) {
        const given = req.path;
        const who = `machine.dirs «${String(given)}» от ${ctx.from ?? "?"}`;
        if (typeof given !== "string" || !given) throw refuse("bad_frame", `${who}: нет пути`);
        const path = clientPath(given, home);
        if (!path) throw refuse("bad_frame", `${who}: путь не от ~ и не полный`);
        try {
          const dirs = readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
          return { path: given, dirs };
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (WORD[code]) throw refuse(WORD[code], `${who}: ${code}`);
          throw e;
        }
      },
    },
  };
}
