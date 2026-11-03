// Контексты модуля: его состояние и состояние открытого экрана.
import { createContext, useContext } from "react";
import type { AccountsScreenState } from "./screen.ts";
import type { AccountsStore } from "./store.ts";

export const AccountsCtx = createContext<AccountsStore | null>(null);
export const useAccounts = (): AccountsStore => useContext(AccountsCtx)!;

export const ScreenCtx = createContext<AccountsScreenState | null>(null);
export const useScreen = (): AccountsScreenState => useContext(ScreenCtx)!;
