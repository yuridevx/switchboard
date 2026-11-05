import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

const WORD: Record<string, string> = { ENOENT: "not_found", ENOTDIR: "not_found", ENAMETOOLONG: "not_found", EACCES: "no_access", EPERM: "no_access" };

export function make({ home = homedir() }: { home?: string } = {}): Module {
  return {
    requests: {
      "machine.dirs": ({ path }, { from }) => {
        const who = `machine.dirs «${path}» от ${from}`;
        if (typeof path !== "string" || !path) throw refuse("bad_frame", `${who}: нет пути`);
        const full = clientPath(path, home);
        if (!full) throw refuse("bad_frame", `${who}: путь не от ~ и не полный`);
        try {
          const dirs = readdirSync(full, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
          return { path, dirs: dirs.sort() };
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (WORD[code]) throw refuse(WORD[code], `${who}: ${code}`);
          throw e;
        }
      },
    },
  };
}
