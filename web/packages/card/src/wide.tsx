// Карточка в широком виде (пульт), по прототипу «Пульт и телефон»: шапка — одна строка, плашка — только у не запустившейся,
// сведения сбоку — по желанию. Вкладки: «Разговор» · вкладки места card.tab · «Настройки» · «Журнал».
// Поле — у своего владельца: модель, усилие, быстрый режим, заголовок — session.update; слот — session.slot; профиль — session.profile;
// итог изменения — из следующего roster. Нет имени в contract — нет кнопки.
import { useState } from "react";
import type { Params } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { type AccountsAnswer, Btn, failText, isLive, useApp, useMachineLoad } from "@switchboard/web-ui";
import { WideAside } from "./aside.tsx";
import { WideHead } from "./head.tsx";
import { LogTab } from "./log.tsx";
import { Names, tabIn, useCan, useSession } from "./session.tsx";
import { SetTab } from "./settings.tsx";
import { useCard } from "./state.ts";

export type WideData = ReturnType<typeof useWideData>;

/** Аккаунты и слоты одним ответом на время экрана: их читают и шапка, и настройки. */
function useWideData(machine: string) {
  const q = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  return {
    accounts: q.data ? q.data.accounts : null,
    reloadAccounts: q.reload,
    slots: q.data ? q.data.slots : null,
    /** отказ чтения: на месте слотов — слово, а не «без слота» */
    word: q.error,
  };
}

export function WideCard({ params }: { params: Params }) {
  const app = useApp();
  const card = useCard();
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  const s = useSession(callsign);
  const can = useCan(machine);
  const info = app.use(card.info);
  const placed = app.use(() => app.placed("card.tab", { callsign }));
  const data = useWideData(machine);
  const [picked, select] = useState(params.tab ?? "chat");
  const [names, setNames] = useState(false);

  const tabs: Array<[string, string]> = [["chat", "Разговор"], ...placed.map((t): [string, string] => [t.name, t.label]), ["set", "Настройки"], ...(can("machine.journal") ? ([["log", "Журнал"]] as Array<[string, string]>) : [])];
  const tab = tabIn(picked, tabs, "set");
  const failed = s?.state === "failed";
  return (
    <>
      <div className="cw">
        <WideHead callsign={callsign} machine={machine} s={s} can={can} data={data} tabs={tabs} tab={tab} select={select} openNames={() => setNames(true)} />
        <div className="cw-pl" role="status" hidden={!failed}>
          {failed ? (
            <>
              <b>{`Не запустилась${failText(s!) ? ": " + failText(s!) : ""}`}</b>
              {can("machine.journal") ? <Btn onClick={() => select("log")}>Почему</Btn> : null}
            </>
          ) : null}
        </div>
        <div className={"cw-body" + (info ? " info" : "")}>
          <div className="cw-place">
            {tab === "log" ? (
              <LogTab machine={machine} callsign={callsign} />
            ) : tab === "set" ? (
              <SetTab machine={machine} callsign={callsign} s={s} can={can} live={isLive(s?.state)} data={data} />
            ) : (
              <app.Slot key={tab} screen={tab} params={{ callsign }} />
            )}
          </div>
          {info ? <WideAside callsign={callsign} s={s} /> : null}
        </div>
      </div>
      {names ? <Names callsign={callsign} close={() => setNames(false)} /> : null}
    </>
  );
}
