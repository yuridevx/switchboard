// Хуки экрана: свой app и стор, часы, итоги действий, данные запроса.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { App, Result } from "./app.ts";
import type { OutcomeNote } from "./parts.tsx";

export const AppCtx = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppCtx);
  if (!app) throw new Error("useApp вне экрана модуля");
  return app;
}

export const useModule = <T>() => useApp().state as T;

/** Часы шагами ms; 0 — стоят. */
export function useNow(ms: number) {
  const [now, set] = useState(Date.now);
  useEffect(() => {
    if (!ms) return;
    const timer = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Строки итога по ключу. */
export function useOutcome() {
  const [notes, set] = useState<Record<string, OutcomeNote>>({});
  const say = useCallback((key: string, text: string, tone?: OutcomeNote["tone"]) => set((n) => ({ ...n, [key]: { text, tone } })), []);
  return [notes, say] as const;
}

const sameDeps = (a: readonly unknown[] | null, b: readonly unknown[]) => !!a && a.every((x, i) => Object.is(x, b[i]));

type Got<T> = { deps: readonly unknown[] | null; turn: number; again: unknown; data?: T; error: string };

/**
 * Данные экрана: читает при открытии, смене deps, смене again и reload. Прежние данные видны, пока идёт чтение;
 * отказ держит их только для тех же deps. stale — данные других deps; опоздавший ответ отброшен.
 */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: readonly unknown[], again?: unknown) {
  const [got, setGot] = useState<Got<T>>({ deps: null, turn: 0, again, error: "" });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let live = true;
    void load().then((r) => {
      if (!live) return;
      setGot((was) => ({ deps, turn, again, error: r.ok ? "" : r.error, data: r.ok ? r.result : sameDeps(was.deps, deps) ? was.data : undefined }));
    });
    return () => {
      live = false;
    };
  }, [...deps, again, turn]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  const same = sameDeps(got.deps, deps);
  return { data: got.data, error: got.error, loading: !same || got.turn !== turn || got.again !== again, stale: !!got.deps && !same, reload };
}

const NOT_ASKED = new Promise<never>(() => {});

/** Чтение у машины: вернулась связь — читает заново; нельзя спросить — запроса и слова нет. */
export function useMachineLoad<T>(machine: string, name: string, body?: Record<string, unknown>, when = true) {
  const app = useApp();
  const can = app.use(() => when && app.link() === "open" && app.can(machine, name) === true);
  const since = app.use(() => app.roster()?.machines.find((m) => m.machine === machine)?.since);
  return useLoad<T>(() => (can ? app.read<T>(name, { machine, ...body }) : NOT_ASKED), [machine, name, JSON.stringify(body)], `${can}:${since}`);
}
