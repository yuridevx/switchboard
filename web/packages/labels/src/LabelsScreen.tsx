// Окно «Имена» в месте вызывающего: закрылось — вызывающий получает close через app.Slot; открыто по адресу — шаг назад.
import { useState, type KeyboardEvent } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { machineOf, nameOf } from "@switchboard/protocol";
import { Btn, In, useApp } from "@switchboard/web-ui";
import { useNames } from "./names.ts";

type FieldProps = { id: string; title: string; hint: string; value: string; focus: boolean; set(text: string): void; onKeyDown(e: KeyboardEvent): void };

function Field({ id, title, hint, value, focus, set, onKeyDown }: FieldProps) {
  return (
    <label className="lb-f">
      <span>{title}</span>
      <In autoFocus={focus} data-f={id} value={value} placeholder={hint} autoComplete="off" onInput={(e) => set(e.currentTarget.value)} onKeyDown={onKeyDown} />
    </label>
  );
}

export function LabelsScreen({ params, close }: ScreenProps) {
  const app = useApp();
  const names = useNames();
  const callsign = params.callsign ?? "";
  const machine = params.machine ?? machineOf(callsign) ?? "";
  const [sessionName, setSessionName] = useState(() => names.nameOf(callsign));
  const [machineName, setMachineName] = useState(() => names.nameOf(`@${machine}`));

  const leave = () => (close ? close() : app.back());
  const save = () => {
    names.save(callsign, machine, sessionName, machineName);
    leave();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") leave();
  };
  return (
    <div className={app.wide ? "lb-veil" : "lb-veil narrow"} onClick={(e) => e.target === e.currentTarget && leave()}>
      <div className="lb-dlg" role="dialog" aria-label="Имена">
        <b>Имена</b>
        <div className="lb-a">{callsign || `@${machine}`}</div>
        {callsign ? <Field id="session" title="Имя сессии" hint={nameOf(callsign)} value={sessionName} focus set={setSessionName} onKeyDown={onKeyDown} /> : null}
        <Field id="machine" title="Имя машины" hint={`@${machine}`} value={machineName} focus={!callsign} set={setMachineName} onKeyDown={onKeyDown} />
        <div className="lb-ft">
          <Btn onClick={leave}>Отмена</Btn>
          <Btn pri data-act="save" onClick={save}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
