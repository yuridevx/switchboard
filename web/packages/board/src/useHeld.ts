// Выборка вида: пока рисовать нельзя (ждём prefs, идёт перестановка) — прошлый ответ.
import { useApp } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";

export function useHeld<T>(select: () => T): T | undefined {
  const app = useApp();
  const board = useBoard();
  return app.use<T | undefined>((prev?: T) => (board.held() ? prev : select()));
}
