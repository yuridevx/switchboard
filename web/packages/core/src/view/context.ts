// App модуля в контексте: компоненты экрана берут его хуком, а не из замыкания фабрики. Значение ставит место экрана (place.tsx).
import { createContext, useContext } from "react";
import type { App } from "../types.ts";

export const AppCtx = createContext<App | null>(null);

/** App модуля, чей экран рисуется. */
export function useApp(): App {
  const app = useContext(AppCtx);
  if (!app) throw new Error("useApp вне экрана модуля");
  return app;
}
