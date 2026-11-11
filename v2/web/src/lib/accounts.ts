// Аккаунты: один аккаунт на нескольких машинах — одна строка; лимиты, пороги, ожидание сброса.
import { laneOf, type Account, type Slot } from "@sb/protocol";
import { hhmm } from "./time.ts";

export type Seat = { machine: string; account: Account };
export type LimitRow = { name: string; used: number; resets?: number; /** время замера: своё у окна, иначе общее у аккаунта */ at?: number; /** у недели: доля Fable в ней и запас, который держится для Fable */ fable?: number; hold?: number };
export type Merged = {
  id: string; kind: Account["kind"]; email?: string; plan?: string;
  /** где этот аккаунт вошёл */
  seats: Seat[];
  /** лимиты: по каждому окну — самое свежее из известного (большее использование) */
  limits: LimitRow[];
  /** на всех машинах вход годен */
  ok: boolean;
  /** сколько сессий идёт на нём по всем машинам */
  sessions: number;
};

/** Два числа аккаунта, те же, что на странице Claude: неделя целиком и лимит Fable. */
export const WEEK = "seven_day", FABLE = "fable";
export const meterOf = (limits: LimitRow[]) => ({ week: limits.find((l) => l.name === WEEK), fable: limits.find((l) => l.name === FABLE) });


export const WARN = 0.7, BAD = 0.9;
export const limitTone = (used: number): "teal" | "orange" | "red" => (used > BAD ? "red" : used > WARN ? "orange" : "teal");

/** Свести аккаунты машин по почте (у ключа — по имени). */
export function mergeAccounts(byMachine: Record<string, Account[]>): Merged[] {
  const out = new Map<string, Merged>();
  for (const [machine, list] of Object.entries(byMachine)) {
    for (const a of list) {
      const key = accountKey(a);
      const m = out.get(key) ?? { id: a.id, kind: a.kind, email: a.email, plan: a.plan, seats: [], limits: [], ok: true, sessions: 0 };
      m.seats.push({ machine, account: a });
      m.plan ??= a.plan;
      m.ok &&= a.ok;
      m.sessions += a.sessions ?? 0;
      for (const raw of a.limits ?? []) {
        // время замера — у окна, а если Host назвал его только у аккаунта, берётся оно
        const at = raw.at ?? a.at;
        const l = { ...raw, ...(at !== undefined ? { at } : {}) };
        const was = m.limits.find((x) => x.name === l.name);
        if (!was) m.limits.push(l);
        else if (l.used > was.used) Object.assign(was, l);
      }
      out.set(key, m);
    }
  }
  return [...out.values()].sort((a, b) => Number(a.kind === "key") - Number(b.kind === "key") || Number(a.ok) - Number(b.ok) || (a.email ?? a.id).localeCompare(b.email ?? b.id));
}

/** План опроса лимитов: одна машина на почту, чей замер старше двух минут (или без времени замера); машин — как можно меньше. */
export const POLL_STALE_MS = 120_000;
export function pollPlan(byMachine: Record<string, Array<{ kind: string; email?: string; id: string; at?: number; limits?: Array<{ at?: number }> }>>, now = Date.now()): string[] {
  const stale = new Map<string, string[]>();
  for (const [machine, list] of Object.entries(byMachine)) {
    for (const a of list) {
      if (a.kind !== "claude") continue;
      const at = Math.max(a.at ?? 0, ...(a.limits ?? []).map((l) => l.at ?? 0));
      if (now - at <= POLL_STALE_MS) continue;
      const key = a.email ?? a.id;
      stale.set(key, [...(stale.get(key) ?? []), machine]);
    }
  }
  // жадно: машина, которая закрывает больше всего оставшихся почт
  const plan: string[] = [];
  const left = new Map(stale);
  while (left.size) {
    const score = new Map<string, number>();
    for (const ms of left.values()) for (const m of ms) score.set(m, (score.get(m) ?? 0) + 1);
    const best = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    plan.push(best);
    for (const [key, ms] of [...left]) if (ms.includes(best)) left.delete(key);
  }
  return plan;
}

