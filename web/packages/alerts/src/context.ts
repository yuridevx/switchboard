// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { AlertsStore } from "./store.ts";

export const AlertsCtx = createContext<AlertsStore | null>(null);
export const useAlerts = (): AlertsStore => useContext(AlertsCtx)!;
