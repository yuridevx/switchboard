// Состояние модуля: неизменяемый снимок и правка черновиком.
import { freeze, produce, type Draft } from "immer";

export type Store<S> = {
  /** снимок: менять нельзя, читать можно где угодно */
  get(): S;
  /** правка снимка; ничего не изменилось — notify не зовётся */
  set(change: (draft: Draft<S>) => void): void;
};

export function createStore<S>(initial: S, notify?: () => void): Store<S> {
  let state = freeze(initial, true);
  return {
    get: () => state,
    set(change) {
      const next = produce(state, change);
      if (next === state) return;
      state = next;
      notify?.();
    },
  };
}
