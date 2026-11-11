// Правила лимитов: чистые функции над записью аккаунта. Время — секунды, доли — 0..1.
// Неделя аккаунта делится на запас Fable (его потолок — доля недели) и остальное. У очереди два места на одном списке аккаунтов:
// место fable — сессии на Fable, место other — остальные модели. Место выбирает годный аккаунт с ближним сбросом недели.
import type { Lane } from "@sb/protocol";

/** Окно лимита. У недели: fable — сколько из неё потратил Fable; hold — сколько свободной недели держится для Fable. */
export type Window = { utilization: number; resetsAt: number; at: number; fable?: number; hold?: number };
/** Запись аккаунта; имя записи — почта. expires — конец входа по claude auth status; asked — когда лимиты спрашивали у Claude последний раз. */
export type Account = { login: "ok" | "none"; plan?: string; expires?: number; limits: Record<string, Window>; asked?: number };

export const FIVE = "five_hour", WEEK = "seven_day", FABLE = "fable";
/** Порог окна: дальше место уходит. У Fable — ниже ста: на 100 % Claude без вопроса берёт платные кредиты. */
const NEAR: Record<string, number> = { [FIVE]: 0.95, [WEEK]: 0.98, [FABLE]: 0.98 };
/** Потолок Fable в неделе, когда ответ Claude его не назвал: «до 50 % недели» — правило Claude. */
const CAP = 0.5;
/** Окно отказа Claude → наше окно. Отказ по другому окну аккаунт не закрывает. */
const REJECTED: Record<string, string> = { five_hour: FIVE, seven_day: WEEK, seven_day_overage_included: FABLE };
export const windowOf = (rateLimitType: string): string | undefined => REJECTED[rateLimitType];

