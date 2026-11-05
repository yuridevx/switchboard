// Модуль journal: сбои из сообщений SDK — строками журнала машины; machine.journal — чтение файлов журнала host и keeper.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Frame, Host, LogRecord, Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { initLines, isInit, linesOf } from "./lines.ts";

const FILE = /^(?:host|keeper)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

type Record_ = LogRecord & { t: string; part?: string };

function query(req: Frame) {
  const { since, limit, kind, session, part } = req;
  if (!Number.isInteger(limit) || (limit as number) < 1) throw refuse("bad_frame", "machine.journal: нет limit");
  if (typeof since !== "string" || Number.isNaN(Date.parse(since))) throw refuse("bad_frame", `machine.journal: since не время — ${String(since)}`);
  if (kind !== undefined && !Array.isArray(kind)) throw refuse("bad_frame", "machine.journal: kind — список слов");
  if (session !== undefined && typeof session !== "string") throw refuse("bad_frame", "machine.journal: session — строка");
  if (part !== undefined && typeof part !== "string") throw refuse("bad_frame", "machine.journal: part — строка");
  return { since: new Date(since).toISOString(), limit: limit as number, kind: kind as string[] | undefined, session, part };
}

function parsed(text: string): Record_[] {
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as Record_] : [];
    } catch {
      // строка, которую ещё дописывают
      return [];
    }
  });
}

/** Папка журнала: дни по порядку, стоп, когда записей уже больше limit. Файлы только читаются. */
async function read(dir: string, q: ReturnType<typeof query>, signal: AbortSignal) {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => FILE.test(f));
  const dayOf = (f: string) => FILE.exec(f)![1];
  const wanted = (r: Record_) => r.t > q.since && (!q.kind || q.kind.includes(r.kind ?? "note")) && (!q.session || r.callsign === q.session) && (!q.part || r.part === q.part);
  const found: Record_[] = [];
  for (const day of [...new Set(files.map(dayOf))].sort()) {
    if (day < q.since.slice(0, 10)) continue;
    for (const f of files.filter((x) => dayOf(x) === day)) found.push(...parsed(await readFile(join(dir, f), { encoding: "utf8", signal })).filter(wanted));
    if (found.length > q.limit) break;
  }
  found.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return { records: found.slice(0, q.limit), more: found.length > q.limit };
}

export function make(): Module {
  let host: Host;
  /** сессии, чей процесс уже отметил system/init */
  const started = new Set<string>();

  return {
    start(h) {
      host = h;
    },
    session: () => ({ env: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } }),
    on: {
      event(s, msg) {
        const callsign = s.info.callsign;
        let lines = linesOf(msg);
        if (isInit(msg) && !started.has(callsign)) {
          started.add(callsign);
          lines = initLines(msg);
        }
        for (const line of lines) host.log({ callsign, ...line });
      },
      close(s) {
        started.delete(s.info.callsign);
      },
    },
    requests: {
      "machine.journal": (req, ctx) => read(join(host.dataDir, "journal"), query(req), ctx.signal),
    },
  };
}
