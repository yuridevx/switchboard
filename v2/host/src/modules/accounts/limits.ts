// Правила лимитов: чистые функции над записью аккаунта. Время — секунды.

export type Window = { utilization: number; resetsAt: number; at: number };
/** Запись аккаунта; имя записи — почта. expires — конец входа по claude auth status, секунды. */
export type Account = { login: "ok" | "none"; plan?: string; expires?: number; limits: Record<string, Window> };

/** Порог окна: дальше подмена. Окно без своего порога — только полный расход. */
const THRESHOLD: Record<string, number> = { five_hour: 0.95, seven_day: 0.98 };

const atLimit = ([name, w]: [string, Window], now: number) => w.utilization >= (THRESHOLD[name] ?? 1) && (w.resetsAt === 0 || w.resetsAt > now);

export const over = (a: Account, now: number) => Object.entries(a.limits).some((e) => atLimit(e, now));

/** Когда аккаунт снова годен: самый поздний сброс окон у порога; 0 — годен или сброс неизвестен. */
export const usableAt = (a: Account, now: number) => Math.max(0, ...Object.entries(a.limits).filter((e) => atLimit(e, now)).map(([, w]) => w.resetsAt));

/** Окна старше maxAge секунд; окон нет — тоже устарело. */
export const stale = (a: Account, maxAge: number, now: number) => Math.max(0, ...Object.values(a.limits).map((w) => w.at)) < now - maxAge || !Object.keys(a.limits).length;

/** Наружу: окно, чей сброс прошёл, — 0 %. */
export const shown = (a: Account, now: number): Account => ({
  ...a,
  limits: Object.fromEntries(Object.entries(a.limits).map(([n, w]) => [n, w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0 } : w])),
});

export const usable = (a: Account | undefined, now: number) => a?.login === "ok" && !over(a, now);

/** Следующий в запасе: по порядку, вошёл, ниже порога, не исключённый. */
export const nextUp = (order: string[], all: Record<string, Account>, now: number, exclude: string | null) => order.find((n) => n !== exclude && usable(all[n], now)) ?? null;
