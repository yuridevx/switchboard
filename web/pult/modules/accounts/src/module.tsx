// Снесено: экран на месте, данных нет.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./accounts.css";

export function createAccounts(_app: App): AppModule {
  return { screens: { accounts: { nav: "Аккаунты", group: "Флот", mark: "logins", label: "Аккаунты", view: () => <div>снесено</div>, head: () => ({ title: "Аккаунты" }) } }, marks: { logins: () => 0 }, css };
}
