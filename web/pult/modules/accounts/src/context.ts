// Стор модуля и контекст открытого экрана.
import { createContext, useContext } from "react";
import { useModule } from "@switchboard/web-ui";
import type { AccountsScreenState } from "./screen.ts";
import type { AccountsStore } from "./store.ts";

export const useAccounts = (): AccountsStore => useModule<AccountsStore>();

export const ScreenCtx = createContext<AccountsScreenState | null>(null);
export const useScreen = (): AccountsScreenState => useContext(ScreenCtx)!;
