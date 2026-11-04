// Состояние машин: ответы keeper и ушедшие машины. Roster их больше не несёт — помнит, пока страница открыта.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, type MachineAnswer, type OutcomeNote, useModule, okOf } from "@switchboard/web-ui";
import type { KeeperState, KeeperPart } from "../../settings/contract.ts";

export type { KeeperState };
export type Part = KeeperPart;
export type KeeperReply = MachineAnswer<KeeperState>;
/** Состояние строки: на связи, сбой части, ушла. */
export type Mst = "ok" | "fail" | "gone";

type State = {
  /** машины последнего roster: какой не стало — ушла */
  seen: Record<string, true>;
  /** машина ушла из roster, пока страница открыта: когда */
  gone: Record<string, number>;
};

/** Ответ keeper, если он без отказа. */

export function stateOf(m: string, states: Readonly<Record<string, KeeperReply>>, gone: State["gone"]): Mst {
  if (gone[m] !== undefined) return "gone";
  return (okOf(states[m])?.parts ?? []).some((p) => p.state === "failed") ? "fail" : "ok";
}

const NONE: Readonly<Record<string, KeeperReply>> = {};

export type MachinesStore = ReturnType<typeof createMachinesStore>;
/** Стор модуля в экранах. */
export const useMachines = (): MachinesStore => useModule<MachinesStore>();

export function createMachinesStore(app: App) {
  const store = createStore<State>({ seen: {}, gone: {} }, () => app.changed());

  return {
    onRoster(r: Roster) {
      const now = new Set(r.machines.map((m) => m.machine));
      store.set((s) => {
        for (const m of Object.keys(s.seen)) if (!now.has(m) && s.gone[m] === undefined) s.gone[m] = Date.now();
        for (const m of r.machines) {
          delete s.gone[m.machine];
          s.seen[m.machine] = true;
        }
      });
    },
    /** Экран открыт: спросить keeper всех машин; возврат — экран закрыт. */
    mount() {
      app.run("keeper.open");
      return () => app.run("keeper.close");
    },
    /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
    async restart(m: string, part: string): Promise<OutcomeNote> {
      const off = await app.request("releases.set", { machine: m, part, on: false });
      if (!off.ok) return { text: `releases.set: ${off.error}`, tone: "bad" };
      const on = await app.request("releases.set", { machine: m, part, on: true });
      if (!on.ok) return { text: `releases.set: ${on.error}`, tone: "bad" };
      app.run("keeper.reload", { machine: m });
      return { text: "выключена и включена по плану", tone: "ok" };
    },
    /** Ответы keeper'ов — у владельца, модуля настроек; своей копии нет. */
    states: () => app.mark("keeper.answers") ?? NONE,
    gone: () => store.get().gone,
  };
}
