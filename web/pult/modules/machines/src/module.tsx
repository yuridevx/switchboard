// pult-machines — машины флота. Ответы keeper'ов — у настроек; здесь только какие машины видели и когда ушли.
import { machineOf } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import { createStore, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import css from "./machines.css";
import { MachinesScreen } from "./screen.tsx";

export type MachinesState = ReturnType<typeof createMachinesState>;

function createMachinesState(app: App) {
  /** seen — сессий у машины, какой её видели последний раз; gone — ушла при открытой странице; ledger — ответ журнала о прежнем уходе */
  const s = createStore({ seen: {} as Record<string, number>, gone: {} as Record<string, number>, ledger: {} as Record<string, number> }, app.changed);
  const asked = new Set<string>();

  function onRoster(r: Roster) {
    s.set((d) => {
      const online = new Set(r.machines.map((m) => m.machine));
      for (const m of online) {
        d.seen[m] = r.sessions.filter((x) => machineOf(x.callsign) === m).length;
        delete d.gone[m];
        delete d.ledger[m];
        asked.delete(m);
      }
      for (const m of Object.keys(d.seen)) if (!online.has(m)) d.gone[m] ??= Date.now();
    });
  }

  /** Журнал спрашивается один раз и только о машине, что ушла раньше этой страницы. */
  async function readLeft(machine: string) {
    if (!machine || asked.has(machine) || s.get().gone[machine] !== undefined) return;
    asked.add(machine);
    const r = await app.read<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine, limit: 1 });
    const last = r.ok ? r.result.events[0] : undefined;
    if (last?.ev === "machine.left") s.set((d) => void (d.ledger[machine] = last.t));
  }

  return { get: s.get, onRoster, readLeft };
}

export function createMachines(app: App): AppModule {
  const machines = createMachinesState(app);
  return {
    state: machines,
    on: { roster: machines.onRoster },
    screens: {
      machines: { nav: "Машины", group: "Флот", label: "Машины", view: MachinesScreen, head: () => ({ title: "Машины" }) },
    },
    commands: { "machines.left.read": { run: (p) => void machines.readLeft(p.machine) } },
    marks: {
      "machines.gone": () => machines.get().gone,
      "machines.left": (m) => machines.get().gone[m] ?? machines.get().ledger[m],
    },
    css,
  };
}
