// Состояние ядра, которое читают вид и модули: один неизменяемый снимок. Правка заменяет снимок и будит вид.
// Не createStore: roster принадлежит клиенту флота и не замораживается.
import type { Roster } from "@switchboard/relay";
import type { ConnState, Params } from "./types.ts";

/** Экран на всю страницу: что случилось и данные для него; рисует его вид (view/stops.tsx). */
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

/** Приложение остановлено: экран и слово причины. */
export type Stopped = Stop & { why: string };

export type Toast = { text: string; tone: "ok" | "bad"; shown: boolean };

export type CoreState = {
  /** остановлено: экран на всю страницу (вход, отказ) и слово причины */
  full: Stopped | null;
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
  toast: Toast | null;
};

export type CoreStore = {
  get(): CoreState;
  /** quiet — снимок новый, вид не будить: страница скрыта, увидит при следующем изменении */
  set(patch: Partial<CoreState>, o?: { quiet: boolean }): void;
};

export function createCoreState(css: string, changed: () => void): CoreStore {
  let state: CoreState = { full: null, css, key: "", fresh: false, conn: "connecting", roster: null, rosterAt: 0, retryAt: 0, current: null, master: null, tops: [], toast: null };
  return {
    get: () => state,
    set(patch, o) {
      state = { ...state, ...patch };
      if (!o?.quiet) changed();
    },
  };
}

const TOAST_MS = 6_000;

/** Короткая строка внизу экрана: новая сменяет прежнюю, через 6 с скрывается. */
export function createToast(state: CoreStore) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (text: string, tone: "ok" | "bad" = "bad") => {
    clearTimeout(timer);
    state.set({ toast: { text, tone, shown: true } });
    timer = setTimeout(() => {
      const t = state.get().toast;
      state.set(t ? { toast: { ...t, shown: false } } : {});
    }, TOAST_MS);
  };
}
