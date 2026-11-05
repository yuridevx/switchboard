// Реестр глазами страницы: обзор флота читается один раз при первом roster и заново при открытии экрана и после действий.
import type { Roster } from "@switchboard/web-core";
import { type App, createStore } from "@switchboard/web-ui";

export type Listed = { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number };
export type Fleet = { sessions: Listed[]; r2: { bytes?: number; blocks?: number }; sweep?: { at: number; blocks: number; bytes: number } | null };

type State = { fleet?: Fleet; error: string; moving: boolean };

export type PointsStore = ReturnType<typeof pointsStore>;

export function pointsStore(app: App) {
  const s = createStore<State>({ error: "", moving: false }, () => app.changed());
  let turn = 0;
  let asked = false;

  async function read(): Promise<void> {
    const mine = ++turn;
    const r = await app.read<Fleet>("points.list");
    if (mine !== turn) return;
    s.set((d) => {
      d.error = r.ok ? "" : r.error;
      if (r.ok) d.fleet = r.result;
    });
  }

  return {
    get: s.get,
    read,
    roster(_r: Roster): void {
      if (!asked) {
        asked = true;
        void read();
      }
    },
    moving(on: boolean): void {
      s.set((d) => void (d.moving = on));
    },
    /** Машины с сессиями в R2, которых нет в roster. */
    fire(): string[] {
      const online = new Set((app.roster()?.machines ?? []).map((m) => m.machine));
      return [...new Set((s.get().fleet?.sessions ?? []).map((x) => x.owner).filter((m) => !online.has(m)))];
    },
  };
}
