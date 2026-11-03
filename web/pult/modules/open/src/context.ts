// Состояние модуля в контексте его экрана.
import { createContext, useContext } from "react";
import type { OpenStore } from "./store.ts";

export const OpenCtx = createContext<OpenStore | null>(null);
export const useOpen = (): OpenStore => useContext(OpenCtx)!;
