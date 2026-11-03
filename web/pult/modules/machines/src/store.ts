// Состояние машин: ответы keeper, итоги перезапуска и ушедшие машины. Roster их больше не несёт — помнит, пока страница открыта.
import type { App, Roster } from "@switchboard/web-core";
import { createStore } from "@switchboard/web-ui";

export type Part = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
export type KeeperState = { keeper?: string; rev?: number; os?: string; parts?: Part[] };
export type KeeperReply = KeeperState | { error: string };
/** Состояние строки: на связи, сбой части, ушла. */
export type Mst = "ok" | "fail" | "gone";
type Notice = { text: string; tone: "ok" | "bad" | "wait" | undefined };

type State = {
  states: Record<string, KeeperReply>;
  notes: Record<string, Notice>;
  /** since машины в последнем roster: вернулась — keeper спрашиваем заново */
  seen: Record<string, number>;
  /** машина ушла из roster, пока страница открыта: когда */
  gone: Record<string, number>;
  /** сколько экранов открыто: при открытом экране вернувшейся машине спрашиваем keeper */
  opened: number;
};

/** Ответ keeper, если он без отказа. */
export const okOf = (st: KeeperReply | null | undefined): KeeperState | null => (st && !("error" in st) ? st : null);

export function stateOf(m: string, states: State["states"], gone: State["gone"]): Mst {
  if (gone[m] !== undefined) return "gone";
  return (okOf(states[m])?.parts ?? []).some((p) => p.state === "failed") ? "fail" : "ok";
}

export type MachinesStore = ReturnType<typeof createMachinesStore>;

export function createMachinesStore() {
  let app: App;
  const store = createStore<State>({ states: {}, notes: {}, seen: {}, gone: {}, opened: 0 }, () => app.changed());

  /** Keeper машины отвечает сам, даже когда Host мёртв. */
  async function load(m: string) {
    const r = await app.request<KeeperState>("keeper.state", { to: `.keeper@${m}` });
    store.set((s) => void (s.states[m] = r.ok ? r.result : { error: r.error }));
  }

  const note = (k: string, text: string, tone?: "ok" | "bad") => store.set((s) => void (s.notes[k] = { text, tone }));

  return {
    start(a: App) {
      app = a;
    },
    onRoster(r: Roster) {
      const now = new Set(r.machines.map((m) => m.machine));
      const ask: string[] = [];
      store.set((s) => {
        for (const m of Object.keys(s.seen)) if (!now.has(m) && s.gone[m] === undefined) s.gone[m] = Date.now();
        for (const m of r.machines) {
          delete s.gone[m.machine];
          // вернулась (since другой) или впервые появилась — при открытом экране спросить её keeper
          if (s.opened > 0 && s.seen[m.machine] !== m.since) ask.push(m.machine);
          s.seen[m.machine] = m.since;
        }
      });
      for (const m of ask) void load(m);
    },
    /** Экран открыт: спросить keeper всех машин; возврат — экран закрыт. */
    mount(): () => void {
      store.set((s) => void s.opened++);
      for (const m of app.roster()?.machines ?? []) void load(m.machine);
      return () => store.set((s) => void s.opened--);
    },
    /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
    async restart(m: string, part: string) {
      const k = `part:${m}:${part}`;
      note(k, "Перезапускаю…");
      const off = await app.request("releases.set", { machine: m, part, on: false });
      if (!off.ok) return note(k, `releases.set: ${off.error}`, "bad");
      const on = await app.request("releases.set", { machine: m, part, on: true });
      if (!on.ok) return note(k, `releases.set: ${on.error}`, "bad");
      note(k, "выключена и включена по плану", "ok");
      void load(m);
    },
    states: () => store.get().states,
    gone: () => store.get().gone,
    note: (k: string) => store.get().notes[k] ?? null,
  };
}
