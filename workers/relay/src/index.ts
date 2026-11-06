// Вход relay без состояния: сокет — объекту машины, POST — отзыв пропуска, привязка — кадр Worker'а объекту машины адреса.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { accepts, fail, machineOf, ok, within, type Frame, type Reply } from "@switchboard/protocol";
import { callMs, type Env } from "./fleet.ts";

export { Fleet } from "./fleet.ts";

const objectOf = (env: Env, machine: string) => env.FLEET.get(env.FLEET.idFromName(`m/${machine}`));

/** Кадр без id ответа не ждёт и не исполняется. */
async function revoke(f: Frame, env: Env): Promise<Frame[]> {
  if (!f.id) return [];
  const answer = (r: Reply) => [{ ...r, to: f.from } as Frame];
  const limit = callMs(env);
  const no = accepts(f, { "keys.revoke": 1 });
  if (no) return answer(fail(f.id, no.word));
  const { kid } = f;
  if (typeof kid !== "string") return answer(fail(f.id, "bad_request"));
  const done = await within(env.GATE.revoke(kid), "gate не ответил на revoke", limit);
  if ("error" in done) {
    console.log(`${done.error} ${kid} от ${f.from}`);
    return answer(fail(f.id, done.error));
  }
  const passes = await within(env.GATE.list("host"), "gate не ответил на list", limit);
  // отозванной машины в списке уже нет, а её соединения живы: объект — из адреса
  const machines = new Set([...passes.map((p) => p.name), machineOf(done.addr)].filter((m) => m !== null));
  const counts = await within(Promise.all([...machines].map((m) => objectOf(env, m).revoke(kid))), "объекты машин не ответили на отзыв", limit);
  const closed = counts.reduce((a, b) => a + b, 0);
  console.log(`revoke ${kid} ${done.addr} от ${f.from} · закрыто ${closed}`);
  return answer(ok(f.id, { addr: done.addr, closed }));
}

export class Relay extends WorkerEntrypoint<Env> {
  async deliver(f: Frame): Promise<number> {
    const machine = typeof f.to === "string" ? machineOf(f.to) : null;
    return machine ? within(objectOf(this.env, machine).deliver(f), `объект ${machine} не ответил`, callMs(this.env)) : 0;
  }
}

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    if (req.method === "POST") return entrance(req, env.GATE, (f) => revoke(f, env));
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("switchboard relay: wss /m/<машина> или POST keys.revoke\n", { status: 426 });
    const machine = /^\/m\/([\w-]+)$/.exec(new URL(req.url).pathname)?.[1];
    return machine ? objectOf(env, machine).fetch(req) : new Response("switchboard relay: wss /m/<машина>\n", { status: 404 });
  },
};
