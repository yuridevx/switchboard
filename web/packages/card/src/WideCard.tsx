// Карточка сессии в широком виде (пульт), по прототипу «Пульт и телефон»: шапка — одна строка, плашка — только у не запустившейся,
// сведения сбоку — по желанию. Вкладки: «Разговор» · вкладки места card.tab · «Настройки» · «Журнал».
// Поле — у своего владельца: модель, усилие, быстрый режим, заголовок — session.update; слот — session.slot; профиль — session.profile;
// итог изменения — из следующего roster. Нет имени в contract — нет кнопки.
import { useState } from "react";
import { useApp, type Params } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { useCan, useCard, useSession } from "./context.ts";
import { LogTab } from "./LogTab.tsx";
import { Names } from "./Names.tsx";
import { failedText, LIVE } from "./session.ts";
import { SetTab } from "./SetTab.tsx";
import { useWideData } from "./useWideData.ts";
import { WideAside } from "./WideAside.tsx";
import { WideHead } from "./WideHead.tsx";

export function WideCard({ params }: { params: Params }) {
  const app = useApp();
  const card = useCard();
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  const s = useSession(callsign);
  const can = useCan(machine);
  const info = app.use(card.info);
  const placedTabs = app.use(() => app.placed("card.tab", { callsign }));
  const live = LIVE.has(String(s?.state));
  const data = useWideData(callsign, machine, live, info);

  /** вкладка: разговор и вставка места — экран в месте, остальное — настройки или журнал */
  const resolve = (k: string) => {
    if (k === "chat" || app.placed("card.tab", { callsign }).some((t) => t.screen === k)) return k;
    if (k === "log" && app.can(machine, "machine.journal") === true) return k;
    return "set";
  };
  const [tab, setTab] = useState(() => resolve(params.tab ?? "chat"));
  const select = (k: string) => {
    if (k !== tab) setTab(resolve(k));
  };
  const [names, setNames] = useState(false);

  const tabs: Array<[string, string]> = [["chat", "Разговор"], ...placedTabs.map((t): [string, string] => [t.screen, t.label]), ["set", "Настройки"], ...(can("machine.journal") ? ([["log", "Журнал"]] as Array<[string, string]>) : [])];
  const failed = s?.state === "failed";
  return (
    <>
      <div className="cw">
        <WideHead callsign={callsign} machine={machine} s={s} can={can} data={data} tabs={tabs} tab={tab} select={select} openNames={() => setNames(true)} />
        {/* плашка — только у не запустившейся: причина и журнал */}
        <div className="cw-pl" role="status" hidden={!failed}>
          {failed ? (
            <>
              <b>{`Не запустилась${failedText(s!) ? ": " + failedText(s!) : ""}`}</b>
              {can("machine.journal") ? (
                <button className="cw-b" onClick={() => select("log")}>
                  Почему
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        <div className={"cw-body" + (info ? " info" : "")}>
          <div className="cw-place">
            {tab === "log" ? (
              <LogTab machine={machine} callsign={callsign} />
            ) : tab === "set" ? (
              <SetTab machine={machine} callsign={callsign} s={s} can={can} live={live} data={data} />
            ) : (
              <app.Slot key={tab} screen={tab} params={{ callsign }} />
            )}
          </div>
          {info ? <WideAside callsign={callsign} s={s} mcp={data.mcp} toggleMcp={data.toggleMcp} /> : null}
        </div>
      </div>
      {names ? <Names callsign={callsign} close={() => setNames(false)} /> : null}
    </>
  );
}
