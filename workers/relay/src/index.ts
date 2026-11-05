// Worker relay — вход без состояния: wss /m/<машина> → объект этой машины; POST keys.revoke — через общий вход Worker'ов;
// привязка Relay.deliver — кадр Worker'а объекту машины адреса (план keeper'у от «Выпусков»).
import { WorkerEntrypoint } from "cloudflare:workers";
import { machineOf, within, type Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import { Fleet, type Env } from "./machine.ts";
import { machineStub, revoke } from "./revoke.ts";

export { Fleet };

const MACHINE_PATH = /^\/m\/([A-Za-z0-9_-]+)$/;
const hint = (text: string, status: number) => new Response(`switchboard relay: ${text}\n`, { status });

export class Relay extends WorkerEntrypoint<Env> {
  /** to — машина, сессия или часть машины; from ставит вызывающий. Ответ — сколько получателей. */
  async deliver(f: Frame): Promise<number> {
    const machine = typeof f.to === "string" ? machineOf(f.to) : null;
    return machine ? within(machineStub(this.env, machine).deliver(f), `объект ${machine} не ответил на deliver`) : 0;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "POST" && pathname === "/") return entrance(req, env.GATE, (f) => revoke(env, f), (line) => console.log(line));
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return hint("wss /m/<машина> или POST keys.revoke", 426);
    const machine = MACHINE_PATH.exec(pathname)?.[1];
    return machine ? machineStub(env, machine).fetch(req) : hint("wss /m/<машина>", 404);
  },
} satisfies ExportedHandler<Env>;
