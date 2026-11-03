// web-labels — человеческие имена сессий и машин: запись области флота fleet.labels, одна на всех и на агентов; формат — у records.
// Имя заменяет адрес в интерфейсе: метки label.session и label.machine; адрес в протоколе, журнале и у агентов остаётся адресом.
// Окно «Имена» — экран labels в месте вызывающего (app.Slot): закрылось — вызывающий получает close.
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Btn, personal, type Personal } from "@switchboard/web-ui";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";
import css from "./labels.css";

export type Shown = { text: string; human: boolean };

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createLabels(): AppModule {
  let app: App;
  let p: Personal;
  const names = () => p?.get<Labels>(LABELS);

  function Labels({ params, close }: ScreenProps) {
    const callsign = params.callsign ?? "";
    const machine = params.machine ?? machineOf(callsign) ?? "";
    const session = useRef<HTMLInputElement>(null);
    const host = useRef<HTMLInputElement>(null);
    const done = () => close?.();
    useEffect(() => (session.current ?? host.current)?.focus(), []);
    const save = () => {
      const s = session.current?.value.trim() ?? "";
      const m = host.current?.value.trim() ?? "";
      p.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, s) : old, `@${machine}`, m));
      done();
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") done();
    };
    return (
      <div className={"lb-veil" + (app.wide ? "" : " narrow")} onClick={(e) => e.target === e.currentTarget && done()}>
        <div className="lb-dlg" role="dialog" aria-label="Имена">
          <b>Имена</b>
          <div className="lb-a">{callsign || `@${machine}`}</div>
          {callsign ? (
            <label className="lb-f">
              <span>Имя сессии</span>
              <input ref={session} data-f="session" defaultValue={labelOf(names(), callsign) ?? ""} placeholder={callsign.slice(0, callsign.indexOf("@"))} autoComplete="off" onKeyDown={keys} />
            </label>
          ) : null}
          <label className="lb-f">
            <span>Имя машины</span>
            <input ref={host} data-f="machine" defaultValue={labelOf(names(), `@${machine}`) ?? ""} placeholder={`@${machine}`} autoComplete="off" onKeyDown={keys} />
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

  return {
    on: {
      link(state) {
        if (state === "open") void p.read();
      },
    },
    screens: { labels: { label: "Имена", path: "labels", view: Labels } },
    marks: {
      "label.session": (callsign: string): Shown => {
        const name = labelOf(names(), callsign);
        return { text: name ?? callsign.slice(0, callsign.indexOf("@")), human: !!name };
      },
      "label.machine": (machine: string): Shown => {
        const name = labelOf(names(), `@${machine}`);
        return { text: name ?? `@${machine}`, human: !!name };
      },
    },
    css,
    start(a) {
      app = a;
      p ??= personal(app, FLEET_PREFIX, () => app.changed(), "global");
    },
    async stop() {
      await p?.settled();
    },
  };
}
