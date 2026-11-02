// Worker relay — вход без состояния: wss /m/<машина> → объект этой машины.
// POST keys.revoke — отзыв пропуска через общий вход Worker'ов (entrance из контракта gate): отметка у gate, затем
// close на объектах всех машин флота. Привязка Relay.deliver — кадр Worker'а своей машине (план keeper'у от «Выпусков»).
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, machineOf, ok, within, type Frame, type Reply } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import { CONTRACT } from "../contract.ts";
import { Fleet, call, machineObject, type Env } from "./fleet.ts";

export { Fleet };

const log = (line: string) => console.log(line);
const MACHINE = /^\/m\/([A-Za-z0-9_-]+)$/;

const stub = (env: Env, name: string) => env.FLEET.get(env.FLEET.idFromName(name));

/** keys.revoke {kid} от вошедшего (from — адрес его пропуска): отметка у gate, close на объекте каждой машины из списка gate. */
async function revoke(env: Env, f: Frame): Promise<Reply> {
  const from = String(f.from);
  const reply = (r: Reply): Reply => ({ ...r, to: from });
  if (!f.id) return reply(fail("", "bad_frame"));
  const bad = accepts(f, CONTRACT);
  if (bad) return reply(fail(f.id, bad.word));
  if (typeof f.kid !== "string" || !f.kid) return reply(fail(f.id, "bad_request"));
  const kid = f.kid;
  const r = await within(call(env.GATE.revoke(kid)), "gate не ответил на revoke");
  if ("error" in r) {
    log(`unknown_key ${kid} · отзыв от ${from}`);
    return reply(fail(f.id, r.error));
  }
  const machines = (await within(call(env.GATE.list("host")), "gate не ответил на list")).map((p) => p.name);
  const closed = (await Promise.all(machines.map((m) => within(stub(env, machineObject(m)).close(kid), `объект ${m} не ответил на close`)))).reduce((a, b) => a + b, 0);
  log(`revoke ${kid} ${r.addr} · отозвал ${from} · закрыто соединений ${closed} на ${machines.length} машинах`);
  return reply(ok(f.id, { addr: r.addr, closed }));
}

export class Relay extends WorkerEntrypoint<Env> {
  /** Кадр Worker'а по привязке: from ставит вызывающий; to — машина, сессия или часть машины. Ответ — сколько получателей. */
  async deliver(f: Frame): Promise<number> {
    const m = typeof f.to === "string" ? machineOf(f.to) : null;
    if (!m) return 0;
    return within(stub(this.env, machineObject(m)).deliver(f), `объект ${m} не ответил на deliver`);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/") return entrance(req, env.GATE, async (f) => [await revoke(env, f)], log);
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("switchboard relay: wss /m/<машина> или POST keys.revoke\n", { status: 426 });
    }
    const m = MACHINE.exec(path);
    if (!m) return new Response("switchboard relay: wss /m/<машина>\n", { status: 404 });
    return stub(env, machineObject(m[1])).fetch(req);
  },
} satisfies ExportedHandler<Env>;
