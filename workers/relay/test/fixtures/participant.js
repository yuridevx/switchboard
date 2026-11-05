// Поддельный журнал для тестов relay: запоминает кадры; throw — сломан; hang — молчит дольше предела вызова.
import { WorkerEntrypoint } from "cloudflare:workers";

const got = [];
let mode = "ok";

export class Participant extends WorkerEntrypoint {
  async frame(f) {
    got.push(f);
    if (mode === "throw") throw new Error("журнал сломан");
    if (mode === "hang") await new Promise((r) => setTimeout(r, 10_000));
    return [];
  }
  setMode(m) {
    mode = m;
  }
  received() {
    return got;
  }
  clear() {
    got.length = 0;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
