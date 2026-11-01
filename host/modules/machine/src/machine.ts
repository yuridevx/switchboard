// Модуль machine: папки машины. Что стоит и работает на машине, отвечает keeper.state. Событий Claude не слушает, хранить нечего.
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { refuse } from "@switchboard/host";
import type { Ctx, Frame, Module } from "@switchboard/host";

export type MachineOptions = { home?: string };

/** Путь запроса → путь на диске: от ~ или полный; иначе bad_frame. */
function resolvePath(req: Frame, ctx: Ctx, home: string): { given: string; path: string } {
  const given = req.path;
  const who = `${req.type} «${String(given)}» от ${ctx.from ?? "?"}`;
  if (typeof given !== "string" || !given) throw refuse("bad_frame", `${who}: нет пути`);
  if (given === "~") return { given, path: home };
  if (given.startsWith("~/")) return { given, path: join(home, ...given.slice(2).split("/")) };
  if (isAbsolute(given)) return { given, path: given };
  throw refuse("bad_frame", `${who}: путь не от ~ и не полный`);
}

/** Слово отказа по коду ошибки ОС; незнакомая ошибка — дальше, это ошибка модуля. */
function osWord(e: unknown, who: string, words: Record<string, string>): never {
  const code = (e as NodeJS.ErrnoException).code ?? "";
  const word = words[code];
  if (word) throw refuse(word, `${who}: ${code}`);
  throw e;
}

export function machine(o: MachineOptions = {}): Module {
  const home = o.home ?? homedir();
  return {
    requests: {
      "machine.dirs"(req, ctx) {
        const { given, path } = resolvePath(req, ctx, home);
        try {
          const dirs = readdirSync(path, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
          return { path: given, dirs };
        } catch (e) {
          return osWord(e, `machine.dirs «${given}» от ${ctx.from ?? "?"}`, { ENOENT: "not_found", ENOTDIR: "not_found", EACCES: "no_access", EPERM: "no_access" });
        }
      },
      "machine.mkdir"(req, ctx) {
        const { given, path } = resolvePath(req, ctx, home);
        try {
          // одна папка в существующей: цепочку не строим
          mkdirSync(path);
          return { path: given };
        } catch (e) {
          return osWord(e, `machine.mkdir «${given}» от ${ctx.from ?? "?"}`, { EEXIST: "exists", ENOENT: "not_found", ENOTDIR: "not_found", EACCES: "no_access", EPERM: "no_access" });
        }
      },
    },
  };
}
