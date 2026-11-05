// Имена сессий и машин: метки над записью fleet.labels и окно «Имена».
import { useState, type ComponentProps } from "react";
import type { AppPart, ScreenProps } from "@switchboard/web-core";
import { machineOf, nameOf } from "@switchboard/protocol";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";
import { Btn, In, personal, plainMachine, plainSession, type Shown } from "@switchboard/web-ui";
import css from "./labels.css";

function Field({ title, ...input }: ComponentProps<"input"> & { title: string; "data-f": string }) {
  return (
    <label className="lb-f">
      <span>{title}</span>
      <In {...input} autoComplete="off" />
    </label>
  );
}

export const createLabels = ((app) => {
  const names = personal(app, FLEET_PREFIX, () => app.changed(), "global");
  const nameAt = (address: string) => labelOf(names.get<Labels>(LABELS), address);
  const shown = (address: string, plain: Shown): Shown => {
    const text = nameAt(address);
    return text ? { text, human: true } : plain;
  };

  // поля берут имена один раз: окно раньше ответа prefs показало бы пустое, и «Сохранить» стёрло бы записанное
  const LabelsWindow = (props: ScreenProps) => (app.use(() => names.ready()) ? <NamesForm {...props} /> : null);

  function NamesForm({ params, close = () => app.back() }: ScreenProps) {
    const callsign = params.callsign ?? "";
    const machine = params.machine ?? machineOf(callsign) ?? "";
    const [sessionName, setSessionName] = useState(nameAt(callsign) ?? "");
    const [machineName, setMachineName] = useState(nameAt(`@${machine}`) ?? "");
    const save = () => {
      names.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, sessionName) : old, `@${machine}`, machineName));
      close();
    };
    const onKeyDown = (e: { key: string }) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") close();
    };
    return (
      <div className={`lb-veil${app.wide ? "" : " narrow"}`} onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="lb-dlg" role="dialog" aria-label="Имена">
          <b>Имена</b>
          <div className="lb-a">{callsign || `@${machine}`}</div>
          {callsign ? <Field title="Имя сессии" data-f="session" placeholder={nameOf(callsign)} value={sessionName} onInput={(e) => setSessionName(e.currentTarget.value)} onKeyDown={onKeyDown} autoFocus /> : null}
          <Field title="Имя машины" data-f="machine" placeholder={`@${machine}`} value={machineName} onInput={(e) => setMachineName(e.currentTarget.value)} onKeyDown={onKeyDown} autoFocus={!callsign} />
          <div className="lb-ft">
            <Btn onClick={close}>Отмена</Btn>
            <Btn pri data-act="save" onClick={save}>
              Сохранить
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  return {
    css,
    screens: { labels: { label: "Имена", view: LabelsWindow } },
    marks: {
      "label.session": (callsign: string) => shown(callsign, plainSession(callsign)),
      "label.machine": (machine: string) => shown(`@${machine}`, plainMachine(machine)),
    },
    on: { link: names.onLink },
    stop: names.stop,
  };
}) satisfies AppPart["module"];
