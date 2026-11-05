// Журнал флота над таблицей events: запись и чтение страницами. Текст входа и ухода машины пишет сам журнал по её прошлой записи.
import { accepts, fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type LedgerEvent, type LedgerReadResult } from "../contract.ts";

const PRESENCE = ["machine.left", "machine.back"];

type Refusal = { word: string; why: string };
const bad = (why: string): Refusal => ({ word: "bad_frame", why });
const text = (x: unknown) => (typeof x === "string" && x ? x : null);

/** Сколько не было машины: «3 с», «42 мин», «2 ч 5 мин», «3 дн». */
function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)} дн`;
  return min % 60 ? `${hours} ч ${min % 60} мин` : `${hours} ч`;
}

async function presence(db: D1Database, ev: string, machine: string, now: number): Promise<string> {
  const last = await db.prepare(`SELECT ev, t FROM events WHERE machine = ? AND ev IN ('machine.left', 'machine.back') ORDER BY id DESC LIMIT 1`).bind(machine).first<{ ev: string; t: number }>();
  if (ev === "machine.left") return last?.ev === "machine.back" ? `${machine} пропала · была на связи с ${new Date(last.t).toISOString().slice(11, 16)} UTC` : `${machine} пропала`;
  return last?.ev === "machine.left" ? `${machine} вернулась · не было ${span(now - last.t)}` : `${machine} на связи`;
}

async function add(db: D1Database, f: Frame): Promise<Refusal | undefined> {
  const ev = text(f.ev);
  if (!ev) return bad("в ledger.add нет ev");
  const now = Date.now();
  const callsign = text(f.callsign);
  const machine = text(f.machine) ?? (callsign ? machineOf(callsign) : null);
  let words = text(f.text);
  if (PRESENCE.includes(ev)) {
    if (f.from !== ".relay") return bad(`${ev} пишет только relay`);
    if (!machine) return bad(`${ev}: нет machine`);
    words = await presence(db, ev, machine, now);
  }
  if (!words) return bad("в ledger.add нет text");
  await db.prepare(`INSERT INTO events (t, ev, "from", by, machine, callsign, text) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(now, ev, f.from ?? "", text(f.by), machine, callsign, words).run();
}

async function read(db: D1Database, f: Frame): Promise<LedgerReadResult | Refusal> {
  const { limit, before, after } = f;
  if (!Number.isInteger(limit) || (limit as number) < 1) return bad("в ledger.read нет limit");
  const forward = typeof after === "number";
  const cursor = forward ? after : before;
  const where = [...(typeof cursor === "number" ? [forward ? "id > ?" : "id < ?"] : []), ...(text(f.machine) ? ["machine = ?"] : [])];
  const args = [...(typeof cursor === "number" ? [cursor] : []), ...(text(f.machine) ? [f.machine] : [])];
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, (limit as number) + 1).all<Record<string, unknown>>();
  // вперёд берём ближайшие к курсору, отдаём всё равно новые сначала
  const page = results.slice(0, limit as number);
  if (forward) page.reverse();
  return { events: page.map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) as LedgerEvent), more: results.length > (limit as number) };
}

const line = (kind: string, f: Frame, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "ledger", kind, ev: f.type, from: f.from ?? "", ...fields }));

/** Кадр к .ledger → ответ отправителю. Отказ — словом, строкой журнала и без записи. */
export async function frame(db: D1Database, f: Frame): Promise<Frame[]> {
  if (f.type === "reply") {
    line("note", f, { why: "ledger ответов не ждёт" });
    return [];
  }
  const answer = (r: Refusal | { result?: unknown }): Frame[] => {
    if ("word" in r) line("refuse", f, { word: r.word, why: r.why, ...(f.type === "ledger.add" && typeof f.ev === "string" ? { rec: f.ev } : {}) });
    if (!f.id) return [];
    return [{ ...("word" in r ? fail(f.id, r.word) : ok(f.id, r.result)), to: f.from ?? "" }];
  };
  const refused = accepts(f, CONTRACT);
  if (refused) return answer(refused);
  if (f.type === "ledger.add") return answer((await add(db, f)) ?? {});
  if (!f.id) return answer(bad("ledger.read без id — ответить некому"));
  const r = await read(db, f);
  return answer("word" in r ? r : { result: r });
}
