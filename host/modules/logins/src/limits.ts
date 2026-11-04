// Лимиты аккаунта — чистые правила над его записью: кто у порога, когда снова годен, кто следующий в запасе.

/** Окно лимита: доля 0…1, час сброса и откуда значение (event — поток слота, poll — свой опрос). */
export type Window = { utilization: number; resetsAt: number; at: number; src: string };

/** Запись аккаунта в хранилище. */
export type Account = {
  login: "ok" | "none" | "pending";
  email?: string;
  plan?: string;
  checked?: number;
  limits: Record<string, Window>;
};
export type Accounts = Record<string, Account>;

/** Порог: 95 % за 5 ч, 98 % за неделю и прочие окна. */
export const limitOf = (window: string) => (window === "five_hour" ? 0.95 : 0.98);

const windowsOf = (a: Account | undefined) => Object.entries(a?.limits ?? {});
const atLimit = (a: Account | undefined, now: number) => windowsOf(a).filter(([name, w]) => w.utilization >= limitOf(name) && !(w.resetsAt && w.resetsAt <= now));

export const over = (a: Account | undefined, now: number) => atLimit(a, now).length > 0;

/** Когда аккаунт снова годится: самый поздний сброс его окон у порога. */
export const usableAt = (a: Account | undefined, now: number) => Math.max(0, ...atLimit(a, now).map(([, w]) => w.resetsAt || 0));

/** Самое свежее окно старше ageS секунд. */
export const stale = (a: Account | undefined, ageS: number, now: number) => now - Math.max(0, ...windowsOf(a).map(([, w]) => w.at)) > ageS;

/** Запись наружу: окно, чей сброс прошёл, — 0 %. */
export function shown(a: Account, now: number): Account {
  return { ...a, limits: Object.fromEntries(windowsOf(a).map(([name, w]) => [name, w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0 } : w])) };
}

/** Следующий по порядку: вошёл и ниже порога; skip — кого нельзя. */
export function nextUp(order: string[], all: Accounts, now: number, skip: string | null): string | null {
  return order.find((name) => name !== skip && all[name]?.login === "ok" && !over(all[name], now)) ?? null;
}
