// Worker ledger: журнал флота. Кадр приходит привязкой Participant (relay, points, releases) или POST с пропуском; записи — в таблице events.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { accepts, fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type LedgerEvent, type LedgerReadResult } from "../contract.ts";
import type { Env } from "./env.ts";

/** Отказ словом: строка журнала и reply, если у кадра есть id. */
class Refusal extends Error {
  word: string;
  constructor(word: string, why: string) {
    super(why);
    this.word = word;
  }
}
const bad = (why: string) => new Refusal("bad_frame", why);

/** Журнал — Workers Logs, строка JSON в общем формате журналов. Текста записи здесь нет. */
const log = (row: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "ledger", ...row }));

const PRESENCE = ["machine.left", "machine.back"];
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/** Сколько не было машины: секунды до минуты, минуты до часа, часы до двух суток, дальше дни. */
function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

/** Вход и уход машины пишет relay без текста: текст — по прежней записи присутствия этой машины. */
async function presence(db: D1Database, ev: string, machine: string, now: number): Promise<string> {
  const last = await db.prepare("SELECT ev, t FROM events WHERE machine = ? AND ev IN (?, ?) ORDER BY id DESC LIMIT 1").bind(machine, ...PRESENCE).first<{ ev: string; t: number }>();
  if (ev === "machine.back") return last?.ev === "machine.left" ? `${machine} вернулась · не было ${span(now - last.t)}` : `${machine} на связи`;
  return last?.ev === "machine.back" ? `${machine} пропала · была на связи с ${new Date(last.t).toISOString().slice(11, 16)} UTC` : `${machine} пропала`;
}

async function add(f: Frame, db: D1Database): Promise<void> {
  const ev = text(f.ev);
  if (!ev) throw bad("нет ev — имени записи");
  const machine = text(f.machine) ?? (typeof f.callsign === "string" ? machineOf(f.callsign) : null);
  const now = Date.now();
  let words = text(f.text);
  if (PRESENCE.includes(ev)) {
    if (f.from !== ".relay") throw bad(`${ev} пишет только relay`);
    if (!machine) throw bad(`${ev} без machine`);
    words = await presence(db, ev, machine, now);
  }
  if (!words) throw bad("нет text — что случилось словами");
  await db
    .prepare('INSERT INTO events (t, ev, "from", by, machine, callsign, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(now, ev, String(f.from), text(f.by), machine, text(f.callsign), words)
    .run();
}

async function read(f: Frame, db: D1Database): Promise<LedgerReadResult> {
  const { limit, before, after, machine } = f;
  if (!Number.isInteger(limit) || (limit as number) < 1) throw bad("limit — целое больше нуля");
  const where: string[] = [];
  const args: unknown[] = [];
  if (typeof machine === "string") where.push("machine = ?"), args.push(machine);
  // вперёд — ближайшие к курсору, отдаются тоже новыми сначала
  const forward = typeof after === "number";
  if (forward) where.push("id > ?"), args.push(after);
  else if (typeof before === "number") where.push("id < ?"), args.push(before);
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, (limit as number) + 1).all<Record<string, unknown>>();
  const page = results.slice(0, limit as number);
  if (forward) page.reverse();
  return { events: page.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as LedgerEvent), more: results.length > (limit as number) };
}

/** Кадр → ответные кадры. Отказ — словом; прочая ошибка летит дальше: вход отвечает сам. */
async function frame(f: Frame, db: D1Database): Promise<Frame[]> {
  const { id, from } = f;
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "ledger ответов не ждёт" });
    return [];
  }
  try {
    const off = accepts(f, CONTRACT);
    if (off) throw new Refusal(off.word, off.why);
    if (f.type === "ledger.add") {
      await add(f, db);
      return [];
    }
    if (!id) throw bad("ledger.read без id — ответить некому");
    return [{ ...ok(id, await read(f, db)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log({ kind: "refuse", ev: f.type, word: e.word, from, why: e.message, ...(f.type === "ledger.add" ? { rec: f.ev } : {}) });
    return id ? [{ ...fail(id, e.word), to: from }] : [];
  }
}

export class Participant extends WorkerEntrypoint<Env> {
  frame(f: Frame): Promise<Frame[]> {
    return frame(f, this.env.DB);
  }
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => frame(f, env.DB)),
} satisfies ExportedHandler<Env>;
