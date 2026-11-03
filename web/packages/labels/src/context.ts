// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { LabelsStore } from "./store.ts";

export const LabelsCtx = createContext<LabelsStore | null>(null);
export const useLabels = (): LabelsStore => useContext(LabelsCtx)!;
