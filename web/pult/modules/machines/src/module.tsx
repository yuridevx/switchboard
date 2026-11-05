// pult-machines — машины флота строками: лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры.
// Строка раскрывается в карточку: части по ответу keeper (keeper.state), перезапуск упавшей части планом.
// Здесь — только связка с ядром; состояние — state.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import css from "./machines.css";
import { MachinesScreen } from "./screen.tsx";
import { createMachinesState } from "./state.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createMachines(app: App): AppModule {
  const machines = createMachinesState(app);
  return {
    state: machines,
    on: { roster: machines.onRoster },
    commands: { "machines.left.read": { run: (p) => void machines.readLeft(p.machine ?? "") } },
    screens: { machines: { nav: "Машины", group: "Флот", label: "Машины", view: MachinesScreen, head: () => ({ title: "Машины" }) } },
    marks: { "machines.gone": machines.gone, "machines.left": machines.left },
    css,
  };
}
