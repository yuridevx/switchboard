// Часы: время флота. Правило — «когда» и «что позвать»; правил много, а будильник у объекта записей один: он стоит на ближайшем сроке.
// Что делать по сроку, решает хозяин вида правила; часы только зовут. Пропущенное не догоняется: после простоя правило срабатывает один раз.
import { CALL_MS, errFields, Refusal, within } from "@sb/protocol";
import { Cron } from "croner";
import { log, outbound, type Env, type Module, type Outside } from "../../env.ts";
import { type Db, onAlarm, type Op, records } from "../../records.ts";

const NAME = "clock";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, at INTEGER NOT NULL, every INTEGER, cron TEXT, tz TEXT, kind TEXT NOT NULL, input TEXT)",
  "CREATE INDEX IF NOT EXISTS timers_at ON timers (at)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

/** Когда: один раз в срок, каждые столько миллисекунд или по строке расписания в часовом поясе. */
export type When = { at: number } | { every: number } | { cron: string; tz?: string };
/** Правило времени: имя, вид (кого позвать) и ввод хозяину вида. */
export type Timer = { id: string; kind: string; input?: unknown } & When;
type Stored = { id: string; at: number; every: number | null; cron: string | null; tz: string | null; kind: string; input: string | null };

/** Срок пришёл: работа хозяина вида. id — имя сработавшего правила, now — момент срабатывания. */
export type Fire = (env: Env, fleet: string, input: unknown, w: Outside & { id: string; now: number }) => Promise<void>;
const KINDS = new Map<string, Fire>();
/** Вид правила объявляет его хозяин при загрузке; у вида один хозяин. */
export function on(kind: string, run: Fire): void {
  if (KINDS.has(kind)) throw new Error(`часы: у вида ${kind} второй хозяин`);
  KINDS.set(kind, run);
}

/** Следующий срок после now: у разового — его срок, пока он впереди, иначе null. Считается от now, а не от прошлого срока. */
export function next(t: { at?: number; every?: number | null; cron?: string | null; tz?: string | null }, now: number): number | null {
  if (t.every) return now + t.every;
  if (t.cron) {
    let job: Cron;
    try {
      // без названного пояса — UTC, а не пояс машины, на которой идёт код
      job = new Cron(t.cron, { paused: true, timezone: t.tz ?? "UTC" });
    } catch (e) {
      throw new Refusal("bad_input", `расписание «${t.cron}»${t.tz ? ` (${t.tz})` : ""}: ${e instanceof Error ? e.message : e}`);
    }
    const run = job.nextRun(new Date(now));
    if (!run) throw new Refusal("bad_input", `расписание «${t.cron}»: следующего срока нет`);
    return run.getTime();
  }
  return t.at !== undefined && t.at > now ? t.at : null;
}

/** Будильник объекта — на ближайший срок; правил нет — снят. */
async function arm(d: Db): Promise<void> {
  const r = await d.first<{ at: number | null }>("SELECT min(at) AS at FROM timers");
  await d.alarm(r?.at ?? null);
}

/** Поставить правило или заменить одноимённое. */
export async function set(env: Env, fleet: string, t: Timer, now = Date.now()): Promise<void> {
  if ("every" in t && !(t.every > 0)) throw new Refusal("bad_input", `правило ${t.id}: срок «каждые» должен быть больше нуля`);
  const at = "at" in t ? t.at : next(t, now)!;
  const d = db(env, fleet);
  await d.run(
    "INSERT OR REPLACE INTO timers (id, at, every, cron, tz, kind, input) VALUES (?, ?, ?, ?, ?, ?, ?)",
    t.id, at, "every" in t ? t.every : null, "cron" in t ? t.cron : null, "cron" in t ? (t.tz ?? null) : null, t.kind, t.input === undefined ? null : JSON.stringify(t.input),
  );
  await arm(d);
}

