// Модуль journal: сбои из сообщений SDK — строками журнала машины; журнал машины по запросу. Своего хранилища нет: читает папку, куда пишут ядро и keeper.
import { join } from "node:path";
import type { Frame, Host, Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { initLines, isInit, linesOf } from "./lines.ts";
import { read, type Query } from "./read.ts";

const text = (x: unknown) => x === undefined || typeof x === "string";

/** Проверить запрос: неверный вход — bad_frame. session, а не callsign: callsign у запроса к машине — адрес живой сессии, журнал убранной им не спросить. */
function queryOf(req: Frame): Query {
  const { since, limit, kind, session, part } = req as Record<string, unknown>;
  if (typeof limit !== "number" || limit < 1) throw refuse("bad_frame", "machine.journal: нет limit");
  if (typeof since !== "string" || Number.isNaN(Date.parse(since))) throw refuse("bad_frame", `machine.journal: since не время — ${String(since)}`);
  if (kind !== undefined && !(Array.isArray(kind) && kind.every((k) => typeof k === "string"))) throw refuse("bad_frame", "machine.journal: kind — список слов");
  if (!text(session)) throw refuse("bad_frame", "machine.journal: session — строка");
  if (!text(part)) throw refuse("bad_frame", "machine.journal: part — строка");
  return { since: new Date(since).toISOString(), limit, kind: kind as string[] | undefined, session: session as string | undefined, part: part as string | undefined };
}

export function make(): Module {
  let host: Host;
  /** сессии, у нынешнего процесса которых init уже записан */
  const started = new Set<string>();

  return {
    start(h) {
      host = h;
    },
    // известный сбой старта claude приходит сообщением result со startup_failure_reason, а не только stderr у keeper
    session: () => ({ env: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } }),
    requests: {
      "machine.journal": (req) => read(join(host.dataDir, "journal"), queryOf(req)),
    },
    on: {
      event(s, m) {
        const callsign = s.info.callsign;
        let lines = linesOf(m);
        if (isInit(m)) {
          lines = started.has(callsign) ? [] : initLines(m);
          started.add(callsign);
        }
        for (const line of lines) host.log({ callsign, ...line });
      },
      close(s) {
        started.delete(s.info.callsign);
      },
    },
  };
}
