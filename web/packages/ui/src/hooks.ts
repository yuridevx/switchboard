// Общие хуки экранов: чтение данных экрана с отменой устаревшего ответа.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/** App модуля. Набор ядра не знает: тип дописывает ядро (declare module), значение ставит место экрана. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppHandle {}

export const AppCtx = createContext<AppHandle | null>(null);

/** App модуля, чей экран рисуется. */
export function useApp(): AppHandle {
  const app = useContext(AppCtx);
  if (!app) throw new Error("useApp вне экрана модуля");
  return app;
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

/** Ответ запроса ядра: результат или слово ошибки (форма Result, ядро ui не знает). */
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };

/**
 * Данные экрана: читает при открытии и при смене deps; устаревший ответ отбрасывается.
 * data остаётся прежней, пока идёт чтение; отказ по новым deps снимает её (данные прежних deps — не ответ для новых), отказ перечитывания — держит.
 * reload — перечитать.
 */
export function useLoad<T>(load: () => Promise<Answer<T>>, deps: readonly unknown[]): { data: T | undefined; error: string; loading: boolean; reload(): void } {
  const [state, setState] = useState<{ data: T | undefined; error: string; loading: boolean }>({ data: undefined, error: "", loading: true });
  const [turn, setTurn] = useState(0);
  const lastTurn = useRef(turn);
  useEffect(() => {
    let stale = false;
    const again = lastTurn.current !== turn;
    lastTurn.current = turn;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    void load().then((r) => {
      if (!stale) setState((s) => (r.ok ? { data: r.result, error: "", loading: false } : { data: again ? s.data : undefined, error: r.error, loading: false }));
    });
    return () => {
      stale = true;
    };
    // load меняется с каждым рисованием: когда читать заново, говорят deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, turn]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  return { ...state, reload };
}
