// pult-machines — машины флота строками: лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры.
// Строка раскрывается в карточку: части по ответу keeper (keeper.state), перезапуск упавшей части планом.
// Каждая цифра — ответ keeper, машины или roster. Здесь — только связка с ядром; состояние — store.ts, вид — компоненты.
import type { AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import { MachinesCtx } from "./context.ts";
import css from "./machines.css";
import { MachinesScreen } from "./MachinesScreen.tsx";
import { createMachinesStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createMachines(): AppModule {
  const machines = createMachinesStore();
  return {
    on: { roster: machines.onRoster },
    screens: {
      machines: {
        nav: "Машины",
        group: "Флот",
        label: "Машины",
        view: () => (
          <MachinesCtx.Provider value={machines}>
            <MachinesScreen />
          </MachinesCtx.Provider>
        ),
        head: () => ({ title: "Машины" }),
      },
    },
    css,
    start: machines.start,
  };
}
