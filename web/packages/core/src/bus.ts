// Подписка вида: одно уведомление за такт и хук выборки. Единственный механизм, через который вид узнаёт об изменениях.
import { useRef, useSyncExternalStore } from "react";
import { same } from "./same.ts";

export type Bus = ReturnType<typeof createBus>;

export function createBus() {
  const subs = new Set<() => void>();
  let rev = 0;
  let queued = false;
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => void subs.delete(f);
  };
  function changed() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      rev++;
      for (const f of [...subs]) f();
    });
  }

  /** Хук выборки: ответ сравнивается с прошлым, тот же — компонент не перерисовывается. */
  function useSelect<T>(select: () => T): T {
    const last = useRef<{ v: T } | null>(null);
    const snap = () => {
      const v = select();
      if (!last.current || !same(last.current.v, v)) last.current = { v };
      return last.current.v;
    };
    return useSyncExternalStore(subscribe, snap, snap);
  }

  return { subscribe, changed, rev: () => rev, useSelect };
}
