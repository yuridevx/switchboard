// Папки машины: только чтение; папку создаёт session.open.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

/** Ошибка ОС → слово контракта; остальное — ошибка модуля. */
const WORDS: Record<string, string> = { ENOENT: "not_found", ENOTDIR: "not_found", ENAMETOOLONG: "not_found", EACCES: "no_access", EPERM: "no_access" };

export function make({ home = homedir() }: { home?: string } = {}): Module {
  return {
    requests: {
      "machine.dirs": ({ path }, { from }) => {
        const said = `machine.dirs «${String(path)}» от ${from}`;
        if (typeof path !== "string" || !path) throw refuse("bad_frame", `${said}: нет пути`);
        const full = clientPath(path, home);
        if (!full) throw refuse("bad_frame", `${said}: путь не от ~ и не полный`);
        try {
          return { path, dirs: readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() };
        } catch (e) {
          const { code } = e as NodeJS.ErrnoException;
          if (!code || !WORDS[code]) throw e;
          throw refuse(WORDS[code], `${said}: ${code}`);
        }
      },
    },
  };
}
