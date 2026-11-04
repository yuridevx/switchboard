// Экран аккаунтов: широкий вид — аккаунты и слоты рядом; узкий — переключатель.
import { useEffect } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, Page, PageHead, useApp } from "@switchboard/web-ui";
import { AccountsView } from "./AccountsView.tsx";
import { ScreenProvider, useAccountsScreen } from "./screen.tsx";
import { SlotsView } from "./SlotsView.tsx";
import { useAccounts } from "./store.ts";

export function AccountsScreen({ params }: ScreenProps) {
  const app = useApp();
  const store = useAccounts();
  const screen = useAccountsScreen(params);
  const loginMachine = app.use(() => store.machines("machine.login")[0]);
  useEffect(() => store.mount(), [store]);
  const newAccount = loginMachine ? (
    <Btn pri onClick={() => screen.openNew(loginMachine)}>
      + Новый аккаунт
    </Btn>
  ) : null;
  const tab = (view: string, label: string) => (
    <Btn aria-pressed={screen.view === view ? "true" : "false"} onClick={() => screen.setView(view)}>
      {label}
    </Btn>
  );
  return (
    <ScreenProvider value={screen}>
      {app.wide ? (
        <Page>
          <div className="ac-cols">
            <div className="ac-col" data-col="accounts">
              <PageHead title="Аккаунты">{newAccount}</PageHead>
              <AccountsView />
            </div>
            <div className="ac-col" data-col="slots">
              <PageHead title="Слоты" />
              <SlotsView />
            </div>
          </div>
        </Page>
      ) : (
        <Page>
          <PageHead>
            {tab("accounts", "Аккаунты")}
            {tab("slots", "Слоты")}
            {screen.view === "accounts" ? newAccount : null}
          </PageHead>
          {screen.view === "slots" ? <SlotsView /> : <AccountsView />}
        </Page>
      )}
    </ScreenProvider>
  );
}
