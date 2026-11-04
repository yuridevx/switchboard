// Ответы машин экрану: открыт экран — спросить все машины; ядро сообщило, что машина вернулась, пришла или перезапустилась (on.link) — доспросить её; вернулась связь клиента —
// доспросить тех, кому не дошло. Закрыт — не спрашивает.
// Один цикл на все экраны с ответом от каждой машины. Состояние — неизменяемый снимок: его читает выборка app.use.
import { machinesWith } from "./format.ts";
import type { App, ConnState } from "./app.ts";
import type { Result } from "./app.ts";
import { createStore } from "./store.ts";

type AppLike = Pick<App, "roster" | "changed">;

/** Ответ машины: данные или слово отказа; held — данные прошлого ответа, экран держит их рядом со словом. */
export type MachineAnswer<T> = T | { error: string; held?: T };
const refused = <T,>(a: MachineAnswer<T>): a is { error: string; held?: T } => typeof a === "object" && a !== null && "error" in a;
/** Данные ответа, при отказе — прошлые; ответа ещё нет и прошлых нет — undefined. */
export const okOf = <T,>(a: MachineAnswer<T> | null | undefined): T | undefined => (a === null || a === undefined ? undefined : refused(a) ? a.held : (a as T));
/** Слово отказа; отказа нет — пусто. */
export const wordOf = <T,>(a: MachineAnswer<T> | null | undefined): string => (a !== null && a !== undefined && refused(a) ? a.error : "");

export type MachineAnswers<T> = {
  /** снимок ответов по машинам */
  get(): Readonly<Record<string, MachineAnswer<T>>>;
  /** экран открыт: спросить все машины (второй открытый рядом не спрашивает ещё раз); возврат — экран закрыт */
  mount(): () => void;
  /** открыт ли экран */
  isOpen(): boolean;
  /** on.link: машина вернулась, пришла или перезапустилась — её спросить; связь вернулась — спросить тех, кому не дошло или кто не ответил вовремя */
  onLink(state: ConnState, machine?: string): void;
  /** спросить одну машину заново; how — другой запрос вместо обычного (с другими полями) */
  reload(machine: string, how?: (machine: string) => Promise<Result<T>>): Promise<void>;
  /** положить ответ, известный без запроса: итог своего действия */
  put(machine: string, value: T): void;
};

/** machines — кого спрашивать; по умолчанию все машины roster. */
export function machineAnswers<T>(app: AppLike, ask: (machine: string) => Promise<Result<T>>, machines: () => string[] = () => machinesWith(app)): MachineAnswers<T> {
  const store = createStore<{ answers: Record<string, MachineAnswer<T>>; opened: number }>({ answers: {}, opened: 0 }, () => app.changed());

  /** последний вопрос к машине: ответ на прежний — уже не новость, опоздавший отказ не затирает свежие данные */
  const turns = new Map<string, number>();
  const next = (machine: string) => {
    const turn = (turns.get(machine) ?? 0) + 1;
    turns.set(machine, turn);
    return turn;
  };

  const set = (machine: string, value: MachineAnswer<T>) =>
    store.set((s) => {
      (s.answers as Record<string, MachineAnswer<T>>)[machine] = value;
    });

  async function reload(machine: string, how = ask) {
    const turn = next(machine);
    const r = await how(machine);
    if (turns.get(machine) !== turn) return;
    if (r.ok) return set(machine, r.result);
    const held = okOf(store.get().answers[machine] as MachineAnswer<T> | undefined);
    set(machine, { error: r.error, ...(held ? { held } : {}) });
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
      // на мёртвом сокете чтение успевает получить timeout раньше обрыва
      const lost = (m: string) => ["disconnected", "timeout"].includes(wordOf(store.get().answers[m] as MachineAnswer<T> | undefined));
      for (const m of machines()) if (machine ? m === machine : lost(m)) void reload(m);
    },
    reload,
    put(machine, value) {
      next(machine);
      set(machine, value);
    },
  };
}
