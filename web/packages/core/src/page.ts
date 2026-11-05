// Одно состояние страницы: вид и модули читают его выборкой, changed — один пересчёт за такт.
import { useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { Roster } from "@switchboard/relay";
import type { ConnState, Params, Platform, StartOptions } from "./types.ts";
import { idbStore, type Store } from "./store.ts";

const plain = (x: unknown): x is Record<string, unknown> => Array.isArray(x) || (typeof x === "object" && x !== null && Object.getPrototypeOf(x) === Object.prototype);

/** Новый ответ с прежними ссылками там, где содержимое то же; всё равно — прошлый ответ. */
function reuse<T>(was: unknown, next: T): T {
  if (Object.is(was, next)) return next;
  if (!plain(was) || !plain(next) || Array.isArray(was) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(was).length;
  const out: Record<string, unknown> = Array.isArray(next) ? ([] as never) : {};
  for (const k of keys) {
    out[k] = reuse(was[k], next[k]);
    same &&= Object.hasOwn(was, k) && out[k] === was[k];
  }
  return (same ? was : out) as T;
}

/** Почему страница стоит: слово для Running.stopped; invite — отказ приглашения, а не связи. */
export type Stop = { word: string; invite?: boolean };
export type Current = { screen: string; params: Params; master: string | null };

const platformOf = (w: Window): Platform => ({
  ios: /iPhone|iPad|iPod/.test(w.navigator.userAgent),
  standalone: (w.navigator as { standalone?: boolean }).standalone === true || w.matchMedia?.("(display-mode: standalone)").matches === true,
  scope: "CSSScopeRule" in w,
});

export type Page = ReturnType<typeof createPage>;

export function createPage(o: StartOptions) {
  const listeners = new Set<() => void>();
  let version = 0;
  let queued = false;
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const win = o.window ?? window;

  const page = {
    o,
    win,
    wide: !!o.wide,
    platform: o.platform ?? platformOf(win),
    store: (o.store ?? idbStore()) as Store,
    /** пропуск; до чтения хранилища — null */
    key: null as string | null,
    /** приглашение только что принято: экран подключения и тост о флоте */
    saved: false,
    /** приглашение из адреса: ждёт установки или решения о замене */
    invite: null as string | null,
    /** ошибки гейта набора */
    errors: [] as string[],
    /** отказ на экране ввода приглашения */
    note: "",
    stop: null as Stop | null,
    failed: {} as Record<string, string>,
    roster: null as Roster | null,
    link: "connecting" as ConnState,
    /** связи нет: когда следующая попытка */
    down: null as { retryAt: number } | null,
    /** когда пришли данные на экране */
    dataAt: 0,
    address: null as string | null,
    current: null as Current | null,
    css: "",
    toast: { text: "", tone: "", shown: false },
    search: false,
    /** модули стартовали: полоса top на странице */
    started: false,

    toggleSearch() {
      page.search = !page.search;
      page.changed();
    },

    changed() {
      if (queued) return;
      queued = true;
      void Promise.resolve().then(() => {
        queued = false;
        version++;
        flushSync(() => {
          for (const fn of listeners) fn();
        });
      });
    },

    /** Хук выборки: считается раз за такт и при новой выборке; компонент рисуется заново, только когда изменился ответ. */
    use<T>(select: (prev?: T) => T): T {
      const memo = useRef<{ select?: unknown; version: number; value?: T }>({ version: -1 }).current;
      return useSyncExternalStore(subscribe, () => {
        if (memo.select !== select || memo.version !== version) {
          memo.value = reuse(memo.value, select(memo.value));
          memo.select = select;
          memo.version = version;
        }
        return memo.value as T;
      });
    },
  };
  return page;
}
