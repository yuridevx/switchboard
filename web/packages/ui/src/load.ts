// Данные экрана: чтение при открытии, смене deps и reload; ответ устаревшего вопроса отброшен.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Result } from "./app.ts";
import { useApp } from "./hooks.ts";

type Answer<T> = { asked?: object; of?: object; data?: T; error: string };

/**
 * data остаётся прежней, пока идёт чтение; stale — она от прежних deps; отказ по новым deps снимает её (данные прежних deps — не ответ для новых), отказ перечитывания — держит.
 * again — смена значения перечитывает, как reload: данные те же, ответ свежее.
 * loading верен уже в первом рисунке с новыми deps: оба считаются сравнением, а не эффектом.
 */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: readonly unknown[], again?: unknown): { data: T | undefined; error: string; loading: boolean; stale: boolean; reload(): void } {
  const [tick, setTick] = useState(0);
  const [answer, setAnswer] = useState<Answer<T>>({ error: "" });
  // опознание: новый объект — новые deps, новый вопрос
  const of = useMemo(() => ({}), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const asked = useMemo(() => ({}), [of, again, tick]);
  useEffect(() => {
    let current = true;
    void load().then((r) => {
      if (!current) return;
      setAnswer((was) => (r.ok ? { asked, of, data: r.result, error: "" } : { asked, of, data: was.of === of ? was.data : undefined, error: r.error }));
    });
    return () => {
      current = false;
    };
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: answer.data, error: answer.error, loading: answer.asked !== asked, stale: answer.of !== of, reload };
}

const NOT_ASKED = new Promise<never>(() => {});

/**
 * Данные от машины: спрашивает, когда машина на связи и умеет запрос; when — ещё условие экрана.
 * Машина вернулась, перезапустилась или связь открылась снова — перечитывает сам; пока спросить нельзя, данные прежние.
 */
export function useMachineLoad<T>(machine: string, name: string, body?: Record<string, unknown>, when = true): { data: T | undefined; error: string; loading: boolean; stale: boolean; reload(): void } {
  const app = useApp();
  const can = app.use(() => when && app.link() === "open" && app.can(machine, name) === true);
  const since = app.use(() => app.roster()?.machines.find((m) => m.machine === machine)?.since);
  return useLoad<T>(() => (can ? app.read<T>(name, body) : NOT_ASKED), [machine, name, JSON.stringify(body)], `${can}:${since}`);
}
