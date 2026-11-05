// Состояние «Вам»: только то, что видно по смене roster при открытом приложении — «готово» (busy → idle) и ушедшие машины.
// Карточки выводятся из roster и меток других модулей; очереди и хранилища нет.
import type { App, Params, Roster } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { createStore, slotOf, useModule } from "@switchboard/web-ui";

export type Kind = "q" | "msg" | "fail" | "wait" | "away" | "fire" | "done";
/** Карточка: только простые поля — строка списка перерисовывается, когда изменились они или её выборка. */
export type Item = { kind: Kind; g: 0 | 1 | 2; callsign?: string; machine?: string; at?: number; list?: string; n?: number };

type State = {
  /** прошлый roster: состояния сессий */
  states: Record<string, unknown>;
  /** закончили ход, пока их не смотрели */
  done: Record<string, true>;
  /** мои сессии машин по последнему roster, где машина была: сессий ушедшей в roster уже нет */
  mineOn: Record<string, string[]>;
};

export type InboxState = ReturnType<typeof createInboxState>;
export const useInbox = (): InboxState => useModule<InboxState>();

export function createInboxState(app: App) {
  const store = createStore<State>({ states: {}, done: {}, mineOn: {} }, () => app.changed());
  const mine = (callsign: string) => !!app.mark("mine", callsign);
  const viewing = (callsign: string) => {
    const c = app.current();
    return !!c && c.params.callsign === callsign && c.screen !== "inbox";
  };

  function onRoster(r: Roster) {
    // считается до правки: выборка в правке не ходит в ядро
    const mineOn = Object.fromEntries(r.machines.map((m) => [m.machine, r.sessions.filter((s) => machineOf(s.callsign) === m.machine && mine(s.callsign)).map((s) => s.callsign)]));
    const viewed = new Set(r.sessions.filter((s) => viewing(s.callsign)).map((s) => s.callsign));
    store.set((d) => {
      for (const s of r.sessions) {
        const was = d.states[s.callsign];
        if (s.state === "busy" || s.state === "starting" || s.state === "waiting") delete d.done[s.callsign];
        else if ((was === "busy" || was === "starting") && s.state === "idle" && !viewed.has(s.callsign)) d.done[s.callsign] = true;
      }
      Object.assign(d.mineOn, mineOn);
      d.states = Object.fromEntries(r.sessions.map((s) => [s.callsign, s.state]));
    });
  }

  /** Карточки сейчас: из roster, меток и того, что видно по смене roster. */
  function items(): Item[] {
    const r = app.roster();
    if (!r) return [];
    const { done, mineOn } = store.get();
    const out: Item[] = [];
    for (const s of r.sessions) {
      const callsign = s.callsign;
      if (app.mark("asked", callsign)) out.push({ kind: "q", g: 0, callsign });
      else if (app.mark("unread", callsign)) out.push({ kind: "msg", g: 0, callsign });
      if (!mine(callsign)) continue;
      if (s.state === "failed") out.push({ kind: "fail", g: 1, callsign });
      const wait = slotOf(s)?.wait;
      if (typeof wait === "number" && wait > 0) out.push({ kind: "wait", g: 1, callsign, at: wait * 1000 });
      if (s.state === "idle" && done[callsign]) out.push({ kind: "done", g: 2, callsign });
    }
    // когда машина ушла, знает её владелец — модуль машин
    const gone = (app.mark("machines.gone") ?? {}) as Record<string, number>;
    for (const [machine, at] of Object.entries(gone)) {
      const list = mineOn[machine] ?? [];
      if (list.length) out.push({ kind: "away", g: 1, machine, at, list: list.join(", ") });
    }
    // ушли раньше, чем открыто приложение, — знает модуль точек (только пульт)
    const earlier = ((app.mark("fire") ?? []) as string[]).filter((m) => gone[m] === undefined).length;
    if (earlier) out.push({ kind: "fire", g: 1, n: earlier });
    return out;
  }

  const seen = (callsign: string) => store.set((d) => void delete d.done[callsign]);

  return {
    onRoster,
    /** Открыли карточку сессии — «готово» прочитано. */
    onCurrent(c: { screen: string; params: Params }) {
      if (c.params.callsign && c.screen !== "inbox") seen(c.params.callsign);
    },
    items,
    count: () => items().length,
    seen,
    /** «Запустить снова»: отказ — тост словом. */
    async restart(callsign: string) {
      const r = await app.request("session.start", { callsign });
      if (!r.ok) app.toast(`${callsign} не запустилась: ${r.error}`);
    },
  };
}
