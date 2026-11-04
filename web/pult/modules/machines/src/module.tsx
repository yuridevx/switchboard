// pult-machines — машины флота строками: лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры.
// Строка раскрывается в карточку: части по ответу keeper (keeper.state), перезапуск упавшей части планом.
// Каждая цифра — ответ keeper, машины или roster. Здесь — только связка с ядром; состояние — store.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import css from "./machines.css";
import { MachinesScreen } from "./MachinesScreen.tsx";
import { createMachinesStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createMachines(app: App): AppModule {
  const machines = createMachinesStore(app);
  return {
    state: machines,
    on: { roster: machines.onRoster },
    screens: {
      machines: {
        nav: "Машины",
        group: "Флот",
        label: "Машины",
        view: MachinesScreen,
        head: () => ({ title: "Машины" }),
      },
    },
    css,
  };
}
