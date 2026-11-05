// Отказ словом контракта модуля — не ошибка модуля.
// Ядро узнаёт отказ по метке, а не по классу: модуль из папки нового выпуска берёт свою копию этого файла.

/** Метка отказа: одна на процесс для всех копий пакета. */
export const REFUSAL = Symbol.for("switchboard.refusal");

/** Отказ словом: ядро шлёт reply ok:false с этим словом и пишет refuse в журнал. */
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

/** Бросить отказ словом: throw refuse("already_answered"). */
export function refuse(word: string, why?: string): Refusal {
  return new Refusal(word, why);
}

/** Отказ ли это — по метке, из любой копии пакета. */
export function isRefusal(e: unknown): e is { word: string; why?: string } {
  return !!e && typeof e === "object" && (e as Record<symbol, unknown>)[REFUSAL] === true && typeof (e as { word?: unknown }).word === "string";
}
