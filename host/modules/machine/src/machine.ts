// Модуль machine: папки машины и её состояние. Событий Claude не слушает, сессий не трогает, хранить нечего.
import { mkdirSync, readdirSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
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
      async "machine.state"(_req, { host }) {
        const r = await host.request("list", { v: 1 });
        if (!r.ok) throw new Error(`keeper list: ${r.error}`);
        return {
          host: host.version,
          sdk: host.sdk,
          node: process.version,
          os: { platform: platform(), arch: arch(), release: release() },
          started: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          processes: (r.result as { processes?: unknown[] } | undefined)?.processes ?? [],
        };
      },
    },
  };
}
