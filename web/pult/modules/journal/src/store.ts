// Журнал флота: записи открытого экрана. Первое чтение при открытии; пока экран открыт, каждый roster — дочитать новые (after = последний id).
import type { App } from "@switchboard/web-core";
import { createStore } from "@switchboard/web-ui";

export type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };

type View = { open: boolean; evs: Ev[]; more: boolean; machine: string; err: string; busy: boolean };
const CLOSED: View = { open: false, evs: [], more: false, machine: "", err: "", busy: false };

export type JournalStore = ReturnType<typeof createJournalStore>;

export function createJournalStore() {
  let app: App;
  const store = createStore<View>(CLOSED, () => app.changed());
  /** номер выборки: смена машины и закрытие экрана отменяют идущие чтения */
  let epoch = 0;

  async function read(body: Record<string, unknown>, how: "all" | "older" | "newer") {
    const mine = epoch;
    const { machine } = store.get();
    store.set((s) => void (s.busy = true));
    const r = await app.request<{ events: Ev[]; more: boolean }>("ledger.read", { limit: 50, ...(machine ? { machine } : {}), ...body });
    if (mine !== epoch) return;
    store.set((s) => {
      s.busy = false;
      if (!r.ok) return void (s.err = `ledger.read: ${r.error}`);
      s.err = "";
      if (how === "all") {
        s.evs = r.result.events;
        s.more = r.result.more;
      } else if (how === "older") {
        s.evs.push(...r.result.events);
        s.more = r.result.more;
      } else {
        const ids = new Set(s.evs.map((e) => e.id));
        s.evs = [...r.result.events.filter((e) => !ids.has(e.id)), ...s.evs].sort((a, b) => b.id - a.id);
      }
    });
  }

  return {
    start(a: App) {
      app = a;
    },
    view: () => store.get(),
    /** Экран открыт: первое чтение; возврат — закрыть: записи живут только на экране. */
    mount(): () => void {
      store.set((s) => void (s.open = true));
      void read({}, "all");
      return () => {
        epoch++;
        store.set(() => CLOSED);
      };
    },
    /** Идёт чтение — пропустить; записей нет — прочитать все, иначе после последней. */
    onRoster() {
      const { open, busy, evs } = store.get();
      if (!open || busy) return;
      void (evs.length ? read({ after: Math.max(...evs.map((e) => e.id)) }, "newer") : read({}, "all"));
    },
    pickMachine(machine: string) {
      epoch++;
      store.set((s) => void (s.machine = machine));
      void read({}, "all");
    },
    older() {
      void read({ before: Math.min(...store.get().evs.map((e) => e.id)) }, "older");
    },
  };
}
