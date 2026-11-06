// Ответы машин экрану: открыт — спрошены все; снимок неизменяем: его читает выборка app.use.
import type { App, ConnState, Result } from "./app.ts";

/** Ответ машины или отказ словом рядом с прежним ответом. */
export type MachineAnswer<T> = T | { error: string; held?: T };

const refused = <T>(a: MachineAnswer<T> | null | undefined): a is { error: string; held?: T } => typeof a === "object" && a !== null && "error" in a;

/** Ответ без слова или прежний ответ рядом с отказом. */
export const okOf = <T>(a: MachineAnswer<T> | null | undefined): T | undefined => (refused(a) ? a.held : (a ?? undefined));
/** Слово отказа; ответ — пусто. */
export const wordOf = <T>(a: MachineAnswer<T> | null | undefined) => (refused(a) ? a.error : "");

type Ask<T> = (machine: string) => Promise<Result<T>>;

export type MachineAnswers<T> = {
  get(): Readonly<Record<string, MachineAnswer<T>>>;
  mount(): () => void;
  isOpen(): boolean;
  onLink(state: ConnState, machine?: string): void;
  reload(machine: string, how?: Ask<T>): Promise<void>;
  put(machine: string, value: T): void;
};

/** Отказы, при которых вопрос не дошёл: связь вернулась — спросить снова. */
const NOT_DELIVERED = ["disconnected", "timeout"];

export function machineAnswers<T>(app: Pick<App, "roster" | "changed">, ask: Ask<T>, machines: () => string[] = () => (app.roster()?.machines ?? []).map((m) => m.machine), answered?: () => void): MachineAnswers<T> {
  let answers: Readonly<Record<string, MachineAnswer<T>>> = {};
  let open = 0;
  let asked = 0;
  /** номер вопроса, чей ответ лежит: ушедший раньше его не затирает */
  const latest = new Map<string, number>();

  const put = (machine: string, value: MachineAnswer<T>) => {
    answers = { ...answers, [machine]: value };
    app.changed();
  };

  async function reload(machine: string, how = ask) {
    const number = ++asked;
    const r = await how(machine);
    if (number < (latest.get(machine) ?? 0)) return;
    latest.set(machine, number);
    put(machine, r.ok ? r.result : { error: r.error, held: okOf(answers[machine]) });
    answered?.();
  }

  return {
    get: () => answers,
    isOpen: () => open > 0,
    put,
    reload,
    /** Экран открыт; ответ — закрыть. Второй экран рядом не спрашивает заново. */
    mount() {
      if (open++ === 0) for (const m of machines()) void reload(m);
      return () => void open--;
    },
    /** Машина вернулась — спросить её; связь вернулась — спросить те, до кого вопрос не дошёл. */
    onLink(state, machine) {
      if (!open || state !== "open") return;
      for (const m of machines()) if (machine ? m === machine : NOT_DELIVERED.includes(wordOf(answers[m]))) void reload(m);
    },
  };
}
