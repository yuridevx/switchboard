// Снесено: новый код — следующим коммитом.
export const REFUSAL = Symbol.for("switchboard.refusal");
export class Refusal extends Error {
  readonly word = "снесено";
  readonly why?: string;
}
export function refuse(_word: string, _why?: string): Refusal {
  throw new Error("снесено");
}
export function isRefusal(_e: unknown): _e is { word: string; why?: string } {
  throw new Error("снесено");
}
