// pult-machines — машины флота: какие видели и когда, их порядок и состояние, встроенный экран частей. Ответы keeper'ов — у настроек. ушли.
import { machineOf } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import { createStore, machinesWith, okOf, type App, type OutcomeNote } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import css from "./machines.css";
import type { KeeperAnswers } from "../../settings/contract.ts";
import { MachineParts } from "./screen.tsx";

/** Строка машины: на связи, сбой части или ушла (когда). */
export type MachineRowInfo = { machine: string; state: "ok" | "fail" | "gone"; at?: number };

export type MachinesState = ReturnType<typeof createMachinesState>;

function createMachinesState(app: App) {
  /** seen — сессий у машины, какой её видели последний раз; gone — ушла при открытой странице; ledger — ответ журнала о прежнем уходе */
  const s = createStore({ seen: {} as Record<string, number>, gone: {} as Record<string, number>, ledger: {} as Record<string, number>, notes: {} as Record<string, OutcomeNote> }, app.changed);
  const restarting = new Set<string>();
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

  /** Сначала со сбоем, потом остальные по имени. */
  function rows(): MachineRowInfo[] {
    const { gone } = s.get();
    const answers = (app.mark("keeper.answers") as KeeperAnswers | undefined)?.get() ?? {};
    const names = [...new Set([...machinesWith(app), ...Object.keys(gone)])];
    const failing = (m: string) => (okOf(answers[m])?.parts ?? []).some((p) => p.state === "failed");
    return names
      .map((machine): MachineRowInfo => (gone[machine] !== undefined ? { machine, state: "gone", at: gone[machine] } : { machine, state: failing(machine) ? "fail" : "ok" }))
      .sort((a, b) => Number(b.state === "fail") - Number(a.state === "fail") || a.machine.localeCompare(b.machine));
  }

  /** Перезапуск упавшей части планом машины: выключить и включить. Итог живёт у строки: свёртка карточки его не теряет. */
  async function restart(machine: string, part: string) {
    const key = `${machine}:${part}`;
    if (restarting.has(key)) return;
    restarting.add(key);
    const say = (text: string, tone?: OutcomeNote["tone"]) => s.set((d) => void (d.notes[key] = { text, tone }));
    say("Перезапускаю…");
    for (const on of [false, true]) {
      const r = await app.request("releases.set", { machine, part, on });
      if (!r.ok) {
        restarting.delete(key);
        say(`releases.set: ${r.error}`, "bad");
        return;
      }
    }
    restarting.delete(key);
    say("выключена и включена по плану", "ok");
    app.run("keeper.reload", { machine });
  }

  return { get: s.get, onRoster, readLeft, rows, restart };
}

export function createMachines(app: App): AppModule {
  const machines = createMachinesState(app);
  return {
    state: machines,
    on: { roster: machines.onRoster },
    screens: {
      "machine.parts": { label: "Части машины", path: "machine-parts", view: MachineParts },
    },
    commands: { "machines.left.read": { run: (p) => void machines.readLeft(p.machine) } },
    marks: {
      "machines.rows": () => machines.rows(),
      "machines.gone": () => machines.get().gone,
      "machines.left": (m) => machines.get().gone[m] ?? machines.get().ledger[m],
    },
    css,
  };
}
