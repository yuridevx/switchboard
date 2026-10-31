// Отказ словом контракта модуля — не ошибка модуля.

/** Отказ словом контракта модуля: ядро шлёт reply ok:false с этим словом и пишет refuse в журнал. Не ошибка модуля. */
export class Refusal extends Error {
  readonly word: string;
  readonly why?: string;
  constructor(word: string, why?: string) {
    super(why ? `${word}: ${why}` : word);
    this.word = word;
    this.why = why;
  }
}

/** Бросить отказ словом: throw refuse("already_answered"). */
export function refuse(word: string, why?: string): Refusal {
  return new Refusal(word, why);
}
