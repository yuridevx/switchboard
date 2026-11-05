// Отказ словом своего контракта: не ошибка модуля. Метка — Symbol.for: отказ узнаётся и из другой копии пакета.
export const REFUSAL = Symbol.for("switchboard.refusal");

export class Refusal extends Error {
  readonly word: string;
  readonly why?: string;
  readonly [REFUSAL] = true;

  constructor(word: string, why?: string) {
    super(why ? `${word}: ${why}` : word);
    this.word = word;
    this.why = why;
  }
}

/** throw refuse("already_answered", "вопрос закрыт") */
export const refuse = (word: string, why?: string): Refusal => new Refusal(word, why);

export const isRefusal = (e: unknown): e is Refusal => typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[REFUSAL] === true;
