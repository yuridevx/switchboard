import type { Frame } from "@switchboard/protocol";
import type { Env as WorkerEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** подставной relay: кадры, которые участник отдал своей привязке RELAY */
      RELAY_LOG: {
        take(): Promise<Array<{ name: string; frame: Frame }>>;
        answer(word?: string): Promise<void>;
      };
    }
  }
}
export {};
