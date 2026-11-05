// Снесено: вход контракта отвечает словом.
import type { DefinedPart, Running, StartOptions } from "./types.ts";
import type { BuildList } from "./types.ts";
const gone = (): never => {
  throw new Error("снесено");
};
export type BuildOptions = Omit<StartOptions, "workers" | "parts"> & { build: BuildList; load?: (name: string) => Promise<unknown>; loadMs?: number };
export const startApp: (o: StartOptions) => Running = gone;
export const startBuild: (o: BuildOptions) => Promise<Running> = gone;
export const appGate: (parts: DefinedPart[]) => string[] = gone;
