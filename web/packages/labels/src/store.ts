// Имена сессий и машин: запись области флота fleet.labels, одна на всех и на агентов. Цикл записи — personal из web-ui.
import { nameOf } from "@switchboard/protocol";
import type { App } from "@switchboard/web-core";
import { personal, type Personal, useModule, type Shown } from "@switchboard/web-ui";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";

export type { Shown };

export type LabelsStore = ReturnType<typeof createLabelsStore>;
/** Стор модуля в экранах. */
export const useLabels = (): LabelsStore => useModule<LabelsStore>();

export function createLabelsStore(app: App) {
  const p: Personal = personal(app, FLEET_PREFIX, () => app.changed(), "global");
  const names = () => p.get<Labels>(LABELS);

  return {
    settled: p.settled,
    // имена — у Worker'а: возврат одной машины их не трогает
    onLink(state: string, machine?: string) {
      if (state === "open" && !machine) void p.read();
    },
    /** Заданное имя адреса или пусто: начальное значение окна. */
    nameOf: (address: string) => labelOf(names(), address) ?? "",
    /** Сохранить имена: callsign пуст — окно только машины. */
    save(callsign: string, machine: string, sessionName: string, machineName: string) {
      p.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, sessionName) : old, `@${machine}`, machineName));
    },
    session(callsign: string): Shown {
      const name = labelOf(names(), callsign);
      return { text: name ?? nameOf(callsign), human: !!name };
    },
    machine(machine: string): Shown {
      const name = labelOf(names(), `@${machine}`);
      return { text: name ?? `@${machine}`, human: !!name };
    },
  };
}
