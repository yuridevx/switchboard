// Экран аккаунтов: широкий вид — аккаунты и слоты рядом; узкий — переключатель.
import { useEffect } from "react";
import { useApp, type ScreenProps } from "@switchboard/web-core";
import { Btn, Page, PageHead } from "@switchboard/web-ui";
import { AccountsView } from "./AccountsView.tsx";
import { ScreenCtx, useAccounts } from "./context.ts";
import { useAccountsScreen } from "./screen.ts";
import { SlotsView } from "./SlotsView.tsx";

export function AccountsScreen({ params }: ScreenProps) {
  const app = useApp();
  const store = useAccounts();
  const sc = useAccountsScreen(params);
  const canLogin = app.use(() => store.machines("machine.login")[0]);
  useEffect(() => store.mount(), [store]);
  const newBtn = canLogin ? (
    <Btn pri onClick={() => sc.openNew(canLogin)}>
      + Новый аккаунт
    </Btn>
  ) : null;
  return (
    <ScreenCtx.Provider value={sc}>
      {app.wide ? (
        <Page>
          <div className="ac-cols">
            <div className="ac-col" data-col="accounts">
              <PageHead title="Аккаунты">{newBtn}</PageHead>
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
            <Btn aria-pressed={sc.view === "accounts" ? "true" : "false"} onClick={() => sc.setView("accounts")}>
              Аккаунты
            </Btn>
            <Btn aria-pressed={sc.view === "slots" ? "true" : "false"} onClick={() => sc.setView("slots")}>
              Слоты
            </Btn>
            {sc.view === "accounts" ? newBtn : null}
          </PageHead>
          {sc.view === "slots" ? <SlotsView /> : <AccountsView />}
        </Page>
      )}
    </ScreenCtx.Provider>
  );
}
