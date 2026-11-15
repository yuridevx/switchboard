// Аккаунты Claude на экране флота: аккаунт — ключ флота с протоколом claude; его числа — из ответов Claude каждой машине, столбец берёт самое свежее.
import { CLAUDE, type Account, type KeyRow } from "@sb/protocol";

export type LimitRow = Account["limits"][number];
/** Столбец аккаунта: один на флот, сколько бы машин о нём ни знало. */
export type Column = {
  name: string;
  /** токен принят на всех машинах, которые о нём ответили */
  ok: boolean;
  why?: string;
  /** беречь запас недели под Fable */
  keep: boolean;
  /** Claude ответил «аккаунт полон» хотя бы одной машине */
  full: boolean;
  /** до какого времени действует токен, мс */
  expires?: number;
  limits: LimitRow[];
};

/** Два числа аккаунта, те же, что на странице Claude: неделя целиком и окно Fable. */
export const WEEK = "seven_day", FABLE = "seven_day_overage_included";
export const meterOf = (limits: LimitRow[]) => ({ week: limits.find((l) => l.name === WEEK), fable: limits.find((l) => l.name === FABLE) });

export const WARN = 0.7, BAD = 0.9;
export const limitTone = (used: number): "teal" | "orange" | "red" => (used > BAD ? "red" : used > WARN ? "orange" : "teal");

/** Аккаунты Claude среди ключей флота. */
export const claudeKeys = (keys: KeyRow[]) => keys.filter((k) => k.protocol === CLAUDE);

/** Столбцы экрана аккаунтов: по ключу флота на аккаунт; окно — замер посвежее, при равных — большее использование. */
export function columns(keys: KeyRow[], byMachine: Record<string, Account[]>): Column[] {
  return claudeKeys(keys).map((k) => {
    const seen = Object.values(byMachine).flatMap((list) => list.filter((a) => a.name === k.name));
    const limits: LimitRow[] = [];
    for (const l of seen.flatMap((a) => a.limits)) {
      const was = limits.find((x) => x.name === l.name);
      if (!was) limits.push({ ...l });
      else if ((l.at ?? 0) > (was.at ?? 0) || ((l.at ?? 0) === (was.at ?? 0) && l.used > was.used)) Object.assign(was, l);
    }
    const bad = seen.find((a) => !a.ok);
    return { name: k.name, ok: !bad, ...(bad ? { why: bad.why ?? "Claude не принял токен" } : {}), keep: k.keep !== false, full: seen.some((a) => a.full), ...(k.expires !== undefined ? { expires: k.expires } : {}), limits };
  });
}

/** Столбцы стоят по времени сброса недели: слева — кто сбросится раньше; без замера и с негодным токеном — в конце. */
export function byReset(list: Column[]): Column[] {
  const at = (c: Column) => (c.ok ? (meterOf(c.limits).week?.resets ?? Number.MAX_SAFE_INTEGER - 1) : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name));
}
