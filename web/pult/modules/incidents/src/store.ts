// Недоставленные обращения по машинам и отказы их чтения. Сессии с инцидентом — из roster, здесь их нет.
import type { App, SessionRecord } from "@switchboard/web-core";
import { createStore, incidentOf, type JournalAnswer, type JournalRecord, machinesWith, midnight, useModule } from "@switchboard/web-ui";

export type Lost = { machine: string; id: string; word: string; why: string; t: string };
export type Incident = { type: string; key?: string };
type Pending = { appeals: Array<{ id: string; callsign: string | null }> };
type State = {
  lost: Record<string, Lost[]>;
  refused: Record<string, string>;
  /** машины, чей журнал уже прочитан */
  asked: Record<string, true>;
};

export const incident = (s: SessionRecord): Incident | null => {
  const x = incidentOf(s);
  return x && typeof x.type === "string" ? (x as Incident) : null;
};
export const isOpen = (s: SessionRecord) => s.state !== "stopped";

/** Недоставленное — отказ доставки, чьё обращение на диске без сессии; у обращения — последний отказ, новые обращения сверху. */
function lostOf(machine: string, records: JournalRecord[], appeals: Pending["appeals"]): Lost[] {
  const waiting = new Set(appeals.filter((a) => !a.callsign).map((a) => a.id));
  const last = new Map<string, Lost>();
  for (const r of records) {
    if (r.ev === "incident" && r.id && waiting.has(r.id)) last.set(r.id, { machine, id: r.id, word: r.word ?? "", why: r.why ?? "", t: r.t });
  }
  return [...last.values()].reverse();
}

export type IncidentsStore = ReturnType<typeof createIncidentsStore>;
export const useIncidents = (): IncidentsStore => useModule<IncidentsStore>();

export function createIncidentsStore(app: App) {
  const store = createStore<State>({ lost: {}, refused: {}, asked: {} }, () => app.changed());

  async function read(machine: string): Promise<void> {
    store.set((s) => void (s.asked[machine] = true));
    const journal = await app.read<JournalAnswer>("machine.journal", { machine, since: midnight(), kind: ["refuse"], limit: 200 });
    if (!journal.ok) return store.set((s) => void (s.refused[machine] = journal.error));
    const pending = await app.read<Pending>("incident.pending", { machine });
    if (!pending.ok) return store.set((s) => void (s.refused[machine] = `incident.pending: ${pending.error}`));
    store.set((s) => {
      delete s.refused[machine];
      s.lost[machine] = lostOf(machine, journal.result.records, pending.result.appeals);
    });
  }

  const machines = () => machinesWith(app, "incident", "machine.journal");
  const load = () => Promise.all(machines().map(read));
  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => incident(s));
  const allLost = () => Object.values(store.get().lost).flat();

  return {
    load,
    sessions,
    allLost,
    refused: () => store.get().refused,
    /** Машина впервые в roster — её недоставленные для метки раздела. */
    onRoster() {
      for (const m of machines()) if (!store.get().asked[m]) void read(m);
    },
    openCount: () => sessions().filter(isOpen).length + allLost().length,
  };
}
