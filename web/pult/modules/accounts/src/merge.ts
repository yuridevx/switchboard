// Аккаунт по всем машинам — чистые правила над ответами машин: самое свежее окно, расхождение данных, кого опросить.
import { type AccountInfo, type AccountsAnswer, day, hhmm, LIMIT_NAMES, type MachineAnswer, okOf } from "@switchboard/web-ui";

type Answers = Readonly<Record<string, MachineAnswer<AccountsAnswer>>>;
export type Win = { key: string; name: string; used: number; resets: number; at: number };
export type Diff = { machines: string[]; text: string };
export type Merged = { email: string; windows: Win[]; diff: Diff[] };

/** Окна старше двух минут — спросить у Claude. */
export const FRESH_S = 120;
/** Больше этого час сброса одного окна расходиться не может: разница в секунду бывает и в норме (замер 5 нояб.). */
const RESET_DRIFT_S = 60;
const FIRST = ["five_hour", "seven_day"];
/** Порядок окон: всегда один, в строке аккаунта и в столбцах. */
export const order = (a: string, b: string) => (FIRST.indexOf(a) + 1 || 99) - (FIRST.indexOf(b) + 1 || 99) || a.localeCompare(b);

/** «14:00» сегодня, иначе «10 нояб. 13:00». */
export function resetText(t: number): string {
  const ms = t * 1000;
  return new Date(ms).toDateString() === new Date().toDateString() ? hhmm(ms) : `${day(ms)} ${hhmm(ms)}`;
}

export const shortName = (email: string) => email.split("@")[0];

/** Записи почты: машина → запись. */
function entries(answers: Answers): Map<string, Array<[string, AccountInfo]>> {
  const out = new Map<string, Array<[string, AccountInfo]>>();
  for (const [machine, a] of Object.entries(answers)) {
    for (const [email, info] of Object.entries(okOf(a)?.accounts ?? {})) out.set(email, [...(out.get(email) ?? []), [machine, info]]);
  }
  return out;
}

/** Окно, чей сброс прошёл, уже ничего не говорит об аккаунте. */
const alive = (resets: number, now: number) => resets > now;

/** Что машина знает об аккаунте; сравнивается только то, что не зависит от часа опроса: тариф и час сброса. */
function differs(list: Array<[string, AccountInfo]>, now: number): Diff[] {
  const plans = new Set(list.map(([, i]) => i.plan).filter(Boolean));
  const keys = new Set(list.flatMap(([, i]) => Object.keys(i.limits ?? {})));
  const split = [...keys].some((k) => {
    const resets = list.map(([, i]) => i.limits?.[k]?.resetsAt ?? 0).filter((r) => alive(r, now));
    return resets.length > 1 && Math.max(...resets) - Math.min(...resets) > RESET_DRIFT_S;
  });
  if (plans.size < 2 && !split) return [];
  const groups = new Map<string, string[]>();
  for (const [machine, info] of list) {
    const text = [
      info.plan ?? "",
      ...Object.entries(info.limits ?? {})
        .filter(([, w]) => alive(w.resetsAt ?? 0, now))
        .sort(([a], [b]) => order(a, b))
        .map(([k, w]) => `${LIMIT_NAMES[k] ?? k} ${Math.round(w.utilization * 100)} %, сброс ${resetText(w.resetsAt ?? 0)}`),
    ]
      .filter(Boolean)
      .join(" · ");
    groups.set(text, [...(groups.get(text) ?? []), machine]);
  }
  return [...groups].map(([text, machines]) => ({ machines, text }));
}

/** Статус каждого аккаунта: окна — самые свежие среди машин; 0 % без действующего сброса не показывается. */
export function merged(answers: Answers, nowS: number): Merged[] {
  return [...entries(answers)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([email, list]) => {
      const best = new Map<string, { utilization: number; resetsAt?: number; at?: number }>();
      for (const [, info] of list) {
        for (const [k, w] of Object.entries(info.limits ?? {})) {
          const known = best.get(k);
          if (!known || (w.at ?? 0) > (known.at ?? 0)) best.set(k, w);
        }
      }
      const windows = [...best]
        .filter(([, w]) => w.utilization > 0 || alive(w.resetsAt ?? 0, nowS))
        .sort(([a], [b]) => order(a, b))
        .map(([key, w]) => ({ key, name: LIMIT_NAMES[key] ?? key, used: w.utilization, resets: alive(w.resetsAt ?? 0, nowS) ? (w.resetsAt ?? 0) : 0, at: w.at ?? 0 }));
      return { email, windows, diff: differs(list, nowS) };
    });
}

/** Кого опросить и где: у каждой устаревшей почты одна машина, где есть вход; машин как можно меньше. skip — уже просили. */
export function pollPlan(answers: Answers, nowS: number, skip: ReadonlySet<string>): Map<string, string[]> {
  const stale = [...entries(answers)].filter(([email, list]) => {
    if (skip.has(email) || !list.some(([, i]) => i.login === "ok")) return false;
    const latest = Math.max(0, ...list.flatMap(([, i]) => Object.values(i.limits ?? {}).map((w) => w.at ?? 0)));
    return latest < nowS - FRESH_S;
  });
  const reach = new Map<string, number>();
  for (const [, list] of stale) for (const [m, i] of list) if (i.login === "ok") reach.set(m, (reach.get(m) ?? 0) + 1);
  const plan = new Map<string, string[]>();
  for (const [email, list] of stale) {
    const m = list.filter(([, i]) => i.login === "ok").map(([x]) => x).sort((a, b) => (reach.get(b) ?? 0) - (reach.get(a) ?? 0) || a.localeCompare(b))[0];
    plan.set(m, [...(plan.get(m) ?? []), email]);
  }
  return plan;
}
