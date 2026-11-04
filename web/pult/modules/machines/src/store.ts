// Состояние машин: ответы keeper и ушедшие машины. Roster их больше не несёт — помнит, пока страница открыта.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, type MachineAnswer, type Result, useModule, okOf } from "@switchboard/web-ui";
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
  /** машина ушла раньше открытия страницы: время из журнала флота, ответ на machines.left.read */
  earlier: Record<string, number>;
  /** журнал о машине уже спрошен: вернулась — забыто */
  asked: Record<string, true>;
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
  const store = createStore<State>({ seen: {}, gone: {}, earlier: {}, asked: {} }, () => app.changed());

  return {
    onRoster(r: Roster) {
      const now = new Set(r.machines.map((m) => m.machine));
      store.set((s) => {
        for (const m of Object.keys(s.seen)) if (!now.has(m) && s.gone[m] === undefined) s.gone[m] = Date.now();
        for (const m of r.machines) {
          delete s.gone[m.machine];
          delete s.earlier[m.machine];
          delete s.asked[m.machine];
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
    async restart(m: string, part: string): Promise<Result<string>> {
      const off = await app.request("releases.set", { machine: m, part, on: false });
      if (!off.ok) return { ok: false, error: `releases.set: ${off.error}` };
      const on = await app.request("releases.set", { machine: m, part, on: true });
      if (!on.ok) return { ok: false, error: `releases.set: ${on.error}` };
      app.run("keeper.reload", { machine: m });
      return { ok: true, result: "выключена и включена по плану" };
    },
    /** Ответы keeper'ов — у владельца, модуля настроек; своей копии нет. */
    states: () => app.mark("keeper.answers") ?? NONE,
    gone: () => store.get().gone,
    /** Метка machines.left: когда машина ушла. Видели уход на этой странице — наше время, иначе журнал флота. */
    left: (m: string): number | undefined => store.get().gone[m] ?? store.get().earlier[m],
    /** Команда machines.left.read: спросить журнал о машине один раз, пока она не вернулась. */
    async readLeft(m: string) {
      const s = store.get();
      if (!m || s.asked[m] || s.gone[m] !== undefined) return;
      store.set((x) => void (x.asked[m] = true));
      const j = await app.request<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine: m, limit: 1 });
      const e = j.ok ? j.result.events.find((x) => x.ev === "machine.left") : undefined;
      if (e) store.set((x) => void (x.earlier[m] = e.t));
    },
  };
}
