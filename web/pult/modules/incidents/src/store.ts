// Недоставленные обращения по машинам: что ждёт на диске Host, с последним отказом доставки.
import { machineAnswers, machinesWith, okOf, type App } from "@switchboard/web-ui";
import type { ConnState, Roster } from "@switchboard/web-core";

/** Обращение на диске Host; word, why, t — последний отказ доставки. */
export type Pending = { id: string; type?: string; key?: string | null; callsign?: string | null; word?: string; why?: string; t?: string };
export type Lost = { machine: string; appeal: Pending };

export function createStore(app: App) {
  const answers = machineAnswers<{ appeals: Pending[] }>(
    app,
    (machine) => app.read("incident.pending", { machine }),
    () => machinesWith(app, "incident"),
  );
  /** метке нужны ответы и при закрытом экране: новая машина спрашивается один раз */
  const asked = new Set<string>();

  /** Новые обращения сверху; обращение, ушедшее в сессию, — не недоставленное. */
  function lost(): Lost[] {
    const all = answers.get();
    return Object.keys(all).flatMap((machine) =>
      (okOf(all[machine])?.appeals ?? [])
        .filter((appeal) => !appeal.callsign)
        .map((appeal) => ({ machine, appeal }))
        .reverse(),
    );
  }

  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => s.incident);

  return {
    answers,
    lost,
    sessions,
    openCount: () => sessions().filter((s) => s.state !== "stopped").length + lost().length,
    onRoster(_r: Roster) {
      for (const machine of machinesWith(app, "incident")) {
        if (asked.has(machine)) continue;
        asked.add(machine);
        void answers.reload(machine);
      }
    },
    onLink: (state: ConnState, machine?: string) => answers.onLink(state, machine),
  };
}

export type IncidentsStore = ReturnType<typeof createStore>;
