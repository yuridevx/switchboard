// Отказ словом: слово — контракт вызывающего (Host отдаёт его как есть, CLI печатает).
export class Refused extends Error {
  word: string;
  constructor(word: string, why: string) {
    super(why);
    this.word = word;
  }
}
