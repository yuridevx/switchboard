// Общие хуки экранов: чтение данных экрана с отменой устаревшего ответа.
import { useCallback, useEffect, useState } from "react";

/** Ответ запроса ядра: результат или слово ошибки (форма Result, ядро ui не знает). */
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };

/**
 * Данные экрана: читает при открытии и при смене deps; устаревший ответ отбрасывается.
 * data остаётся прежней, пока идёт перечитывание; reload — перечитать.
 */
export function useLoad<T>(load: () => Promise<Answer<T>>, deps: readonly unknown[]): { data: T | undefined; error: string; loading: boolean; reload(): void } {
  const [state, setState] = useState<{ data: T | undefined; error: string; loading: boolean }>({ data: undefined, error: "", loading: true });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let stale = false;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    void load().then((r) => {
      if (!stale) setState((s) => (r.ok ? { data: r.result, error: "", loading: false } : { data: s.data, error: r.error, loading: false }));
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
