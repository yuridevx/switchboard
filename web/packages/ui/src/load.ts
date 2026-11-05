// Данные экрана: чтение при открытии и смене deps, устаревший ответ отбрасывается.
import { useCallback, useEffect, useState } from "react";
import type { Result } from "./app.ts";
import { useApp } from "./hooks.ts";

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** Последний полученный ответ и для каких deps он пришёл. */
type Answer<T> = { data: T | undefined; error: string; deps: readonly unknown[]; turn: number; again: unknown };

/**
 * data остаётся прежней, пока идёт чтение; stale — она от прежних deps; отказ по новым deps снимает её (данные прежних deps — не ответ для новых), отказ перечитывания — держит.
 * again — смена значения перечитывает, как reload: данные те же, ответ свежее.
 * loading верен уже в первом рисунке с новыми deps: оба считаются сравнением, а не эффектом.
 */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: readonly unknown[], again: unknown = null): { data: T | undefined; error: string; loading: boolean; stale: boolean; reload(): void } {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let outdated = false;
    void load().then((r) => {
      if (outdated) return;
      setAnswer((was) => ({ data: r.ok ? r.result : was && sameDeps(was.deps, deps) ? was.data : undefined, error: r.ok ? "" : r.error, deps, turn, again }));
    });
    return () => {
      outdated = true;
    };
    // load меняется с каждым рисованием: когда читать заново, говорят deps и again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, turn, again]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  const stale = !!answer && !sameDeps(answer.deps, deps);
  return { data: answer?.data, error: answer && !stale ? answer.error : "", stale, loading: !answer || stale || answer.turn !== turn || answer.again !== again, reload };
}

/** Не спрашиваем: данных нет, отказа нет. */
const NOT_ASKED = Promise.resolve({ ok: false, error: "" } as const);

/**
 * Данные от машины: спрашивает, когда машина на связи и умеет запрос; when — ещё условие экрана.
 * Машина вернулась, перезапустилась или связь открылась снова — перечитывает сам; пока спросить нельзя, данные прежние.
 */
export function useMachineLoad<T>(machine: string, name: string, body: Record<string, unknown> = { machine }, when = true) {
  const app = useApp();
  const mayAsk = app.use(() => when && app.link() === "open" && app.can(machine, name) === true);
  const since = app.use(() => app.roster()?.machines.find((m) => m.machine === machine)?.since);
  return useLoad<T>(() => (mayAsk ? app.read<T>(name, body) : (NOT_ASKED as Promise<Result<T>>)), [machine, name, JSON.stringify(body)], `${mayAsk}:${String(since)}`);
}
