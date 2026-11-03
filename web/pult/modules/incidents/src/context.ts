// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { IncidentsStore } from "./store.ts";

export const IncidentsCtx = createContext<IncidentsStore | null>(null);
export const useIncidents = (): IncidentsStore => useContext(IncidentsCtx)!;
