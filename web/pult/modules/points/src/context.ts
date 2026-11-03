// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { PointsStore } from "./store.ts";

export const PointsCtx = createContext<PointsStore | null>(null);
export const usePoints = (): PointsStore => useContext(PointsCtx)!;
