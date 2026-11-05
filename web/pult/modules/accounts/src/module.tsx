// pult-accounts — связка экрана с ядром; ответы машин и входы — state.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import css from "./accounts.css";
import { AccountsScreen } from "./screen.tsx";
import { createAccountsState } from "./state.ts";

export function createAccounts(app: App): AppModule {
  const state = createAccountsState(app);
  return {
    state,
    on: { roster: state.onRoster, link: state.answers.onLink },
    screens: { accounts: { nav: "Аккаунты", group: "Флот", mark: "logins", label: "Аккаунты", view: AccountsScreen, head: () => ({ title: "Аккаунты" }) } },
    marks: { logins: () => state.pending() },
    css,
  };
}
