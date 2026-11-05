// Что знает ядро: один неизменяемый снимок, одно уведомление вида за такт, выборка компонентов и короткая строка внизу экрана.
import { useRef, useSyncExternalStore } from "react";
import type { Roster } from "@switchboard/relay";
import { createStore } from "@switchboard/web-ui";
import { share } from "./share.ts";
import type { ConnState, Params } from "./types.ts";

/** Экран на всю страницу вместо приложения; рисует его вид. */
export type Stop =
  | { kind: "gate"; errors: string[] }
  | { kind: "browser" }
  | { kind: "install"; number: string }
  | { kind: "pass"; why: "revoked" | "bad_key"; kid: string; command: string }
  | { kind: "outdated" }
  | { kind: "connection"; why: string }
  | { kind: "invite"; word: string }
  | { kind: "replace"; invite: string; number: string; kid: string }
  | { kind: "key"; command: string };

export type CoreState = {
  /** приложение остановлено: что показать и слово причины */
  full: (Stop & { why: string }) | null;
  css: string;
  /** пропуск устройства */
  key: string;
  /** приглашение принято в этом запуске */
  fresh: boolean;
  conn: ConnState;
  roster: Roster | null;
  rosterAt: number;
  retryAt: number;
  current: { screen: string; params: Params } | null;
  /** широкий вид: экран-список слева от текущего */
  master: string | null;
  /** экраны полосы над экранами разделов */
  tops: string[];
  toast: { text: string; tone: "ok" | "bad"; shown: boolean } | null;
};

const TOAST_MS = 6_000;

export type Snapshot = ReturnType<typeof createSnapshot>;

export function createSnapshot(css: string) {
  const watchers = new Set<() => void>();
  let queued = false;
  let silent = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function changed() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const watch of [...watchers]) watch();
    });
  }

  const store = createStore<CoreState>({ full: null, css, key: "", fresh: false, conn: "connecting", roster: null, rosterAt: 0, retryAt: 0, current: null, master: null, tops: [], toast: null }, () => {
    if (!silent) changed();
  });

  /** quiet — снимок новый, вид не будить: страница скрыта, увидит при следующем изменении. */
  function set(patch: Partial<CoreState>, o?: { quiet: boolean }) {
    silent = !!o?.quiet;
    store.set((draft) => void Object.assign(draft, patch));
    silent = false;
  }

  const watch = (f: () => void) => {
    watchers.add(f);
    return () => void watchers.delete(f);
  };

  /** Хук выборки: тот же ответ — компонент не перерисовывается. Прошлый ответ выборка получает аргументом: удержать его можно без своей копии. */
  function use<T>(select: (prev?: T) => T): T {
    const last = useRef<{ value: T } | null>(null);
    const read = () => {
      const value = select(last.current?.value);
      last.current = { value: last.current ? share(last.current.value, value) : value };
      return last.current.value;
    };
    return useSyncExternalStore(watch, read, read);
  }

  /** Новая строка сменяет прежнюю; через 6 с скрывается. */
  function toast(text: string, tone: "ok" | "bad" = "bad") {
    clearTimeout(toastTimer);
    set({ toast: { text, tone, shown: true } });
    toastTimer = setTimeout(() => {
      const t = store.get().toast;
      if (t) set({ toast: { ...t, shown: false } });
    }, TOAST_MS);
  }

  return { get: store.get, set, changed, use, toast };
}
