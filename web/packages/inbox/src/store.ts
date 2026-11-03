// Состояние «Вам»: только то, что видно по смене roster при открытом приложении — «готово» (busy → idle) и ушедшие машины.
// Карточки выводятся из roster и меток других модулей; очереди и хранилища нет.
import type { App, Params, Roster } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { createStore } from "@switchboard/web-ui";

export type Kind = "q" | "msg" | "fail" | "wait" | "away" | "fire" | "done";
/** Карточка: только простые поля — строка списка перерисовывается, когда изменились они или её выборка. */
export type Item = { kind: Kind; g: 0 | 1 | 2; callsign?: string; machine?: string; at?: number; list?: string; n?: number };

type State = {
  /** прошлый roster: состояния сессий и машины */
  states: Record<string, unknown>;
  machines: string[];
  /** закончили ход, пока их не смотрели */
  done: Record<string, true>;
  /** машины, пропавшие из roster при открытом приложении: когда и её мои сессии */
  gone: Record<string, { at: number; list: string[] }>;
  /** «прочитано» на карточке «готово» — до следующего хода */
  seen: Record<string, true>;
  /** мои сессии по прошлому roster: сессий ушедшей машины в roster уже нет, «моё» о них — отсюда */
  wasMine: Record<string, true>;
};

export type InboxStore = ReturnType<typeof createInboxStore>;

export function createInboxStore() {
  let app: App;
  const store = createStore<State>({ states: {}, machines: [], done: {}, gone: {}, seen: {}, wasMine: {} }, () => app.changed());

  const viewing = (callsign: string) => {
    const c = app.current();
    return !!c && c.params.callsign === callsign && c.screen !== "inbox";
  };
  const mine = (callsign: string) => !!app.mark("mine", callsign);

  function onRoster(r: Roster) {
    const nextMine = Object.fromEntries(r.sessions.filter((s) => mine(s.callsign)).map((s) => [s.callsign, true as const]));
    // кто сейчас смотрит — считается до правки: выборка в правке не ходит в ядро
    const viewed = new Set(r.sessions.filter((s) => viewing(s.callsign)).map((s) => s.callsign));
    store.set((d) => {
      for (const s of r.sessions) {
        const was = d.states[s.callsign];
        if (s.state === "busy" || s.state === "starting" || s.state === "waiting") {
          delete d.done[s.callsign];
          delete d.seen[s.callsign];
        } else if ((was === "busy" || was === "starting") && s.state === "idle" && !viewed.has(s.callsign)) d.done[s.callsign] = true;
      }
      const now = r.machines.map((m) => m.machine);
      for (const m of now) delete d.gone[m];
      for (const m of d.machines) {
        if (!now.includes(m)) d.gone[m] = { at: Date.now(), list: Object.keys(d.states).filter((c) => machineOf(c) === m && d.wasMine[c]) };
      }
      d.wasMine = nextMine;
      d.states = Object.fromEntries(r.sessions.map((s) => [s.callsign, s.state]));
      d.machines = now;
    });
  }

  /** Карточки сейчас: из roster, меток и того, что видно по смене roster. */
  function items(): Item[] {
    const out: Item[] = [];
    const r = app?.roster();
    if (!r) return out;
    const { done, seen, gone } = store.get();
    for (const s of r.sessions) {
      const callsign = s.callsign;
      if (app.mark("asked", callsign)) out.push({ kind: "q", g: 0, callsign });
      else if (app.mark("unread", callsign)) out.push({ kind: "msg", g: 0, callsign });
      if (!mine(callsign)) continue;
      if (s.state === "failed") out.push({ kind: "fail", g: 1, callsign });
      const wait = (s.slot as { wait?: number | null } | null | undefined)?.wait;
      if (typeof wait === "number" && wait > 0) out.push({ kind: "wait", g: 1, callsign, at: wait * 1000 });
      if (s.state === "idle" && done[callsign] && !seen[callsign]) out.push({ kind: "done", g: 2, callsign });
    }
    const away = Object.entries(gone);
    for (const [m, x] of away) {
      if (x.list.length) out.push({ kind: "away", g: 1, machine: m, at: x.at, list: x.list.join(", ") });
    }
    // ушли раньше, чем открыто приложение, — знает модуль точек (только пульт)
    const fire = app.mark("fire");
    if (typeof fire === "number" && fire > away.length) out.push({ kind: "fire", g: 1, n: fire - away.length });
    return out;
  }

  return {
    start(a: App) {
      app = a;
    },
    onRoster,
    /** Открыли карточку сессии — «готово» прочитано. */
    onCurrent(c: { screen: string; params: Params }) {
      const callsign = c.params.callsign;
      if (callsign && c.screen !== "inbox") store.set((d) => void delete d.done[callsign]);
    },
    items,
    count: () => items().length,
    /** «Прочитано» на карточке «готово». */
    markSeen: (callsign: string) => store.set((d) => void (d.seen[callsign] = true)),
    /** «Запустить снова»: отказ — тост словом. */
    async restart(callsign: string) {
      const r = await app.request("session.start", { callsign });
      if (!r.ok) app.toast(`${callsign} не запустилась: ${r.error}`);
    },
  };
}
