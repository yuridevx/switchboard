// Состояние машин: ушедшие машины. Roster их больше не несёт — помнит, пока страница открыта; ответы keeper — у владельца, модуля настроек.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, type MachineAnswer, okOf, type Result, useModule } from "@switchboard/web-ui";
import type { KeeperPart, KeeperState } from "../../settings/contract.ts";

export type Part = KeeperPart;
type KeeperReply = MachineAnswer<KeeperState>;
/** Состояние строки: на связи, сбой части, ушла. */
export type MachineCondition = "ok" | "fail" | "gone";

type State = {
  /** машины последнего roster: какой не стало — ушла */
  seen: Record<string, true>;
  /** машина ушла из roster, пока страница открыта: когда */
  gone: Record<string, number>;
  /** машина ушла раньше открытия страницы: время из журнала флота */
  earlier: Record<string, number>;
  /** журнал о машине уже спрошен: вернулась — забыто */
  asked: Record<string, true>;
};

const NO_ANSWERS: Readonly<Record<string, KeeperReply>> = {};

export function conditionOf(m: string, answers: Readonly<Record<string, KeeperReply>>, gone: State["gone"]): MachineCondition {
  if (gone[m] !== undefined) return "gone";
  return (okOf(answers[m])?.parts ?? []).some((p) => p.state === "failed") ? "fail" : "ok";
}

export type MachinesState = ReturnType<typeof createMachinesState>;
export const useMachines = (): MachinesState => useModule<MachinesState>();

export function createMachinesState(app: App) {
  const store = createStore<State>({ seen: {}, gone: {}, earlier: {}, asked: {} }, () => app.changed());

  return {
    onRoster(r: Roster) {
      const now = new Set(r.machines.map((m) => m.machine));
      store.set((s) => {
        for (const m of Object.keys(s.seen)) if (!now.has(m) && s.gone[m] === undefined) s.gone[m] = Date.now();
        for (const { machine } of r.machines) {
          delete s.gone[machine];
          delete s.earlier[machine];
          delete s.asked[machine];
          s.seen[machine] = true;
        }
      });
    },
    /** Экран открыт: спросить keeper всех машин; возврат — экран закрыт. */
    mount() {
      app.run("keeper.open");
      return () => app.run("keeper.close");
    },
    /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
    async restart(machine: string, part: string): Promise<Result<string>> {
      for (const on of [false, true]) {
        const r = await app.request("releases.set", { machine, part, on });
        if (!r.ok) return { ok: false, error: `releases.set: ${r.error}` };
      }
      app.run("keeper.reload", { machine });
      return { ok: true, result: "выключена и включена по плану" };
    },
    answers: () => app.mark("keeper.answers") ?? NO_ANSWERS,
    gone: () => store.get().gone,
    /** Метка machines.left: видели уход на этой странице — наше время, иначе журнал флота. */
    left: (m: string): number | undefined => store.get().gone[m] ?? store.get().earlier[m],
    /** Команда machines.left.read: спросить журнал о машине один раз, пока она не вернулась. */
    async readLeft(m: string) {
      const s = store.get();
      if (!m || s.asked[m] || s.gone[m] !== undefined) return;
      store.set((x) => void (x.asked[m] = true));
      const j = await app.read<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine: m, limit: 1 });
      const left = j.ok ? j.result.events.find((x) => x.ev === "machine.left") : undefined;
      if (left) store.set((x) => void (x.earlier[m] = left.t));
    },
  };
}
