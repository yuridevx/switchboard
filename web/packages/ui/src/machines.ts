// Ответы машин экрану: открыт экран — спросить все машины; ядро сообщило, что машина вернулась, пришла или перезапустилась (on.link) — доспросить её; вернулась связь клиента —
// доспросить тех, кому не дошло. Закрыт — не спрашивает.
// Один цикл на все экраны с ответом от каждой машины. Состояние — неизменяемый снимок: его читает выборка app.use.
import { machinesWith } from "./format.ts";
import type { App, ConnState } from "./app.ts";
import type { Result } from "./app.ts";
import { createStore } from "./store.ts";

type AppLike = Pick<App, "roster" | "changed">;

/** Ответ машины: данные или слово отказа. */
export type MachineAnswer<T> = T | { error: string };
/** Данные ответа; отказа и ответа ещё нет — undefined. */
export const okOf = <T extends object>(a: MachineAnswer<T> | null | undefined): T | undefined => (a && !("error" in a) ? a : undefined);

export type MachineAnswers<T> = {
  /** снимок ответов по машинам */
  get(): Readonly<Record<string, MachineAnswer<T>>>;
  /** экран открыт: спросить все машины (второй открытый рядом не спрашивает ещё раз); возврат — экран закрыт */
  mount(): () => void;
  /** открыт ли экран */
  isOpen(): boolean;
  /** on.link: машина вернулась, пришла или перезапустилась — её спросить; связь вернулась — спросить тех, кому не дошло */
  onLink(state: ConnState, machine?: string): void;
  /** спросить одну машину заново; how — другой запрос вместо обычного (с другими полями) */
  reload(machine: string, how?: (machine: string) => Promise<Result<T>>): Promise<void>;
  /** положить ответ, известный без запроса: итог своего действия */
  put(machine: string, value: T): void;
};

/** machines — кого спрашивать; по умолчанию все машины roster. */
export function machineAnswers<T>(app: AppLike, ask: (machine: string) => Promise<Result<T>>, machines: () => string[] = () => machinesWith(app)): MachineAnswers<T> {
  const store = createStore<{ answers: Record<string, MachineAnswer<T>>; opened: number }>({ answers: {}, opened: 0 }, () => app.changed());

  const put = (machine: string, value: MachineAnswer<T>) =>
    store.set((s) => {
      (s.answers as Record<string, MachineAnswer<T>>)[machine] = value;
    });

  async function reload(machine: string, how = ask) {
    const r = await how(machine);
    put(machine, r.ok ? r.result : { error: r.error });
  }

  return {
    get: () => store.get().answers,
    mount() {
      const first = !store.get().opened;
      store.set((s) => void s.opened++);
      if (first) for (const m of machines()) void reload(m);
      return () => store.set((s) => void s.opened--);
    },
    isOpen: () => store.get().opened > 0,
    onLink(state, machine) {
      if (state !== "open" || !store.get().opened) return;
      const lost = (m: string) => (store.get().answers[m] as { error?: string } | undefined)?.error === "disconnected";
      for (const m of machines()) if (machine ? m === machine : lost(m)) void reload(m);
    },
    reload,
    put,
  };
}
