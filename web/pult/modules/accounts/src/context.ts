// Контекст открытого экрана.
import { createContext, useContext } from "react";
import type { AccountsScreenState } from "./screen.ts";

export const ScreenCtx = createContext<AccountsScreenState | null>(null);
export const useScreen = (): AccountsScreenState => useContext(ScreenCtx)!;
