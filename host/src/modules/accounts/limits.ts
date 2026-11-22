// Правила выбора аккаунта Claude: чистые функции над записью аккаунта. Время — мс, доли — 0..1.
// Числа окон — только из заголовков ответа Claude. Порога ниже ста нет: аккаунт работает до отказа, отказ сессии не достаётся.
// Неделя аккаунта с флагом «беречь Fable» делится на запас Fable и остальное; без флага неделя целиком — любым моделям.
// Рычаг аккаунта ставит человек: выключенный не выбирается и сброса его никто не ждёт; «первым» — первый круг того же выбора по тому же счёту.
import type { Use } from "@sb/protocol";

/** Окно лимита: used — доля; resets — час сброса, мс (0 — неизвестен); at — когда пришло. */
export type Window = { used: number; resets: number; at: number };
/** Запись аккаунта; имя записи — почта. tail — хвост значения ключа: сменился — токен новый. use — рычаг аккаунта из списка ключей: не назван — по счёту. */
export type Account = { ok: boolean; why?: string; keep: boolean; use?: Use; tail?: string; limits: Record<string, Window> };

export const FIVE = "five_hour", WEEK = "seven_day", FABLE = "seven_day_overage_included";
/** Имя окна в заголовках Claude → имя окна. */
const HEADER: Record<string, string> = { "5h": FIVE, "7d": WEEK, "7d_oi": FABLE };
const UNIFIED = "anthropic-ratelimit-unified";
/** Потолок Fable в неделе: окно Fable — половина недели (заголовок fallback-percentage Claude). */
export const CAP = 0.5;
/** Неделя ещё не начата: до её сброса — полные 168 часов. */
const WEEK_HOURS = 168;
const HOUR_MS = 3_600_000;
const EPS = 1e-9;

type Headers = Record<string, string | string[] | undefined>;
const one = (h: Headers, name: string): string | undefined => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };

/** Сессия с такой моделью тратит окно Fable. */
export const isFable = (model?: string | null): boolean => /fable/i.test(model ?? "");

/** Окна из заголовков ответа Claude: что названо числом. У ответа без заголовков лимитов (count_tokens) окон нет. */
export function read(h: Headers, at: number): Record<string, Window> {
  const out: Record<string, Window> = {};
  for (const [short, name] of Object.entries(HEADER)) {
    const used = Number(one(h, `${UNIFIED}-${short}-utilization`));
    if (!Number.isFinite(used)) continue;
    out[name] = { used, resets: (Number(one(h, `${UNIFIED}-${short}-reset`)) || 0) * 1000, at };
  }
  return out;
}

/** Отказ 429: какое окно Claude закрыл и до какого часа. Окно не названо — отказ не по окну (аккаунт полон или короткая пауза). */
export function closed(h: Headers): { name: string; resets: number } | undefined {
  const claim = one(h, `${UNIFIED}-representative-claim`);
  const short = Object.keys(HEADER).find((k) => HEADER[k] === claim) ?? Object.keys(HEADER).find((k) => one(h, `${UNIFIED}-${k}-status`) === "rejected");
  if (!short) return undefined;
  return { name: HEADER[short]!, resets: (Number(one(h, `${UNIFIED}-${short}-reset`) ?? one(h, `${UNIFIED}-reset`)) || 0) * 1000 };
}

/** Заголовки отказа для журнала: лимиты и срок повтора. */
export const refusalHeaders = (h: Headers): Record<string, string> =>
  Object.fromEntries(Object.keys(h).filter((k) => k.startsWith("anthropic-ratelimit") || k === "retry-after").map((k) => [k, one(h, k) ?? ""]));

/** Окно, чей сброс ещё не прошёл. */
const live = (a: Account, name: string, now: number) => {
  const w = a.limits[name];
  return w && (w.resets === 0 || w.resets > now) ? w : undefined;
};
const used = (a: Account, name: string, now: number) => live(a, name, now)?.used ?? 0;

/** Запас недели под Fable: что ему осталось в его окне, но не больше свободной недели. Без флага запаса нет. */
export const hold = (a: Account, now: number): number => (a.keep ? Math.max(0, Math.min(CAP * (1 - used(a, FABLE, now)), 1 - used(a, WEEK, now))) : 0);

/** Остаток аккаунта для сессии: доля недели, которую она может потратить. spare — другая модель берёт и запас Fable. */
export function remainder(a: Account, fable: boolean, now: number, spare = false): number {
  const week = 1 - used(a, WEEK, now);
  if (fable) return Math.min(week, CAP * (1 - used(a, FABLE, now)));
  return spare ? week : week - hold(a, now);
}

/** Аккаунт выключен человеком: флот им не пользуется. */
export const isOff = (a: Account | undefined): boolean => a?.use === "off";

