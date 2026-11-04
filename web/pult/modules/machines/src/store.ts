// Состояние машин: ответы keeper, итоги перезапуска и ушедшие машины. Roster их больше не несёт — помнит, пока страница открыта.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, type MachineAnswer, useModule, okOf } from "@switchboard/web-ui";
import type { KeeperState, KeeperPart } from "../../settings/contract.ts";

export type { KeeperState };
export type Part = KeeperPart;
export type KeeperReply = MachineAnswer<KeeperState>;
/** Состояние строки: на связи, сбой части, ушла. */
export type Mst = "ok" | "fail" | "gone";
type Notice = { text: string; tone: "ok" | "bad" | "wait" | undefined };

type State = {
  notes: Record<string, Notice>;
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
  /** Ответы keeper'ов — у владельца, модуля настроек; своей копии нет. */
  const keeper = () => app.mark("keeper.answers");
  const store = createStore<State>({ notes: {}, seen: {}, gone: {} }, () => app.changed());

  const note = (k: string, text: string, tone?: "ok" | "bad") => store.set((s) => void (s.notes[k] = { text, tone }));

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
    mount: () => keeper()?.mount() ?? (() => {}),
    /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
    async restart(m: string, part: string) {
      const k = `part:${m}:${part}`;
      note(k, "Перезапускаю…");
      const off = await app.request("releases.set", { machine: m, part, on: false });
      if (!off.ok) return note(k, `releases.set: ${off.error}`, "bad");
      const on = await app.request("releases.set", { machine: m, part, on: true });
      if (!on.ok) return note(k, `releases.set: ${on.error}`, "bad");
      note(k, "выключена и включена по плану", "ok");
      if (keeper()) app.open("keeper.reload", { machine: m });
    },
    states: () => keeper()?.get() ?? NONE,
    gone: () => store.get().gone,
    note: (k: string) => store.get().notes[k] ?? null,
  };
}
