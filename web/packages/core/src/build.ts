// снесено
import type { BuildList, Running, StartOptions } from "./types.ts";

export type BuildOptions = Omit<StartOptions, "parts" | "workers" | "application"> & { build: BuildList; load?: (name: string) => Promise<unknown>; loadMs?: number };
export const startBuild = async (_o: BuildOptions): Promise<Running> => {
  throw new Error("снесено");
};
