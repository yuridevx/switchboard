// Экран аккаунтов: в широком виде аккаунты и слоты рядом, в узком — переключатель.
import { useEffect, useState } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, machinesWith, Page, useApp, useOutcome } from "@switchboard/web-ui";
import { AccountsColumn } from "./AccountsColumn.tsx";
import { SlotsColumn } from "./SlotsColumn.tsx";
import { useAccounts } from "./state.ts";

export function AccountsScreen({ params }: ScreenProps) {
  const app = useApp();
  const state = useAccounts();
  const [view, setView] = useState(params.view === "slots" ? "slots" : "accounts");
  const [notes, say] = useOutcome();
  const [machine, setMachine] = useState(params.machine ?? "");
  const answers = app.use(() => state.answers.get());
  const machines = app.use(() => machinesWith(app, "machine.accounts"));
  const project = app.use(() => app.mark("project.current"));
  const near = app.use(() => (project ? (app.mark("project.machines", project) ?? []) : []));
  useEffect(() => state.answers.mount(), [state]);

  const shared = { answers, machines, near, notes, say };
  const cur = machines.includes(machine) ? machine : (near.find((m) => machines.includes(m)) ?? machines[0] ?? "");
  const tabs = app.wide ? null : (
    <>
      <Btn aria-pressed={view === "accounts" ? "true" : "false"} onClick={() => setView("accounts")}>
        Аккаунты
      </Btn>
      <Btn aria-pressed={view === "slots" ? "true" : "false"} onClick={() => setView("slots")}>
        Слоты
      </Btn>
    </>
  );
  const accounts = <AccountsColumn {...shared} cur={cur} tabs={tabs} />;
  const slots = <SlotsColumn {...shared} cur={cur} pick={setMachine} tabs={tabs} />;

  if (app.wide) {
    return (
      <Page>
        <div className="ac-cols">
          <div className="ac-col" data-col="accounts">
            {accounts}
          </div>
          <div className="ac-col" data-col="slots">
            {slots}
          </div>
        </div>
      </Page>
    );
  }
  return <Page>{view === "slots" ? slots : accounts}</Page>;
}
