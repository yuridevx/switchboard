// Широкая карточка: шапка, плашка сбоя, вкладки и сведения сбоку.
import { useCallback, useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, failText, sessionOf, Tabs, useApp, useMachineLoad, useModule, type AccountsAnswer } from "@switchboard/web-ui";
import { Aside } from "./aside.tsx";
import { Head } from "./head.tsx";
import { Log } from "./log.tsx";
import { SetTab } from "./settings.tsx";
import type { CardState } from "./state.ts";

type Pop = "model" | "acc" | "menu" | null;

export function WideCard({ callsign, tab }: { callsign: string; tab?: string }) {
  const app = useApp();
  const card = useModule<CardState>();
  const machine = machineOf(callsign) ?? "";
  const session = app.use(() => sessionOf(app, callsign));
  const info = app.use(() => card.get().info);
  const hasLog = app.use(() => app.can(machine, "machine.journal") === true);
  const inserts = app.use(() => app.placed("card.tab", { callsign }));
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts").data;
  const [chosen, setChosen] = useState(tab ?? "chat");
  const [pop, setPopState] = useState<Pop>(null);
  const [names, setNames] = useState(false);
  const setPop = useCallback((p: Pop) => setPopState(p), []);

  const list: Array<[string, string]> = [["chat", "Разговор"], ...inserts.map((p): [string, string] => [p.name, p.label]), ["set", "Настройки"], ...(hasLog ? [["log", "Журнал"] as [string, string]] : [])];
  // вкладки нет (машина не умеет, вставка пропала) — «Настройки»
  const cur = list.some(([k]) => k === chosen) ? chosen : "set";
  const failed = session?.state === "failed" ? failText(session) : "";

  async function start() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${r.error}`);
  }
  async function update(field: "model" | "effort", value: string) {
    setPop(null);
    if (field === "model") app.run("models.load", { callsign });
    const r = await app.request("session.update", { callsign, [field]: value });
    if (!r.ok) app.toast(`${callsign}: ${field === "model" ? "модель" : "усилие"} — ${r.error}`);
  }

  return (
    <div className="cw">
      <Head callsign={callsign} session={session} accounts={accounts} pop={pop} setPop={setPop} openNames={() => setNames(true)} setTab={setChosen} start={() => void start()} update={(f, v) => void update(f, v)} tabs={<Tabs className="cw-tabs" tabs={list} cur={cur} pick={setChosen} />} />
      <div className="cw-pl" role="status" hidden={!failed}>
        {failed ? (
          <>
            <b>{`Не запустилась: ${failed}`}</b>
            <Btn onClick={() => setChosen("log")}>Почему</Btn>
          </>
        ) : null}
      </div>
      <div className={info ? "cw-body info" : "cw-body"}>
        <div className="cw-place">
          {cur === "chat" ? <app.Slot screen="chat" params={{ callsign }} /> : null}
          {cur === "set" ? <SetTab callsign={callsign} session={session} /> : null}
          {cur === "log" ? <Log callsign={callsign} /> : null}
          {inserts.some((p) => p.name === cur) ? <app.Slot screen={cur} params={{ callsign }} /> : null}
        </div>
        {info && session ? <Aside callsign={callsign} session={session} /> : null}
      </div>
      {names ? <app.Slot screen="labels" params={{ callsign }} close={() => setNames(false)} /> : null}
    </div>
  );
}
