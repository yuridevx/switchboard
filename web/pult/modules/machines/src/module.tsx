// Снесено: вход отказывает словом.
import type { AppPart } from "@switchboard/web-core";

export const createMachines = ((): never => {
  throw new Error("снесено");
}) satisfies AppPart["module"];

export type MachineRowInfo = { machine: string; state: string; left?: number };