/** Машины говорят об аккаунте разное: тариф или час сброса окна расходятся больше чем на минуту. Ответ — что говорит каждая. */
export function diverge(m: Merged): string[] {
  if (m.seats.length < 2) return [];
  const plans = new Set(m.seats.map((s) => s.account.plan ?? ""));
  const names = new Set(m.seats.flatMap((s) => (s.account.limits ?? []).map((l) => l.name)));
  const drift = [...names].some((n) => {
    const at = m.seats.map((s) => s.account.limits?.find((l) => l.name === n)?.resets).filter((x): x is number => x !== undefined);
    return at.length > 1 && Math.max(...at) - Math.min(...at) > 60_000;
  });
  if (plans.size < 2 && !drift) return [];
  return m.seats.map((s) => `${s.machine}: ${s.account.plan ?? "тариф неизвестен"}${(s.account.limits ?? []).map((l) => (l.resets ? `, сброс ${hhmm(l.resets)}` : "")).join("")}`);
}

/** Ключ аккаунта для подсветки и выбора: вид и почта (у ключа — имя). */
export const accountKey = (a: Pick<Account, "kind" | "email" | "id">) => a.kind + ":" + (a.email ?? a.id);

/** Убрать выбранные аккаунты из всех очередей всех машин. Ответ — новые порядки только там, где они изменились. */
export function dropFromQueues(slots: Record<string, Slot[]>, mails: string[]): Array<{ machine: string; slot: string; order: string[] }> {
  return Object.entries(slots).flatMap(([machine, list]) => list.filter((q) => q.order.some((m) => mails.includes(m))).map((q) => ({ machine, slot: q.name, order: q.order.filter((m) => !mails.includes(m)) })));
}

/** Порядок машин на экране аккаунтов: сначала те, где есть негодный вход, потом по имени. */
export const machineOrder = (byMachine: Record<string, Account[]>) =>
  Object.keys(byMachine).sort((a, b) => Number(byMachine[b]!.some((x) => !x.ok)) - Number(byMachine[a]!.some((x) => !x.ok)) || a.localeCompare(b));

/** Перенос аккаунта: из очереди from (null — из списка входов) в очередь to (null — убрать из from) перед before (null — в конец).
 *  В той же очереди — смена порядка; из входов — аккаунт добавляется; между очередями — уходит из одной и встаёт в другую. Ответ — изменённые порядки. */
export function queueMove(slots: Slot[], from: string | null, to: string | null, mail: string, before: string | null): Array<{ slot: string; order: string[] }> {
  const out: Array<{ slot: string; order: string[] }> = [];
  const of = (name: string) => slots.find((q) => q.name === name)?.order ?? [];
  if (from && from !== to) out.push({ slot: from, order: of(from).filter((m) => m !== mail) });
  if (to) {
    const rest = of(to).filter((m) => m !== mail);
    const at = before && before !== mail ? rest.indexOf(before) : -1;
    const order = at < 0 ? [...rest, mail] : [...rest.slice(0, at), mail, ...rest.slice(at)];
    if (order.join() !== of(to).join()) out.push({ slot: to, order });
  }
  return out;
}

/** На чём пойдёт сессия с такой моделью: очереди машины с тем, кто стоит на её месте сейчас, затем ключи флота. Пустая очередь и негодный ключ не выбираются. */
export function seatOptions(data?: { accounts: Account[]; slots: Slot[] }, model?: string | null): Array<{ value: string; label: string; disabled?: boolean }> {
  const lane = laneOf(model);
  return [
    ...(data?.slots ?? []).map((q) => ({ value: q.name, label: `${q.name} · ${q.lanes[lane].account ?? "пусто"}${q.lanes[lane].wait ? ` · ждёт до ${hhmm(q.lanes[lane].wait!)}` : ""}`, ...(q.lanes[lane].account ? {} : { disabled: true }) })),
    ...(data?.accounts ?? []).filter((a) => a.kind === "key").map((a) => ({ value: a.id, label: `ключ ${a.id}${a.model ? ` · ${a.model}` : ""}`, ...(a.ok ? {} : { disabled: true }) })),
  ];
}

/** Вход закончился не той почтой, которую ждали. */
export const otherMail = (expected: string | undefined, got: Account): boolean => !!expected && !!got.email && got.email.toLowerCase() !== expected.toLowerCase();