/** Правила, которые этот экземпляр Worker'а уже завёл. */
const ensured = new Set<string>();
/** Завести правило, если такого ещё нет; существующее не трогается. */
export async function ensure(env: Env, fleet: string, t: Timer & { every: number }, now = Date.now()): Promise<void> {
  const key = `${fleet}/${t.id}`;
  if (ensured.has(key)) return;
  const d = db(env, fleet);
  await d.run("INSERT OR IGNORE INTO timers (id, at, every, kind, input) VALUES (?, ?, ?, ?, ?)", t.id, now + t.every, t.every, t.kind, t.input === undefined ? null : JSON.stringify(t.input));
  await arm(d);
  ensured.add(key);
}

/** Снять правила: одно по имени или все, чьё имя начинается с prefix. */
export async function drop(env: Env, fleet: string, o: { id: string } | { prefix: string }): Promise<void> {
  const d = db(env, fleet);
  if ("id" in o) {
    await d.run("DELETE FROM timers WHERE id = ?", o.id);
    ensured.delete(`${fleet}/${o.id}`);
  } else await d.run("DELETE FROM timers WHERE substr(id, 1, length(?1)) = ?1", o.prefix);
  await arm(d);
}

/** Сработать по всем правилам, чей срок пришёл. Следующий срок записан раньше вызова хозяина: его сбой — строка журнала, а не повтор.
 *  Ответ — сколько правил сработало. d — записи часов: у будильника объекта они свои, без обращения к себе по сети. */
export async function fire(env: Env, fleet: string, w: Outside, now = Date.now(), d: Db = db(env, fleet)): Promise<number> {
  const due = await d.all<Stored>("SELECT * FROM timers WHERE at <= ? ORDER BY at", now);
  if (due.length)
    await d.batch(
      due.map((t): Op => {
        const at = next({ every: t.every, cron: t.cron, tz: t.tz }, now);
        return at === null ? ["DELETE FROM timers WHERE id = ?", t.id] : ["UPDATE timers SET at = ? WHERE id = ?", at, t.id];
      }),
    );
  await Promise.all(
    due.map(async (t) => {
      const fields = { module: NAME, fleet, id: t.id, kind: t.kind, late: now - t.at };
      const run = KINDS.get(t.kind);
      if (!run) return w.log.error("часы: у вида правила нет хозяина в этой сборке", fields);
      try {
        await within(run(env, fleet, t.input ? JSON.parse(t.input) : undefined, { ...w, id: t.id, now }), CALL_MS, `правило ${t.id} не уложилось в предел`);
        w.log.info("часы: срок", fields);
      } catch (e) {
        w.log.error("часы: работа по сроку упала", { ...fields, ...errFields(e) });
      }
    }),
  );
  await arm(d);
  return due.length;
}

// срок будильника объекта: платформа и сеть — настоящие, запроса здесь нет
onAlarm(NAME, async (env, fleet, local) => void (await fire(env, fleet, { platform: env.PLATFORM, fetch: outbound, log: log.with({ module: NAME, fleet }) }, Date.now(), local(SCHEMA))));

/** Правило времени глазами соседа: имя, вид и ближайший срок. */
export type TimerRow = { id: string; kind: string; at: number; every?: number; cron?: string; tz?: string };
const row = (s: Stored): TimerRow => ({ id: s.id, kind: s.kind, at: s.at, ...(s.every ? { every: s.every } : {}), ...(s.cron ? { cron: s.cron } : {}), ...(s.tz ? { tz: s.tz } : {}) });

/** Правила, чьё имя начинается с prefix, ближайшие первыми. */
export async function list(env: Env, fleet: string, prefix = ""): Promise<TimerRow[]> {
  return (await db(env, fleet).all<Stored>("SELECT * FROM timers WHERE substr(id, 1, length(?1)) = ?1 ORDER BY at", prefix)).map(row);
}

/** Своих запросов у часов нет: правила ставят соседи, расписание проекта отдаёт его определение. */
export const clock: Module = { name: NAME, handlers: {} };
