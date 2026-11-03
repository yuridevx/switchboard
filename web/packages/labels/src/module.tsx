// web-labels — человеческие имена сессий и машин: настройка пользователя (у почты, ключ web-labels.names), другие люди флота их не видят.
// Имя заменяет адрес в интерфейсе: метки label.session и label.machine; адрес в протоколе, журнале и у модели не меняется.
// Окно «Имена» — экран labels в месте вызывающего (app.Slot): закрылось — вызывающий получает close.
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Btn, personal, type Personal } from "@switchboard/web-ui";
import css from "./labels.css";

export type Shown = { text: string; human: boolean };
type Names = { sessions?: Record<string, string>; machines?: Record<string, string> };

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createLabels(): AppModule {
  let app: App;
  let p: Personal;
  const names = () => p?.get<Names>("names") ?? {};

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
      p.edit<Names>("names", (old) => {
        const sessions = { ...old?.sessions };
        const machines = { ...old?.machines };
        if (callsign) {
          if (s) sessions[callsign] = s;
          else delete sessions[callsign];
        }
        if (m) machines[machine] = m;
        else delete machines[machine];
        return { sessions, machines };
      });
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
              <input ref={session} data-f="session" defaultValue={names().sessions?.[callsign] ?? ""} placeholder={callsign.slice(0, callsign.indexOf("@"))} autoComplete="off" onKeyDown={keys} />
            </label>
          ) : null}
          <label className="lb-f">
            <span>Имя машины</span>
            <input ref={host} data-f="machine" defaultValue={names().machines?.[machine] ?? ""} placeholder={`@${machine}`} autoComplete="off" onKeyDown={keys} />
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
        const name = names().sessions?.[callsign];
        return { text: name ?? callsign.slice(0, callsign.indexOf("@")), human: !!name };
      },
      "label.machine": (machine: string): Shown => {
        const name = names().machines?.[machine];
        return { text: name ?? `@${machine}`, human: !!name };
      },
    },
    css,
    start(a) {
      app = a;
      p ??= personal(app, "web-labels", () => app.changed());
    },
    async stop() {
      await p?.settled();
    },
  };
}
