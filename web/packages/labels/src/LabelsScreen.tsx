// Окно «Имена» в месте вызывающего: закрылось — вызывающий получает close через app.Slot.
import { useState, type KeyboardEvent } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { machineOf, nameOf } from "@switchboard/protocol";
import { Btn, useApp, In } from "@switchboard/web-ui";
import { useLabels } from "./store.ts";

export function LabelsScreen({ params, close }: ScreenProps) {
  const app = useApp();
  const labels = useLabels();
  const callsign = params.callsign ?? "";
  const machine = params.machine ?? machineOf(callsign) ?? "";
  const [sessionName, setSessionName] = useState(() => (callsign ? labels.nameOf(callsign) : ""));
  const [machineName, setMachineName] = useState(() => labels.nameOf(`@${machine}`));

  const done = () => close?.();
  const save = () => {
    labels.save(callsign, machine, sessionName.trim(), machineName.trim());
    done();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") done();
  };
  return (
    <div className={app.wide ? "lb-veil" : "lb-veil narrow"} onClick={(e) => e.target === e.currentTarget && done()}>
      <div className="lb-dlg" role="dialog" aria-label="Имена">
        <b>Имена</b>
        <div className="lb-a">{callsign || `@${machine}`}</div>
        {callsign ? (
          <label className="lb-f">
            <span>Имя сессии</span>
            <In autoFocus data-f="session" value={sessionName} placeholder={nameOf(callsign)} autoComplete="off" onInput={(e) => setSessionName(e.currentTarget.value)} onKeyDown={keys} />
          </label>
        ) : null}
        <label className="lb-f">
          <span>Имя машины</span>
          <In autoFocus={!callsign} data-f="machine" value={machineName} placeholder={`@${machine}`} autoComplete="off" onInput={(e) => setMachineName(e.currentTarget.value)} onKeyDown={keys} />
        </label>
        <div className="lb-ft">
          <Btn onClick={done}>Отмена</Btn>
          <Btn pri data-act="save" onClick={save}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
