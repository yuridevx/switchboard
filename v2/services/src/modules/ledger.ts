// Журнал флота: выкладки, входы, сбои частей.
import { type LedgerEvent, newId, type Who } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "ledger";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER, what TEXT, who TEXT, machine TEXT, callsign TEXT, text TEXT, data TEXT, trace TEXT)",
  "CREATE INDEX IF NOT EXISTS events_at ON events (at)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Stored = { id: string; at: number; what: string; who: string; machine: string | null; callsign: string | null; text: string | null; data: string | null; trace: string | null };
export type Event = { what: string; who: string; machine?: string; callsign?: string; text?: string; data?: unknown; trace?: string };

/** Событие в журнал флота: зовут и соседние модули служб. */
export async function record(env: Env, fleet: string, e: Event): Promise<void> {
  await db(env, fleet).run(
    "INSERT INTO events (id, at, what, who, machine, callsign, text, data, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    newId("e"), Date.now(), e.what, e.who, e.machine ?? null, e.callsign ?? null, e.text ?? null, e.data === undefined ? null : JSON.stringify(e.data), e.trace ?? null,
  );
}

const event = (s: Stored): LedgerEvent => ({
  id: s.id, at: s.at, what: s.what, who: s.who,
  ...(s.machine ? { machine: s.machine } : {}), ...(s.callsign ? { callsign: s.callsign } : {}), ...(s.text ? { text: s.text } : {}),
  ...(s.data ? { data: JSON.parse(s.data) } : {}), ...(s.trace ? { trace: s.trace } : {}),
});

const visible = (who: Who) => (s: Stored) => who.admin || !s.machine || who.machines.includes(s.machine);

export const ledger: Module = {
  name: NAME,
  handlers: {
    async "ledger.add"(i: { what: string; machine?: string; callsign?: string; text?: string; data?: unknown }, ctx: Ctx) {
      await record(ctx.env, ctx.fleet, { ...i, who: ctx.who.addr, trace: ctx.trace });
      return {};
    },
    async "ledger.read"(i: { before?: number; limit?: number; what?: string; machine?: string }, ctx: Ctx) {
      const limit = Math.min(i.limit ?? 100, 500);
      const where = ["at < ?"];
      const params: (string | number)[] = [i.before ?? Number.MAX_SAFE_INTEGER];
      if (i.what) (where.push("substr(what, 1, length(?)) = ?"), params.push(i.what, i.what));
      if (i.machine) (where.push("machine = ?"), params.push(i.machine));
      const got = await db(ctx.env, ctx.fleet).all<Stored>(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, ...params, limit + 1);
      return { events: got.slice(0, limit).filter(visible(ctx.who)).map(event), more: got.length > limit };
    },
  },
};
