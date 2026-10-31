// Worker relay: wss → объект флота; вход Radio — для участников по их привязке RELAY.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import type { RelayWord } from "../contract.ts";
import { FLEET, Fleet, type Env } from "./fleet.ts";

export { Fleet };

/** Вход участников. Имя участника — из props его привязки: его задаёт только тот, кто выпускает Worker. */
export class Radio extends WorkerEntrypoint<Env, { name?: string }> {
  frame(f: Frame): Promise<RelayWord | undefined> {
    return this.env.FLEET.get(this.env.FLEET.idFromName(FLEET)).radio(this.ctx.props?.name ?? "", f);
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("switchboard relay: только wss\n", { status: 426 });
    }
    return env.FLEET.get(env.FLEET.idFromName(FLEET)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