/** Годен: не выключен, токен принят, окна не выбраны, остаток есть. Сессии Fable нужно открытое окно Fable; другой модели — неделя сверх запаса. */
export function fits(a: Account | undefined, fable: boolean, now: number, spare = false): boolean {
  if (!a?.ok || isOff(a) || used(a, FIVE, now) >= 1 || used(a, WEEK, now) >= 1) return false;
  return remainder(a, fable, now, spare) > EPS;
}

/** Когда аккаунт снова годен: самый поздний сброс окон, которые его держат; 0 — годен, выключен, токен не принят или сброс неизвестен. */
export function usableAt(a: Account, fable: boolean, now: number): number {
  if (!a.ok || isOff(a) || fits(a, fable, now, true)) return 0;
  const at = (name: string) => live(a, name, now)?.resets ?? 0;
  return Math.max(used(a, FIVE, now) >= 1 ? at(FIVE) : 0, used(a, WEEK, now) >= 1 ? at(WEEK) : 0, fable && used(a, FABLE, now) >= 1 ? at(FABLE) : 0);
}

/** Часы до сброса недели; неделя не начата или машина ещё не видела ответа аккаунта — 168. */
const hoursLeft = (a: Account, now: number): number => {
  const w = live(a, WEEK, now);
  return w && w.resets ? Math.max(1, (w.resets - now) / HOUR_MS) : WEEK_HOURS;
};

/** Кандидат: остаток, часы до сброса, тёплые сессии аккаунта на машине и счёт; first — стоит «первым». */
export type Candidate = { account: string; rem: number; hours: number; warm: number; score: number; first?: true };
/** Решение: лучший аккаунт; spare — другая модель идёт из запаса Fable; first — выбран из «первым», счёт остальных не сравнивался;
 *  wait — годных нет: когда ближайший станет годным, мс. */
export type Choice = { account?: string; spare?: boolean; first?: boolean; candidates: Candidate[]; wait?: number };

/** Выбор аккаунта новой или остывшей сессии. Годен → остаток → счёт = остаток ÷ часы до сброса ÷ (1 + тёплые сессии) → лучший; при равном счёте — у кого меньше тёплых.
 *  Счёт — сколько недели в час надо тратить, чтобы она не сгорела; занятый аккаунт уступает свободному. Для другой модели второй круг берёт запас Fable.
 *  Среди годных есть «первым» — лучший выбирается только из них: так человек тратит аккаунт раньше остальных. */
export function choose(all: Record<string, Account>, fable: boolean, warm: Record<string, number>, now: number, skip: (name: string) => boolean = () => false): Choice {
  const round = (spare: boolean): Candidate[] =>
    Object.keys(all).sort().filter((n) => !skip(n) && fits(all[n], fable, now, spare)).map((n) => {
      const rem = remainder(all[n]!, fable, now, spare), hours = hoursLeft(all[n]!, now), w = warm[n] ?? 0;
      return { account: n, rem, hours, warm: w, score: rem / hours / (1 + w), ...(all[n]!.use === "first" ? { first: true as const } : {}) };
    });
  let candidates = round(false);
  const spare = !candidates.length && !fable && (candidates = round(true)).length > 0;
  const firsts = candidates.filter((c) => c.first);
  const best = (firsts.length ? firsts : candidates).reduce<Candidate | undefined>((b, c) => (!b || c.score > b.score + EPS || (Math.abs(c.score - b.score) <= EPS && c.warm < b.warm) ? c : b), undefined);
  if (best) return { account: best.account, ...(spare ? { spare } : {}), ...(best.first ? { first: true } : {}), candidates };
  // час сброса — по всем аккаунтам: пропущенный в этом вызове откроется тем же сбросом
  const times = Object.keys(all).map((n) => usableAt(all[n]!, fable, now)).filter((t) => t > now);
  return { candidates, ...(times.length ? { wait: Math.min(...times) } : {}) };
}

/** Ближайший будущий сброс закрытого окна; Infinity — закрытых нет или аккаунт выключен: его сброса никто не ждёт. */
export const nextReset = (a: Account, now: number): number => (isOff(a) ? Infinity : Math.min(...Object.values(a.limits).filter((w) => w.used >= 1 && w.resets > now).map((w) => w.resets), Infinity));

/** Окна наружу: живые; у недели — сколько из неё потратил Fable и сколько держится под него. */
export function shown(a: Account, now: number): Array<{ name: string; used: number; resets?: number; at: number; fable?: number; hold?: number }> {
  return Object.keys(a.limits).filter((n) => live(a, n, now)).map((n) => {
    const w = a.limits[n]!;
    return { name: n, used: w.used, ...(w.resets ? { resets: w.resets } : {}), at: w.at, ...(n === WEEK ? { fable: CAP * used(a, FABLE, now), hold: hold(a, now) } : {}) };
  });
}
