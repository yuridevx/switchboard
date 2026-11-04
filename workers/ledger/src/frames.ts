// Кадры ledger: ledger.add пишет, ledger.read читает; неверный вход — слово и строка журнала. Записей журнал не удаляет.
import { accepts, fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import { append, lastPresence, page } from "./events.ts";
import { isPresence, presenceText } from "./presence.ts";

/** Сбои самого ledger — Workers Logs одной строкой JSON. Текста записей в строке нет. */
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "ledger", ...line }));

const text = (x: unknown) => (typeof x === "string" && x ? x : null);

/** Кадр с to: ".ledger" → кадры в ответ вызывающему. */
export async function answer(db: D1Database, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const no = (word: string, why: string): Frame[] => {
    log({ kind: "refuse", ev: f.type, word, why, from, rec: typeof f.ev === "string" ? f.ev : undefined });
    return f.id ? [{ ...fail(f.id, word), to: from }] : [];
  };

  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "ledger ответов не ждёт" });
    return [];
  }
  if (f.type !== "ledger.add" && f.type !== "ledger.read") return no("unknown_request", `ledger не обслуживает ${f.type}`);
  const version = accepts(f, CONTRACT);
  if (version) return no(version.word, version.why);
  return f.type === "ledger.add" ? add(db, f, from, no) : read(db, f, from, no);
}

async function add(db: D1Database, f: Frame, from: string, no: (word: string, why: string) => Frame[]): Promise<Frame[]> {
  const ev = text(f.ev);
  if (!ev) return no("bad_frame", "в ledger.add нет ev");

  if (isPresence(ev)) {
    if (from !== ".relay") return no("bad_frame", `${ev} пишет только relay`);
    const machine = text(f.machine);
    if (!machine) return no("bad_frame", `в ${ev} нет machine`);
    const words = presenceText(ev, machine, await lastPresence(db, machine), Date.now());
    await append(db, { ev, from, text: words, machine });
    return [];
  }

  const words = text(f.text);
  if (!words) return no("bad_frame", "в ledger.add нет text");
  const callsign = text(f.callsign);
  await append(db, { ev, from, text: words, by: text(f.by), callsign, machine: text(f.machine) ?? (callsign && machineOf(callsign)) });
  return [];
}

async function read(db: D1Database, f: Frame, from: string, no: (word: string, why: string) => Frame[]): Promise<Frame[]> {
  if (!f.id) return no("bad_frame", "ledger.read без id — ответить некому");
  const limit = f.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return no("bad_frame", "в ledger.read нет limit");
  const number = (x: unknown) => (typeof x === "number" ? x : undefined);
  const result = await page(db, { limit, after: number(f.after), before: number(f.before), machine: typeof f.machine === "string" ? f.machine : undefined });
  return [{ ...ok(f.id, result), to: from }];
}
