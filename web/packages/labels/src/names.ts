// Имена сессий и машин: запись области флота fleet.labels, одна на всех и на агентов. Запись идёт циклом настроек модуля.
import type { App } from "@switchboard/web-core";
import { personal, plainMachine, plainSession, useModule, type Shown } from "@switchboard/web-ui";
import { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "@switchboard/records";

export type { Shown };
export type Names = ReturnType<typeof createNames>;
export const useNames = (): Names => useModule<Names>();

export function createNames(app: App) {
  const cycle = personal(app, FLEET_PREFIX, () => app.changed(), "global");
  const nameOf = (address: string) => labelOf(cycle.get<Labels>(LABELS), address);
  /** Заданное имя с отметкой human, иначе короткий адрес. */
  const shown = (address: string, plain: () => Shown): Shown => {
    const text = nameOf(address);
    return text ? { text, human: true } : plain();
  };

  return {
    onLink: cycle.onLink,
    stop: cycle.stop,
    nameOf: (address: string) => nameOf(address) ?? "",
    /** Записать имена окна: без сессии — только имя машины. */
    save(callsign: string, machine: string, sessionName: string, machineName: string) {
      cycle.edit<Labels>(LABELS, (old) => setLabel(callsign ? setLabel(old, callsign, sessionName) : old, `@${machine}`, machineName));
    },
    session: (callsign: string) => shown(callsign, () => plainSession(callsign)),
    machine: (machine: string) => shown(`@${machine}`, () => plainMachine(machine)),
  };
}
