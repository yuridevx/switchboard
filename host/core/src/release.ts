// Снесено: заглушка контракта до реализации.
import type { Manifest, Module } from "../contract.ts";
const gone = (): never => {
  throw new Error("снесено");
};
export type ModuleEntry = { manifest: Manifest; module: Module };
export const claudeCli = (..._a: unknown[]): any => gone();
export const claudePath = (..._a: unknown[]): any => gone();
