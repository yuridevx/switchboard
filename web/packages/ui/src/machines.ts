// Ответы машин экрану: открыт экран — спросить все машины, пришла или вернулась машина — доспросить её. Закрыт — не спрашивает.
// Один цикл на все экраны с ответом от каждой машины. Состояние — неизменяемый снимок: его читает выборка app.use.
import type { Roster } from "@switchboard/relay";
import { createStore } from "./store.ts";

/** Ответ запроса ядра (форма Result: ядро ui не знает). */
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };
type AppLike = { roster(): Roster | null; changed(): void };

/** Ответ машины: данные или слово отказа. */
export type MachineAnswer<T> = T | { error: string };

export type MachineAnswers<T> = {
  /** снимок ответов по машинам */
  get(): Readonly<Record<string, MachineAnswer<T>>>;
  /** экран открыт: спросить все машины; возврат — экран закрыт */
  mount(): () => void;
  /** новый roster: машину, которая пришла или вернулась при открытом экране, спросить */
  onRoster(r: Roster): void;
  /** спросить одну машину заново */
  reload(machine: string): Promise<void>;
};

/** machines — кого спрашивать; по умолчанию все машины roster. */
export function machineAnswers<T>(app: AppLike, ask: (machine: string) => Promise<Answer<T>>, machines: () => string[] = () => (app.roster()?.machines ?? []).map((m) => m.machine)): MachineAnswers<T> {
  const store = createStore<{ answers: Record<string, MachineAnswer<T>>; opened: number; seen: Record<string, unknown> }>({ answers: {}, opened: 0, seen: {} }, () => app.changed());

  async function reload(machine: string) {
    const r = await ask(machine);
    store.set((s) => {
      (s.answers as Record<string, MachineAnswer<T>>)[machine] = r.ok ? r.result : { error: r.error };
    });
  }

  return {
    get: () => store.get().answers,
    mount() {
      store.set((s) => void s.opened++);
      for (const m of machines()) void reload(m);
      return () => store.set((s) => void s.opened--);
    },
    onRoster(r) {
      const allowed = new Set(machines());
      const { opened, seen } = store.get();
      const fresh = r.machines.filter((m) => seen[m.machine] !== m.since);
      if (fresh.length) store.set((s) => void fresh.forEach((m) => (s.seen[m.machine] = m.since)));
      if (opened) for (const m of fresh) if (allowed.has(m.machine)) void reload(m.machine);
    },
    reload,
  };
}
