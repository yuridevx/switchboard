// pult-accounts — связка экрана с ядром; ответы машин и входы — state.ts, правила над аккаунтами — merge.ts, вид — screen.tsx.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import css from "./accounts.css";
import { AccountsScreen } from "./screen.tsx";
import { createAccountsState } from "./state.ts";

export function createAccounts(app: App): AppModule {
  const state = createAccountsState(app);
  return {
    state,
    on: { roster: state.onRoster, link: state.answers.onLink },
    screens: { accounts: { nav: "Аккаунты", group: "Флот", label: "Аккаунты", view: AccountsScreen, head: () => ({ title: "Аккаунты" }) } },
    css,
  };
}
