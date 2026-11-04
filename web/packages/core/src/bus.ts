// Подписка вида: одно уведомление за такт и хук выборки. Единственный механизм, через который вид узнаёт об изменениях.
import { useRef, useSyncExternalStore } from "react";
import { share } from "./same.ts";

export type Bus = ReturnType<typeof createBus>;

export function createBus() {
  const subs = new Set<() => void>();
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
      for (const f of [...subs]) f();
    });
  }

  /** Хук выборки: ответ сравнивается с прошлым, тот же — компонент не перерисовывается; равные ветви нового ответа — прежние ссылки. Прошлый ответ выборка получает аргументом: удержать его можно без своей копии. */
  function useSelect<T>(select: (prev?: T) => T): T {
    const last = useRef<{ v: T } | null>(null);
    const snap = () => {
      const v = select(last.current?.v);
      if (!last.current) last.current = { v };
      else last.current = { v: share(last.current.v, v) };
      return last.current.v;
    };
    return useSyncExternalStore(subscribe, snap, snap);
  }

  return { changed, useSelect };
}
