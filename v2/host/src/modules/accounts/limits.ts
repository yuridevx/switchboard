// Правила лимитов: чистые функции над записью аккаунта. Время — секунды.
// Очередь диктует модель: fable — только Fable, other — все остальные; годность аккаунта считается для вида очереди.

export type Window = { utilization: number; resetsAt: number; at: number };
/** Запись аккаунта; имя записи — почта. expires — конец входа по claude auth status, секунды. */
export type Account = { login: "ok" | "none"; plan?: string; expires?: number; limits: Record<string, Window> };
export type SlotModel = "fable" | "other";

/** Недельный лимит Fable: так его окно называет Claude. */
const FABLE_WINDOW = "seven_day_overage_included";
/** Окна, за которыми следит очередь, — закрытый список; прочие окна только записываются. */
const WATCHED: Record<SlotModel, string[]> = { fable: ["five_hour", "seven_day", FABLE_WINDOW], other: ["five_hour", "seven_day"] };
/** Порог окна: дальше подмена. У лимита Fable — как у недели: на 100 % Claude без вопроса берёт платные кредиты. */
const THRESHOLD: Record<string, number> = { five_hour: 0.95, seven_day: 0.98, [FABLE_WINDOW]: 0.98 };

export const watched = (model: SlotModel, window: string) => WATCHED[model].includes(window);

/** Модель подходит очереди: в fable — только Fable, в остальных — всё, кроме Fable. */
export const fits = (model: SlotModel, id: string) => /fable/i.test(id) === (model === "fable");
/** Модель сессии, у которой своя не задана. */
export const DEFAULT_MODEL: Record<SlotModel, string> = { fable: "fable", other: "opus" };

/** Окна вида очереди, дошедшие до порога и ещё не сброшенные. */
const hot = (a: Account, model: SlotModel, now: number) =>
  WATCHED[model].flatMap((n) => {
    const w = a.limits[n];
    return w && w.utilization >= THRESHOLD[n]! && (w.resetsAt === 0 || w.resetsAt > now) ? [w] : [];
  });

export const over = (a: Account, model: SlotModel, now: number) => hot(a, model, now).length > 0;

/** Когда аккаунт снова годен очереди: самый поздний сброс её окон у порога; 0 — годен или сброс неизвестен. */
export const usableAt = (a: Account, model: SlotModel, now: number) => Math.max(0, ...hot(a, model, now).map((w) => w.resetsAt));

/** Окна старше maxAge секунд; окон нет — тоже устарело. */
export const stale = (a: Account, maxAge: number, now: number) => Math.max(0, ...Object.values(a.limits).map((w) => w.at)) < now - maxAge || !Object.keys(a.limits).length;

/** Наружу: окно, чей сброс прошёл, — 0 %. */
export const shown = (a: Account, now: number): Account => ({
  ...a,
  limits: Object.fromEntries(Object.entries(a.limits).map(([n, w]) => [n, w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0 } : w])),
});

export const usable = (a: Account | undefined, model: SlotModel, now: number) => a?.login === "ok" && !over(a, model, now);

/** Следующий в запасе: по порядку, вошёл, ниже порога для вида очереди, не исключённый. */
export const nextUp = (order: string[], all: Record<string, Account>, model: SlotModel, now: number, exclude: string | null) => order.find((n) => n !== exclude && usable(all[n], model, now)) ?? null;
