// Выборка вида: пока рисовать нельзя (ждём prefs, идёт перестановка) — прошлый ответ.
import { useState } from "react";
import { useApp } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";

const HOLD = Symbol("hold");

export function useHeld<T>(select: () => T): T | undefined {
  const app = useApp();
  const board = useBoard();
  const v = app.use<T | typeof HOLD>(() => (board.held() ? HOLD : select()));
  const [last, setLast] = useState<T | undefined>(undefined);
  // поправка при рисовании: равные ответы выборка отдаёт той же ссылкой, поэтому она одна на новый ответ
  if (v !== HOLD && v !== last) setLast(v as T);
  return v === HOLD ? last : (v as T);
}
