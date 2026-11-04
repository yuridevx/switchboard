// Общие хуки экранов: чтение данных экрана с отменой устаревшего ответа.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

/** App модуля. Набор ядра не знает: тип дописывает ядро (declare module), значение ставит место экрана. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppHandle {}

/** Что useModule берёт у App (поле дописывает и ядро). */
type WithState = { readonly state: unknown };

export const AppCtx = createContext<AppHandle | null>(null);

/** App модуля, чей экран рисуется. */
export function useApp(): AppHandle {
  const app = useContext(AppCtx);
  if (!app) throw new Error("useApp вне экрана модуля");
  return app;
}

/** Стор модуля, чей экран рисуется: поле state его определения. */
export function useModule<T>(): T {
  return (useApp() as WithState).state as T;
}

/** Текущее время с шагом ms: таймер живёт, пока компонент на экране; ms 0 — стоит. Отсчёт виден только там, где он нужен. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return;
    const h = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return now;
}

/** Ответ запроса ядра: результат или слово отказа. Одна форма на ядро и модули. */
export type Result<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * Данные экрана: читает при открытии и при смене deps; устаревший ответ отбрасывается.
 * data остаётся прежней, пока идёт чтение; stale — она от прежних deps; отказ по новым deps снимает её (данные прежних deps — не ответ для новых), отказ перечитывания — держит.
 * again — смена значения перечитывает, как reload: данные те же, ответ свежее.
 * loading верен уже в первом рисунке с новыми deps: оба считаются сравнением, а не эффектом.
 * reload — перечитать.
 */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: readonly unknown[], again: unknown = null): { data: T | undefined; error: string; loading: boolean; stale: boolean; reload(): void } {
  const [done, setDone] = useState<{ data: T | undefined; error: string; deps: readonly unknown[]; turn: number; again: unknown } | null>(null);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let gone = false;
    void load().then((r) => {
      if (!gone) setDone((s) => ({ data: r.ok ? r.result : s && sameDeps(s.deps, deps) ? s.data : undefined, error: r.ok ? "" : r.error, deps, turn, again }));
    });
    return () => {
      gone = true;
    };
    // load меняется с каждым рисованием: когда читать заново, говорят deps и again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, turn, again]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  const stale = !!done && !sameDeps(done.deps, deps);
  return { data: done?.data, error: done && !stale ? done.error : "", stale, loading: !done || stale || done.turn !== turn || done.again !== again, reload };
}

/** Что useMachineLoad берёт у App (поля дописывает ядро). */
type MachineApp = {
  use<R>(pick: () => R): R;
  can(machine: string, name: string): boolean | null;
  roster(): { machines: Array<{ machine: string; since?: unknown }> } | null;
  link(): string;
  request<T>(name: string, body?: Record<string, unknown>): Promise<Result<T>>;
};

/** Не спрашиваем: данных нет, отказа нет. */
const NOT_ASKED = Promise.resolve({ ok: false, error: "" } as const);

/**
 * Данные от машины: спрашивает, когда машина на связи и умеет запрос; when — ещё условие экрана.
 * Машина вернулась, перезапустилась или связь открылась снова — перечитывает сам; пока спросить нельзя, данные прежние.
 */
export function useMachineLoad<T>(machine: string, name: string, body: Record<string, unknown> = { machine }, when = true) {
  const app = useApp() as unknown as MachineApp;
  const asked = app.use(() => when && app.link() === "open" && app.can(machine, name) === true);
  const since = app.use(() => app.roster()?.machines.find((m) => m.machine === machine)?.since);
  return useLoad<T>(() => (asked ? app.request<T>(name, body) : NOT_ASKED), [machine, name, JSON.stringify(body)], `${asked}:${String(since)}`);
}
