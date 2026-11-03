// pult-accounts — аккаунты Claude флота, вход по ссылке и коду, слоты горячей подмены. Здесь — только связка с ядром.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import css from "./accounts.css";
import { AccountsScreen } from "./AccountsScreen.tsx";
import { AccountsCtx } from "./context.ts";
import { createAccountsStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createAccounts(): AppModule {
  const accounts = createAccountsStore();
  return {
    on: { roster: accounts.onRoster },
    screens: {
      accounts: {
        nav: "Аккаунты",
        group: "Флот",
        mark: "logins",
        label: "Аккаунты",
        view: (p: ScreenProps) => (
          <AccountsCtx.Provider value={accounts}>
            <AccountsScreen {...p} />
          </AccountsCtx.Provider>
        ),
        head: () => ({ title: "Аккаунты" }),
      },
    },
    marks: { logins: () => accounts.pending() },
    css,
    start: accounts.start,
  };
}
