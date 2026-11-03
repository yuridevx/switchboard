// Имена сессий и машин: запись области флота fleet.labels, одна на всех и на агентов. Цикл записи — personal из web-ui.
import type { App } from "@switchboard/web-core";
import { personal, type Personal } from "@switchboard/web-ui";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";

export type Shown = { text: string; human: boolean };

export type LabelsStore = ReturnType<typeof createLabelsStore>;

export function createLabelsStore() {
  let app: App;
  let p: Personal;
  const names = () => p?.get<Labels>(LABELS);

  return {
    start(a: App) {
      app = a;
      p ??= personal(app, FLEET_PREFIX, () => app.changed(), "global");
    },
    settled: () => p?.settled(),
    onLink(state: string) {
      if (state === "open") void p.read();
    },
    /** Заданное имя адреса или пусто: начальное значение окна. */
    nameOf: (address: string) => labelOf(names(), address) ?? "",
    /** Сохранить имена: callsign пуст — окно только машины. */
    save(callsign: string, machine: string, sessionName: string, machineName: string) {
      p.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, sessionName) : old, `@${machine}`, machineName));
    },
    session(callsign: string): Shown {
      const name = labelOf(names(), callsign);
      return { text: name ?? callsign.slice(0, callsign.indexOf("@")), human: !!name };
    },
    machine(machine: string): Shown {
      const name = labelOf(names(), `@${machine}`);
      return { text: name ?? `@${machine}`, human: !!name };
    },
  };
}
