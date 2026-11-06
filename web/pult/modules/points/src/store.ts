// Реестр на странице: обзор флота читается на первом roster, на экране точек и после своих действий; своего состояния сверх ответа нет.
import type { App } from "@switchboard/web-core";
import { createStore } from "@switchboard/web-ui";
import type { PointsListFleet } from "@switchboard/points";

export type Listed = PointsListFleet["sessions"][number];

export function createFleet(app: App) {
  const data = createStore<{ fleet?: PointsListFleet; error: string; moving: boolean }>({ error: "", moving: false }, () => app.changed());
  let asked = false;
  let turn = 0;

  async function read() {
    const mine = ++turn;
    const r = await app.read<PointsListFleet>("points.list");
    if (mine !== turn) return; // ответ опоздал: есть вопрос новее
    data.set((d) => {
      d.error = r.ok ? "" : r.error;
      if (r.ok) d.fleet = r.result;
    });
  }

  const online = () => new Set(app.roster()?.machines.map((m) => m.machine));

  return {
    get: data.get,
    read,
    /** Идёт перенос «пожара»: второй не начать, пока страница открыта. */
    moving: (on: boolean) => data.set((d) => void (d.moving = on)),
    onRoster() {
      if (asked) return;
      asked = true;
      void read();
    },
    /** Машины с сессиями в R2, которых нет в roster. */
    fire(): string[] {
      const on = online();
      return [...new Set((data.get().fleet?.sessions ?? []).map((s) => s.owner))].filter((m) => !on.has(m));
    },
    sidOf: (callsign: string) => data.get().fleet?.sessions.find((s) => s.callsign === callsign),
  };
}

export type Fleet = ReturnType<typeof createFleet>;
