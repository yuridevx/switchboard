// Карточка на пульте: шапка, плашка сбоя, вкладки, сведения сбоку.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, failText, sessionOf, useApp, useMachineLoad, useModule, type AccountsAnswer } from "@switchboard/web-ui";
import { Aside } from "./aside.tsx";
import { Head } from "./head.tsx";
import type { CardState } from "./module.tsx";
import { LogTab, SetTab } from "./tabs.tsx";

export function WideCard({ params }: ScreenProps) {
  const app = useApp();
  const c = useModule<CardState>();
  const { callsign } = params;
  const machine = machineOf(callsign)!;
  const [wanted, setTab] = useState(params.tab ?? "chat");
  const [names, setNames] = useState(false);
  const s = app.use(() => sessionOf(app, callsign));
  const info = app.use(() => c.device.get().info);
  const journal = app.use(() => app.can(machine, "machine.journal") === true);
  const placed = app.use(() => app.placed("card.tab", { callsign }));
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  const tabs: Array<[string, string]> = [["chat", "Разговор"], ...placed.map((p): [string, string] => [p.name, p.label]), ["set", "Настройки"], ...(journal ? [["log", "Журнал"] as [string, string]] : [])];
  // вкладки нет (машина не умеет, вставка пропала) — «Настройки»
  const tab = tabs.some(([k]) => k === wanted) ? wanted : "set";
  const failed = s?.state === "failed";
  const why = s && failText(s);
  return (
    <div className="cw">
      <Head callsign={callsign} accounts={accounts.data} tabs={tabs} tab={tab} pick={setTab} names={() => setNames(true)} />
      <div className="cw-pl" role="status" hidden={!failed}>
        {failed && (
          <>
            <b>{why ? `Не запустилась: ${why}` : "Не запустилась"}</b>
            {journal && <Btn onClick={() => setTab("log")}>Почему</Btn>}
          </>
        )}
      </div>
      <div className={info ? "cw-body info" : "cw-body"}>
        <div className="cw-place">
          {tab === "set" && <SetTab callsign={callsign} machine={machine} accounts={accounts} />}
          {tab === "log" && <LogTab callsign={callsign} machine={machine} />}
          {tab !== "set" && tab !== "log" && <app.Slot screen={tab} params={{ callsign }} />}
        </div>
        {info && <Aside callsign={callsign} machine={machine} />}
      </div>
      {names && <app.Slot screen="labels" params={{ callsign }} close={() => setNames(false)} />}
    </div>
  );
}
