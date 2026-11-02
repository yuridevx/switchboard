import type { App } from "./app.ts";

export interface Env {
  /** объект приложения GitHub, один на флот */
  APP: DurableObjectNamespace<App>;
}
