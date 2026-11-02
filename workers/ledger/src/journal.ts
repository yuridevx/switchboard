// Объект журнала флота: одна таблица events в SQLite. Записи не удаляются.
import { DurableObject } from "cloudflare:workers";
import { fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type LedgerEvent } from "../contract.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

const LEFT = "machine.left";
const BACK = "machine.back";

type Row = { id: number; t: number; ev: string; from: string; by: string | null; machine: string | null; callsign: string | null; text: string };

export class Journal extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      t        INTEGER NOT NULL,
      ev       TEXT NOT NULL,
      "from"   TEXT NOT NULL,
      by       TEXT,
      machine  TEXT,
      callsign TEXT,
      text     TEXT NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS events_m ON events(machine, id)");
    // фильтра по сессии у ledger.read нет — индекс по callsign не нужен
    sql.exec("DROP INDEX IF EXISTS events_c");
  }

  /** Кадр с to: ".ledger" или roster от relay → кадры, которые ledger шлёт в ответ. */
  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    const refuse = (word: string, why: string): Frame[] => {
      log({ kind: "refuse", ev: f.type, word, why, from, rec: typeof f.ev === "string" ? f.ev : undefined });
      return f.id ? [{ ...fail(f.id, word), to: from }] : [];
    };

    if (f.type === "roster") {
      // roster ledger получает от relay по своей привязке; от участника рации — чужой кадр
      if (f.from !== undefined && f.from !== "relay") return refuse("bad_frame", "roster шлёт только relay");
      this.roster(f);
      return [];
    }
    if (f.type === "reply") {
      log({ kind: "note", ev: "reply", from, why: "ledger ответов не ждёт" });
      return [];
    }
    if (f.type !== "ledger.add" && f.type !== "ledger.read") return refuse("unknown_request", `ledger не обслуживает ${f.type}`);
    const v = CONTRACT[f.type];
    if (f.v !== undefined && f.v !== v) return refuse("contract_mismatch", `${f.type} v${f.v} — у ledger v${v}`);

    if (f.type === "ledger.add") {
      if (typeof f.ev !== "string" || !f.ev) return refuse("bad_frame", "в ledger.add нет ev");
      if (typeof f.text !== "string" || !f.text) return refuse("bad_frame", "в ledger.add нет text");
      if (f.ev === LEFT || f.ev === BACK) return refuse("bad_frame", `${f.ev} пишет только ledger — по roster`);
      const str = (x: unknown) => (typeof x === "string" && x ? x : null);
      const callsign = str(f.callsign);
      // у записи сессии machine — её машина
      const machine = str(f.machine) ?? (callsign ? machineOf(callsign) : null);
      this.add(f.ev, from, f.text, { by: str(f.by), machine, callsign });
      return [];
    }

    // ledger.read
    if (!f.id) return refuse("bad_frame", "ledger.read без id — ответить некому");
    const limit = f.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return refuse("bad_frame", "в ledger.read нет limit");
    const where: string[] = [];
    const args: unknown[] = [];
    if (typeof f.machine === "string") {
      where.push("machine = ?");
      args.push(f.machine);
    }
    if (typeof f.q === "string" && f.q) {
      where.push("instr(text, ?) > 0");
      args.push(f.q);
    }
    const after = typeof f.after === "number";
    if (after) {
      where.push("id > ?");
      args.push(f.after);
    } else if (typeof f.before === "number") {
      where.push("id < ?");
      args.push(f.before);
    }
    // after — ближайшие более новые; иначе — ближайшие более старые; в ответе всегда новые сначала
    const q = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${after ? "ASC" : "DESC"} LIMIT ?`;
    const rows = this.ctx.storage.sql.exec<Row>(q, ...args, limit + 1).toArray();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (after) page.reverse();
    return [{ ...ok(f.id, { events: page.map(event), more }), to: from }];
  }

  /**
   * roster: машины в нём сравниваются с последними machine.left и machine.back.
   * Пропала — machine.left; появилась или вернулась — machine.back. Копии roster нет.
   */
  private roster(f: Frame): void {
    const list = Array.isArray(f.machines) ? (f.machines as Array<{ machine?: unknown }>) : [];
    const now = Date.now();
    const present = list.map((m) => m.machine).filter((m): m is string => typeof m === "string" && !!m);
    const last = new Map<string, { ev: string; t: number }>();
    const rows = this.ctx.storage.sql.exec<{ machine: string; ev: string; t: number }>(
      `SELECT e.machine, e.ev, e.t FROM events e JOIN
         (SELECT MAX(id) AS id FROM events WHERE ev IN (?, ?) GROUP BY machine) m ON e.id = m.id`,
      LEFT,
      BACK,
    );
    for (const r of rows) last.set(r.machine, { ev: r.ev, t: r.t });
    for (const [m, r] of last) {
      if (r.ev === BACK && !present.includes(m)) this.add(LEFT, "ledger", `${m} пропала · была на связи с ${hhmm(r.t)}`, { machine: m });
    }
    for (const m of new Set(present)) {
      const r = last.get(m);
      if (r?.ev === BACK) continue;
      this.add(BACK, "ledger", r ? `${m} вернулась · не было ${span(now - r.t)}` : `${m} на связи`, { machine: m });
    }
  }

  private add(ev: string, from: string, text: string, o: { by?: string | null; machine?: string | null; callsign?: string | null }): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO events (t, ev, "from", by, machine, callsign, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      ev,
      from,
      o.by ?? null,
      o.machine ?? null,
      o.callsign ?? null,
      text,
    );
  }
}

function event(r: Row): LedgerEvent {
  const e: LedgerEvent = { id: r.id, t: r.t, ev: r.ev, from: r.from, text: r.text };
  if (r.by !== null) e.by = r.by;
  if (r.machine !== null) e.machine = r.machine;
  if (r.callsign !== null) e.callsign = r.callsign;
  return e;
}

/** Время UTC «14:00». */
export function hhmm(t: number): string {
  return new Date(t).toISOString().slice(11, 16);
}

/** Длительность словами: «3 с», «42 мин», «2 ч 5 мин», «3 дн». */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}
