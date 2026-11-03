// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { BoardStore } from "./store.ts";

export const BoardCtx = createContext<BoardStore | null>(null);
export const useBoard = (): BoardStore => useContext(BoardCtx)!;
