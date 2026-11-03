// Выборка вида: пока рисовать нельзя (ждём prefs, идёт перестановка) — прошлый ответ.
import { useRef } from "react";
import { useApp } from "@switchboard/web-ui";
import { useBoard } from "./context.ts";

const HOLD = Symbol("hold");

export function useHeld<T>(select: () => T): T | undefined {
  const app = useApp();
  const board = useBoard();
  const last = useRef<T | undefined>(undefined);
  const v = app.use<T | typeof HOLD>(() => (board.held() ? HOLD : select()));
  // прошлый ответ — не состояние: от него не зависит, рисовать ли заново
  if (v !== HOLD) last.current = v as T;
  return last.current;
}