type Usage = {
  rate_limits?: {
    five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
    seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
    model_scoped?: Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }> | null;
    weekly_scoped_shares?: Array<{ used_percent_of_weekly?: number | null; allowance_percent_of_weekly?: number | null }> | null;
  } | null;
};
const secOf = (iso?: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

/** Окна из ответа Claude об аккаунте: пять часов, неделя с долей Fable и запасом для него, лимит Fable. Окно без числа не пишется. */
export function read(u: unknown, at: number): Record<string, Window> {
  const r = (u as Usage | undefined)?.rate_limits ?? {};
  const out: Record<string, Window> = {};
  if (typeof r.five_hour?.utilization === "number") out[FIVE] = { utilization: r.five_hour.utilization / 100, resetsAt: secOf(r.five_hour.resets_at), at };
  if (typeof r.seven_day?.utilization !== "number") return out;
  const week = r.seven_day.utilization / 100, resetsAt = secOf(r.seven_day.resets_at);
  const share = r.weekly_scoped_shares?.[0];
  const cap = typeof share?.allowance_percent_of_weekly === "number" ? share.allowance_percent_of_weekly / 100 : CAP;
  const spent = typeof share?.used_percent_of_weekly === "number" ? share.used_percent_of_weekly / 100 : 0;
  const scoped = r.model_scoped?.find((m) => /fable/i.test(m.display_name ?? ""));
  out[WEEK] = { utilization: week, resetsAt, at, fable: spent, hold: Math.max(0, Math.min(cap - spent, 1 - week)) };
  out[FABLE] = { utilization: typeof scoped?.utilization === "number" ? scoped.utilization / 100 : cap > 0 ? Math.min(1, spent / cap) : 1, resetsAt: secOf(scoped?.resets_at) || resetsAt, at };
  return out;
}

/** Окно, чей сброс ещё не прошёл. */
const live = (a: Account, name: string, now: number) => {
  const w = a.limits[name];
  return w && (w.resetsAt === 0 || w.resetsAt > now) ? w : undefined;
};
const used = (a: Account, name: string, now: number) => live(a, name, now)?.utilization ?? 0;
/** Запас недели для Fable; неделя ещё не начата — вся его доля. */
const hold = (a: Account, now: number) => { const w = live(a, WEEK, now); return w ? (w.hold ?? 0) : CAP; };
const hot = (a: Account, name: string, now: number) => used(a, name, now) >= NEAR[name]!;

/** Аккаунт годен месту: вошёл, пять часов не у порога; Fable — пока не выбраны ни его лимит, ни неделя; остальным — пока есть неделя сверх запаса Fable. */
export function fits(a: Account | undefined, lane: Lane, now: number): boolean {
  if (a?.login !== "ok" || hot(a, FIVE, now)) return false;
  return lane === "fable" ? !hot(a, FABLE, now) && !hot(a, WEEK, now) : used(a, WEEK, now) + hold(a, now) < NEAR[WEEK]!;
}

/** Когда аккаунт снова годен месту: самый поздний сброс окон, которые его держат; 0 — годен или сброс неизвестен. */
export function usableAt(a: Account, lane: Lane, now: number): number {
  if (fits(a, lane, now)) return 0;
  const week = lane === "fable" ? hot(a, FABLE, now) || hot(a, WEEK, now) : used(a, WEEK, now) + hold(a, now) >= NEAR[WEEK]!;
  return Math.max(hot(a, FIVE, now) ? (live(a, FIVE, now)?.resetsAt ?? 0) : 0, week ? (live(a, WEEK, now)?.resetsAt ?? 0) : 0);
}

/** Час сброса недели; недели без расхода ещё нет — такой аккаунт идёт после начатых. */
const resetOf = (a: Account, now: number) => live(a, WEEK, now)?.resetsAt || Infinity;

export type Places = { fable?: string; other?: string; /** остальные модели идут из запаса Fable */ over: boolean };
/** Расстановка мест очереди. Место стоит, пока его аккаунт годен (was); иначе берёт годный с ближним сбросом недели, при равных — по порядку.
 *  Остальные без своей половины берут запас Fable — там же, у ближнего сброса. bar — пара, которой Claude только что отказал. */
export function place(order: string[], all: Record<string, Account>, was: Partial<Record<Lane, string | null>>, now: number, bar?: { lane: Lane; account: string }): Places {
  const fit = (lane: Lane, as: Lane = lane) => (n: string) => !(bar && bar.lane === lane && bar.account === n) && fits(all[n], as, now);
  const near = (ok: (n: string) => boolean) => order.filter(ok).reduce<string | undefined>((best, n) => (best === undefined || resetOf(all[n]!, now) < resetOf(all[best]!, now) ? n : best), undefined);
  const keep = (lane: Lane, ok: (n: string) => boolean) => { const n = was[lane]; return n && order.includes(n) && ok(n) ? n : undefined; };
  const fable = keep("fable", fit("fable")) ?? near(fit("fable"));
  const own = keep("other", fit("other")) ?? near(fit("other"));
  const other = own ?? near(fit("other", "fable"));
  return { ...(fable ? { fable } : {}), ...(other ? { other } : {}), over: !own && !!other };
}

/** Недели, чей сброс прошёл: по ним места выбирают заново. */
export const expired = (a: Account | undefined, now: number) => !!a?.limits[WEEK] && a.limits[WEEK]!.resetsAt > 0 && a.limits[WEEK]!.resetsAt <= now;
/** Ближайший будущий сброс окон аккаунта; 0 — нет. */
export const nextReset = (a: Account, now: number) => Math.min(...[FIVE, WEEK].map((n) => a.limits[n]?.resetsAt ?? 0).filter((t) => t > now), Infinity);

/** Лимиты спрашивали у Claude раньше, чем maxAge секунд назад, или не спрашивали. */
export const stale = (a: Account, maxAge: number, now: number) => (a.asked ?? 0) < now - maxAge;

/** Наружу: окно, чей сброс прошёл, — 0 %. */
export const shown = (a: Account, now: number): Account => ({
  ...a,
  limits: Object.fromEntries(Object.entries(a.limits).map(([n, w]) => [n, w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0, ...(n === WEEK ? { fable: 0, hold: CAP } : {}) } : w])),
});
