// Хуки экрана: чей он, часы, строки итога.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { App } from "./app.ts";

/** App модуля, чей экран рисуется: значение ставит место экрана. */
export const AppCtx = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppCtx);
  if (!app) throw new Error("useApp вне экрана модуля");
  return app;
}

/** Стор модуля, чей экран рисуется: поле state его определения. */
export const useModule = <T>(): T => useApp().state as T;

/** Текущее время с шагом ms: таймер живёт, пока компонент на экране; ms 0 — стоит. Отсчёт виден только там, где он нужен. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ms) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Строка итога действия. */
export type OutcomeNote = { text: string; tone?: "ok" | "bad" | "wait" | "" };

/** Строки итога действий по ключу: живут, пока стоит компонент; действие возвращает результат, слова кладёт экран. */
export function useOutcome(): readonly [Readonly<Record<string, OutcomeNote>>, (key: string, text: string, tone?: OutcomeNote["tone"]) => void] {
  const [notes, setNotes] = useState<Record<string, OutcomeNote>>({});
  const say = useCallback((key: string, text: string, tone?: OutcomeNote["tone"]) => setNotes((n) => ({ ...n, [key]: { text, tone } })), []);
  return [notes, say];
}
