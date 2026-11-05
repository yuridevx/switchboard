// Ответы машин экрану: открыт экран — спросить все машины; машина вернулась, пришла или перезапустилась — доспросить её;
// вернулась связь клиента — доспросить тех, кому не дошло. Закрыт — не спрашивает. Один цикл на все экраны с ответом от каждой машины.
import type { App, ConnState, Result } from "./app.ts";
import { machinesWith } from "./sessions.ts";
import { createStore } from "./store.ts";

/** Ответ машины: данные или слово отказа; held — данные прошлого ответа, экран держит их рядом со словом. */
export type MachineAnswer<T> = T | { error: string; held?: T };

const isRefusal = <T,>(a: MachineAnswer<T>): a is { error: string; held?: T } => typeof a === "object" && a !== null && "error" in a;
/** Данные ответа, при отказе — прошлые; ответа ещё нет и прошлых нет — undefined. */
export const okOf = <T,>(a: MachineAnswer<T> | null | undefined): T | undefined => (a === null || a === undefined ? undefined : isRefusal(a) ? a.held : (a as T));
/** Слово отказа; отказа нет — пусто. */
export const wordOf = <T,>(a: MachineAnswer<T> | null | undefined): string => (a !== null && a !== undefined && isRefusal(a) ? a.error : "");

export type MachineAnswers<T> = {
  /** снимок ответов по машинам */
  get(): Readonly<Record<string, MachineAnswer<T>>>;
  /** экран открыт: спросить все машины (второй открытый рядом не спрашивает ещё раз); возврат — экран закрыт */
  mount(): () => void;
  isOpen(): boolean;
  /** on.link: машина вернулась, пришла или перезапустилась — её спросить; связь вернулась — спросить тех, кому не дошло или кто не ответил вовремя */
  onLink(state: ConnState, machine?: string): void;
  /** спросить одну машину заново; how — другой запрос вместо обычного (с другими полями) */
  reload(machine: string, how?: (machine: string) => Promise<Result<T>>): Promise<void>;
  /** положить ответ, известный без запроса: итог своего действия */
  put(machine: string, value: T): void;
};

/** Слова, при которых вопрос не дошёл: на мёртвом сокете чтение успевает получить timeout раньше обрыва. */
const NOT_DELIVERED = ["disconnected", "timeout"];

/** machines — кого спрашивать; по умолчанию все машины roster. */
export function machineAnswers<T>(app: Pick<App, "roster" | "changed">, ask: (machine: string) => Promise<Result<T>>, machines: () => string[] = () => machinesWith(app)): MachineAnswers<T> {
  const store = createStore<{ answers: Record<string, MachineAnswer<T>>; viewers: number }>({ answers: {}, viewers: 0 }, () => app.changed());
  /** номер последнего вопроса к машине: ответ на прежний опоздал и свежие данные не затирает */
  const lastAsked = new Map<string, number>();
  const nextTurn = (machine: string) => {
    const turn = (lastAsked.get(machine) ?? 0) + 1;
    lastAsked.set(machine, turn);
    return turn;
  };
  const answerOf = (machine: string) => store.get().answers[machine] as MachineAnswer<T> | undefined;
  const set = (machine: string, value: MachineAnswer<T>) => store.set((s) => void ((s.answers as Record<string, MachineAnswer<T>>)[machine] = value));

  async function reload(machine: string, how = ask) {
    const turn = nextTurn(machine);
    const r = await how(machine);
    if (lastAsked.get(machine) !== turn) return;
    if (r.ok) return set(machine, r.result);
    const held = okOf(answerOf(machine));
    set(machine, { error: r.error, ...(held ? { held } : {}) });
  }

  return {
    get: () => store.get().answers,
    mount() {
      const first = store.get().viewers === 0;
      store.set((s) => void s.viewers++);
      if (first) for (const m of machines()) void reload(m);
      return () => store.set((s) => void s.viewers--);
    },
    isOpen: () => store.get().viewers > 0,
    onLink(state, machine) {
      if (state !== "open" || !store.get().viewers) return;
      const wanted = machine ? (m: string) => m === machine : (m: string) => NOT_DELIVERED.includes(wordOf(answerOf(m)));
      for (const m of machines()) if (wanted(m)) void reload(m);
    },
    reload,
    put(machine, value) {
      nextTurn(machine);
      set(machine, value);
    },
  };
}
