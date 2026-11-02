// Worker relay: wss → объект флота. Участники — Worker-модули по привязкам relay: их кадры приходят ответом frame.
import { FLEET, Fleet, type Env } from "./fleet.ts";

export { Fleet };

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("switchboard relay: только wss\n", { status: 426 });
    }
    return env.FLEET.get(env.FLEET.idFromName(FLEET)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
