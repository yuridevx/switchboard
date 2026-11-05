// Вход relay без состояния: сокет — объекту машины, POST — отзыв пропуска через общий вход Worker'ов, привязка — кадр объекту адреса.
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import { Fleet, type Env } from "./fleet.ts";

export { Fleet };

const machineObject = (env: Env, machine: string) => env.FLEET.get(env.FLEET.idFromName(`m/${machine}`));

/** keys.revoke: отметка у gate, затем соединения номера закрывают объекты всех машин и самого отозванного. Кадр без id не ждёт ответа и ничего не отзывает. */
async function revoke(f: Frame, env: Env): Promise<Frame[]> {
  if (!f.id) return [];
  const answer = (r: ReturnType<typeof ok>) => [{ ...r, to: f.from }];
  const bad = accepts(f, { "keys.revoke": 1 });
  if (bad) return answer(fail(f.id, bad.word));
  const { kid } = f;
  if (typeof kid !== "string" || !kid) return answer(fail(f.id, "bad_request"));

  const gone = await env.GATE.revoke(kid);
  if ("error" in gone) {
    console.log(`${gone.error} ${kid} · отзыв от ${f.from}`);
    return answer(fail(f.id, gone.error));
  }
  const hosts = await env.GATE.list("host");
  const machines = new Set(hosts.map((p) => p.name));
  // gate отозванного уже не числит, а его Host и keeper ещё на связи
  const own = machineOf(gone.addr);
  if (own) machines.add(own);
  const counts = await Promise.all([...machines].map((m) => machineObject(env, m).revoke(kid)));
  const closed = counts.reduce((a, b) => a + b, 0);
  console.log(`revoke ${kid} ${gone.addr} · отозвал ${f.from} · закрыто соединений ${closed} на ${machines.size} машинах`);
  return answer(ok(f.id, { addr: gone.addr, closed }));
}

/** Relay.deliver: кадр Worker'а объекту машины адреса → сколько получателей. Адрес без машины объекта не будит. */
export class Relay extends WorkerEntrypoint<Env> {
  deliver(f: Frame): number | Promise<number> {
    const machine = typeof f.to === "string" ? machineOf(f.to) : null;
    if (machine) return machineObject(this.env, machine).deliver(f);
    console.log(`offline ${f.from} → ${JSON.stringify(f.to)} · ${f.type}`);
    return 0;
  }
}

export default {
  fetch(req, env) {
    if (req.method === "POST") return entrance(req, env.GATE, (f) => revoke(f, env));
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("switchboard relay: wss /m/<машина> или POST keys.revoke\n", { status: 426 });
    const machine = /^\/m\/([\w-]+)$/.exec(new URL(req.url).pathname)?.[1];
    if (!machine) return new Response("switchboard relay: wss /m/<машина>\n", { status: 404 });
    return machineObject(env, machine).fetch(req);
  },
} satisfies ExportedHandler<Env>;
