// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { AskStore } from "./store.ts";

export const AskCtx = createContext<AskStore | null>(null);
export const useAsk = (): AskStore => useContext(AskCtx)!;
