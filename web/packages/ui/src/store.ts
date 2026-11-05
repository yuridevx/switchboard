// Хранилище состояния модуля: неизменяемый снимок и правка через immer. Подписки нет: виды выбирают снимок выборкой app.use,
// notify — app.changed модуля. Неизменённые ветви сохраняют ссылку: сравнение выборки и memo не обходят всё дерево.
import { produce, type Draft } from "immer";

export type Store<S> = {
  /** снимок: менять нельзя, читать можно где угодно */
  get(): S;
  /** правка снимка; ничего не изменилось — notify не зовётся */
  set(change: (draft: Draft<S>) => void): void;
};

export function createStore<S>(initial: S, notify: () => void = () => {}): Store<S> {
  let snapshot = initial;
  return {
    get: () => snapshot,
    set(change) {
      const next = produce(snapshot, change);
      if (next !== snapshot) {
        snapshot = next;
        notify();
      }
    },
  };
}
