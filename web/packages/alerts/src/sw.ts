// Снесено: заглушка на время сноса.
export type SwScope = any;
export function serviceWorker(_scope: SwScope, _o: unknown): void {
  throw new Error("снесено");
}
