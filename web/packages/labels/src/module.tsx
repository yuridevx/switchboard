// Имена сессий и машин: метки для всех экранов и окно «Имена». Запись — fleet.labels в области флота.
import { useState, type KeyboardEvent } from "react";
import { machineOf, nameOf } from "@switchboard/protocol";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";
import { Btn, In, personal, plainMachine, plainSession, type App, type Shown } from "@switchboard/web-ui";
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import css from "./labels.css";

const TITLE = "Имена";

type FieldProps = { title: string; f: string; hint: string; first: boolean; value: string; set(text: string): void; keys(e: KeyboardEvent): void };

const Field = ({ title, f, hint, first, value, set, keys }: FieldProps) => (
  <label className="lb-f">
    <span>{title}</span>
    <In data-f={f} placeholder={hint} autoComplete="off" autoFocus={first} value={value} onChange={() => {}} onInput={(e) => set(e.currentTarget.value)} onKeyDown={keys} />
  </label>
);

export const createLabels = (app: App): AppModule => {
  const names = personal(app, FLEET_PREFIX, () => app.changed(), "global");
  const nameAt = (to: string) => labelOf(names.get<Labels>(LABELS), to);
  const shown = (to: string, plain: Shown): Shown => {
    const text = nameAt(to);
    return text ? { text, human: true } : plain;
  };

  function Window({ callsign, machine, close }: { callsign?: string; machine: string; close(): void }) {
    const [session, setSession] = useState(() => (callsign && nameAt(callsign)) || "");
    const [host, setHost] = useState(() => nameAt(`@${machine}`) ?? "");
    const save = () => {
      names.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, session) : old, `@${machine}`, host));
      close();
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") close();
    };
    return (
      <div className={app.wide ? "lb-veil" : "lb-veil narrow"} onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="lb-dlg" role="dialog" aria-label={TITLE}>
          <b>{TITLE}</b>
          <div className="lb-a">{callsign ?? `@${machine}`}</div>
          {callsign && <Field title="Имя сессии" f="session" hint={nameOf(callsign)} first value={session} set={setSession} keys={keys} />}
          <Field title="Имя машины" f="machine" hint={`@${machine}`} first={!callsign} value={host} set={setHost} keys={keys} />
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

  function Screen({ params: { callsign, machine }, close = () => app.back() }: ScreenProps) {
    // поля заполняются один раз: окно ждёт ответа, иначе пустые поля стёрли бы записанные имена
    const ready = app.use(() => names.ready());
    const at = machine ?? machineOf(callsign ?? "");
    return ready && at ? <Window callsign={callsign} machine={at} close={close} /> : null;
  }

  return {
    css,
    screens: { labels: { label: TITLE, view: Screen } },
    marks: {
      "label.session": (callsign) => shown(callsign, plainSession(callsign)),
      "label.machine": (machine) => shown(`@${machine}`, plainMachine(machine)),
    },
    on: { link: names.onLink },
    stop: names.stop,
  };
};
