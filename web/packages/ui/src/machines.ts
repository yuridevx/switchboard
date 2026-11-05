// Ответы машин одному экрану: спросить при открытии, держать по машинам, спросить заново, когда машина вернулась.
import type { App, ConnState, Result } from "./app.ts";

/** Ответ машины: данные или слово отказа; held — данные прошлого ответа, экран держит их рядом со словом. */
export type MachineAnswer<T> = T | { error: string; held?: T };

const refused = <T>(a: MachineAnswer<T> | null | undefined): a is { error: string; held?: T } => typeof a === "object" && a !== null && "error" in a;

/** Данные ответа, при отказе — прошлые; ответа ещё нет и прошлых нет — undefined. */
export const okOf = <T>(a: MachineAnswer<T> | null | undefined): T | undefined => (refused(a) ? a.held : (a ?? undefined));
/** Слово отказа; отказа нет — пусто. */
export const wordOf = <T>(a: MachineAnswer<T> | null | undefined): string => (refused(a) ? a.error : "");

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

/** Слова отказа, после которых вопрос стоит повторить, когда связь вернулась: ответа не было. */
const NOT_DELIVERED = ["disconnected", "timeout"];

/** machines — кого спрашивать; по умолчанию все машины roster. answered — ответ машины уже в записях. */
export function machineAnswers<T>(app: Pick<App, "roster" | "changed">, ask: (machine: string) => Promise<Result<T>>, machines: () => string[] = () => (app.roster()?.machines ?? []).map((m) => m.machine), answered?: () => void): MachineAnswers<T> {
  let answers: Readonly<Record<string, MachineAnswer<T>>> = {};
  let open = 0;
  let asked = 0;
  /** номер вопроса последнего ответа машины: ответ на вопрос, ушедший раньше, его не затирает */
  const latest = new Map<string, number>();

  const put = (machine: string, value: MachineAnswer<T>) => {
    answers = { ...answers, [machine]: value };
    app.changed();
  };

  async function reload(machine: string, how = ask): Promise<void> {
    const number = ++asked;
    const r = await how(machine);
    if (number < (latest.get(machine) ?? 0)) return;
    latest.set(machine, number);
    put(machine, r.ok ? r.result : { error: r.error, held: okOf(answers[machine]) });
    answered?.();
  }

  return {
    get: () => answers,
    mount() {
      if (open++ === 0) for (const m of machines()) void reload(m);
      return () => void open--;
    },
    isOpen: () => open > 0,
    onLink(state, machine) {
      if (!open || state !== "open") return;
      if (machine) {
        if (machines().includes(machine)) void reload(machine);
        return;
      }
      for (const m of machines()) if (NOT_DELIVERED.includes(wordOf(answers[m]))) void reload(m);
    },
    reload,
    put,
  };
}
