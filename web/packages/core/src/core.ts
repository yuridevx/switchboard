// Состояние страницы: один объект, одно уведомление за такт, одна выборка — и для вида ядра, и для модулей.
import { useRef, useSyncExternalStore } from "react";
import type { Roster } from "@switchboard/relay";
import type { ConnState, Params } from "./types.ts";

export type Current = { screen: string; params: Params; master: string | null };

export type Core = {
  /** причина остановки; null — работает */
  stopped: string | null;
  /** подробности экрана остановки: ошибки гейта, приглашение */
  errors: string[];
  invite: string | null;
  /** пропуск */
  key: string | null;
  /** пропуск получен только что: экран подключения говорит об этом */
  invited: boolean;
  /** модули стартовали: полоса top на странице */
  started: boolean;
  link: ConnState;
  roster: Roster | null;
  /** когда пришёл последний roster */
  rosterAt: number | null;
  address: string | null;
  /** связь потеряна: полоса; момент следующей попытки */
  lost: { retryAt: number } | null;
  current: Current | null;
  toast: { text: string; tone: "ok" | "bad"; shown: boolean } | null;
  /** модули, выключенные ошибкой: имя → причина */
  failed: Record<string, string>;
  /** поиск открыт */
  searching: boolean;
};

export type Bus = {
  /** Данные изменились: выборки считаются заново один раз за такт. */
  changed(): void;
  /** Уведомить сейчас: перед тем, как вернуть управление стенду и браузеру. */
  flush(): void;
  /** Хук: выборка; компонент перерисуется, только когда ответ изменился. */
  use<T>(select: (prev?: T) => T): T;
};

/** Новый ответ выборки поверх прошлого: всё равно — прошлая ссылка, у изменившегося — соседние ветви прежними ссылками. */
export function reuse<T>(was: T, now: T): T {
  if (Object.is(was, now)) return was;
  if (Array.isArray(was) && Array.isArray(now)) {
    const next = now.map((x, i) => (i < was.length ? reuse(was[i], x) : x));
    return was.length === now.length && next.every((x, i) => x === was[i]) ? was : (next as T);
  }
  if (!plain(was) || !plain(now)) return now;
  const keys = Object.keys(now);
  const next = Object.fromEntries(keys.map((k) => [k, Object.hasOwn(was, k) ? reuse(was[k], now[k]) : now[k]]));
  return keys.length === Object.keys(was).length && keys.every((k) => Object.hasOwn(was, k) && next[k] === was[k]) ? was : (next as T);
}

function plain(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

export function createBus(): Bus {
  const listeners = new Set<() => void>();
  let due = false;
  const flush = () => {
    due = false;
    for (const l of [...listeners]) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  return {
    changed() {
      if (due) return;
      due = true;
      queueMicrotask(() => due && flush());
    },
    flush,
    use<T>(select: (prev?: T) => T): T {
      const last = useRef<{ value: T } | null>(null);
      return useSyncExternalStore(subscribe, () => {
        const value = last.current ? reuse(last.current.value, select(last.current.value)) : select();
        last.current = { value };
        return value;
      });
    },
  };
}
