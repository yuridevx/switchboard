// pult-accounts — аккаунты Claude флота, вход по ссылке и коду, слоты горячей подмены. Здесь — только связка с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./accounts.css";
import { AccountsScreen } from "./AccountsScreen.tsx";
import { createAccountsStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createAccounts(app: App): AppModule {
  const accounts = createAccountsStore(app);
  return {
    state: accounts,
    on: { roster: accounts.onRoster, link: accounts.onLink },
    screens: {
      accounts: {
        nav: "Аккаунты",
        group: "Флот",
        mark: "logins",
        label: "Аккаунты",
        view: AccountsScreen,
        head: () => ({ title: "Аккаунты" }),
      },
    },
    marks: { logins: () => accounts.pending() },
    css,
  };
}
