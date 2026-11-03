// Состояние модуля в контексте его экрана.
import { createContext, useContext } from "react";
import type { JournalStore } from "./store.ts";

export const JournalCtx = createContext<JournalStore | null>(null);
export const useJournal = (): JournalStore => useContext(JournalCtx)!;
