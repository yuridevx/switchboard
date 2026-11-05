// снесено
import type { DefinedPart } from "./types.ts";

export const appGate = (_parts: DefinedPart[]): string[] => {
  throw new Error("снесено");
};
