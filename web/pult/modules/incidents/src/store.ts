// Состояние инцидентов: недоставленные обращения по машинам и отказы чтения. Сессии с инцидентом — из roster, здесь их нет.
import type { App, SessionRecord } from "@switchboard/web-core";
import { createStore, type JournalAnswer, machinesWith, midnight, useModule, incidentOf } from "@switchboard/web-ui";

export type Lost = { machine: string; id: string; word: string; why: string; t: string };
export type Inc = { type: string; key?: string };

type State = {
  /** недоставленные по машинам: последняя строка отказа на обращение */
  lost: Record<string, Lost[]>;
  refused: Record<string, string>;
  /** машины, чей журнал уже прочитан: новая в roster — дочитать её */
  asked: Record<string, true>;
};

export const incOf = (s: SessionRecord): Inc | null => {
  const x = incidentOf(s);
  return x && typeof x.type === "string" ? (x as Inc) : null;
};
export const isOpen = (s: SessionRecord) => s.state !== "stopped";

export type IncidentsStore = ReturnType<typeof createIncidentsStore>;
/** Стор модуля в экранах. */
export const useIncidents = (): IncidentsStore => useModule<IncidentsStore>();

export function createIncidentsStore(app: App) {
  const store = createStore<State>({ lost: {}, refused: {}, asked: {} }, () => app.changed());

  /** Машины с инцидентами и журналом. */
  const machines = () => machinesWith(app, "incident", "machine.journal");

  async function loadMachine(m: string) {
    store.set((s) => void (s.asked[m] = true));
    const r = await app.request<JournalAnswer>("machine.journal", { machine: m, since: midnight(), kind: ["refuse"], limit: 200 });
    if (!r.ok) return store.set((s) => void (s.refused[m] = r.error));
    // недоставленные — отказы, чьё обращение ещё на диске без сессии: доставленное потом уходит из списка само
    const p = await app.request<{ appeals: Array<{ id: string; callsign: string | null }> }>("incident.pending", { machine: m });
    if (!p.ok) return store.set((s) => void (s.refused[m] = `incident.pending: ${p.error}`));
    const waiting = new Set(p.result.appeals.filter((a) => !a.callsign).map((a) => a.id));
    const byId = new Map<string, Lost>();
    for (const x of r.result.records) if (x.ev === "incident" && x.id && waiting.has(x.id)) byId.set(x.id, { machine: m, id: x.id, word: x.word ?? "", why: x.why ?? "", t: x.t });
    store.set((s) => {
      delete s.refused[m];
      s.lost[m] = [...byId.values()].reverse();
    });
  }

  const load = (only: string[] = machines()) => Promise.all(only.map(loadMachine));
  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => incOf(s));
  const allLost = () => Object.values(store.get().lost).flat();

  return {
    load,
    sessions,
    allLost,
    refused: () => store.get().refused,
    /** Машина впервые в roster — её недоставленные для метки раздела. */
    onRoster() {
      const fresh = machines().filter((m) => !store.get().asked[m]);
      if (fresh.length) void load(fresh);
    },
    openCount: () => sessions().filter(isOpen).length + allLost().length,
  };
}
