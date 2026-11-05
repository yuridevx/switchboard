import type { Env as WorkerEnv } from "../src/prefs.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
export {};
