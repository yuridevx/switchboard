// Основа стора модуля: неизменяемый снимок, правка — черновиком; без изменения снимок тот же.
import { freeze, produce, type Draft } from "immer";

export type Store<T> = { get(): T; set(fn: (draft: Draft<T>) => void): void };

export function createStore<T>(initial: T, notify?: () => void): Store<T> {
  let snapshot = freeze(initial, true);
  return {
    get: () => snapshot,
    set(fn) {
      const next = produce(snapshot, fn);
      if (next === snapshot) return;
      snapshot = next;
      notify?.();
    },
  };
}
