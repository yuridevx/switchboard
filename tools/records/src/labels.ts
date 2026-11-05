// Заглушка сноса.
export const FLEET_PREFIX = "снесено";
export const LABELS = "снесено";
export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };
export function labelOf(_l: Labels | undefined, _to: string): string | undefined {
  throw new Error("снесено");
}
export function setLabel(_l: Labels | undefined, _to: string, _text: string): Labels {
  throw new Error("снесено");
}
