// Отказ словом: не ошибка модуля. Модули и новый выпуск могут нести свою копию пакета, поэтому отказ узнаётся по метке, а не по классу.
export const REFUSAL = Symbol.for("switchboard.refusal");

export class Refusal extends Error {
  readonly [REFUSAL] = true;
  readonly word: string;
  readonly why?: string;
  constructor(word: string, why?: string) {
    super(why ? `${word}: ${why}` : word);
    this.word = word;
    this.why = why;
  }
}

export const refuse = (word: string, why?: string): Refusal => new Refusal(word, why);

export const isRefusal = (e: unknown): e is Refusal => typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[REFUSAL] === true;
