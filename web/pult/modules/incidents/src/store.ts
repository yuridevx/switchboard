// Недоставленные обращения по машинам: ждущие на диске Host (incident.pending) и их последние отказы за сегодня (журнал машины).
import { machineAnswers, machinesWith, midnight, okOf, type App, type JournalRecord } from "@switchboard/web-ui";
import type { ConnState, Roster } from "@switchboard/web-core";

type Pending = { id: string; type?: string; key?: string | null; callsign?: string | null };
type Answer = { records: JournalRecord[]; appeals: Pending[] };
/** Строка «Не доставлены»: last — последний отказ; нет — отказа с полуночи нет. */
export type Lost = { machine: string; id: string; appeal: Pending; last?: JournalRecord };

export function createStore(app: App) {
  async function ask(machine: string) {
    const [journal, pending] = await Promise.all([
      app.read<{ records: JournalRecord[] }>("machine.journal", { machine, kind: ["refuse"], since: midnight(), limit: 200 }),
      app.read<{ appeals: Pending[] }>("incident.pending", { machine }),
    ]);
    if (!journal.ok) return journal;
    if (!pending.ok) return { ok: false as const, error: `incident.pending: ${pending.error}` };
    return { ok: true as const, result: { records: journal.result.records, appeals: pending.result.appeals } };
  }
  const answers = machineAnswers<Answer>(app, ask, () => machinesWith(app, "incident"));
  /** метке нужны ответы и при закрытом экране: новая машина спрашивается один раз */
  const asked = new Set<string>();

  /** Новые обращения сверху; обращение, ушедшее в сессию, — не недоставленное. */
  function lost(): Lost[] {
    const all = answers.get();
    return Object.keys(all).flatMap((machine) => {
      const a = okOf(all[machine]);
      if (!a) return [];
      const refusals = a.records.filter((r) => r.ev === "incident" && r.id);
      return a.appeals
        .filter((p) => !p.callsign)
        .map((appeal) => ({ machine, id: appeal.id, appeal, last: refusals.findLast((r) => r.id === appeal.id) }))
        .reverse();
    });
  }

  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => s.incident);
  const open = () => sessions().filter((s) => s.state !== "stopped");

  return {
    answers,
    lost,
    sessions,
    openCount: () => open().length + lost().length,
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
