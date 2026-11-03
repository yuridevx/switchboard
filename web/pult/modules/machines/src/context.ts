// Состояние модуля в контексте его экрана.
import { createContext, useContext } from "react";
import type { MachinesStore } from "./store.ts";

export const MachinesCtx = createContext<MachinesStore | null>(null);
export const useMachines = (): MachinesStore => useContext(MachinesCtx)!;
