export const REFUSAL = Symbol.for("switchboard.refusal");
export class Refusal extends Error {}
export function refuse(_w: string, _y?: string): Refusal { throw new Error("снесено"); }
export function isRefusal(_e: unknown): boolean { throw new Error("снесено"); }
