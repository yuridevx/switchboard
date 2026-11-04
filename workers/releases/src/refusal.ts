// Отказ словом и журнал «Выпусков»: Workers Logs, одна строка JSON в общем формате журналов. Ссылок и ключей в журнале нет.
export class Refusal {
  word: string;
  why: string;
  constructor(word: string, why: string) {
    this.word = word;
    this.why = why;
  }
}

export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "releases", ...rec }));
}
