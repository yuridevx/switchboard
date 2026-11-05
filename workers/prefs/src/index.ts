// Вход Worker'а prefs: POST кадра с пропуском — обёртка entrance из контракта gate.
import { entrance } from "@switchboard/gate";
import { frame, type Env } from "./prefs.ts";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return entrance(req, env.GATE, (f) => frame(env, f));
  },
} satisfies ExportedHandler<Env>;
