// Состояние модуля в контексте его экранов.
import { createContext, useContext } from "react";
import type { InboxStore } from "./store.ts";

export const InboxCtx = createContext<InboxStore | null>(null);
export const useInbox = (): InboxStore => useContext(InboxCtx)!;
