// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { SettingsStore } from "./store.ts";

export const SettingsCtx = createContext<SettingsStore | null>(null);
export const useSettings = (): SettingsStore => useContext(SettingsCtx)!;
