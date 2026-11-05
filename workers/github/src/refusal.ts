// Отказ словом: из любого места запроса до одного обработчика в serve.
export type RefusalParts = {
  /** поля ответа отправителю рядом со словом */
  reply?: Record<string, unknown>;
  /** поля только для журнала */
  journal?: Record<string, unknown>;
};

export class Refusal extends Error {
  readonly word: string;
  readonly why: string;
  readonly parts: RefusalParts;

  constructor(word: string, why: string, parts: RefusalParts = {}) {
    super(`${word}: ${why}`);
    this.word = word;
    this.why = why;
    this.parts = parts;
  }
}
