// Привязка GATE в тестах relay: настоящий gate за переключателем режима.
// real — настоящий gate над базой стенда; throw — gate сломан; slow — отвечает с задержкой; hang — молчит дольше предела вызова;
// revoke-throw, list-throw, revoke-hang, list-hang — verify настоящий, подводит этот метод.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls = [];
let mode = "real";

async function fail(method) {
  if (mode === `${method}-throw`) throw new Error(`${method} сломан`);
  if (mode === `${method}-hang`) await new Promise((r) => setTimeout(r, 10_000));
}

export class Gate extends WorkerEntrypoint {
  async verify(key) {
    calls.push(key);
    if (mode === "throw") throw new Error("gate сломан");
    if (mode === "hang") await new Promise((r) => setTimeout(r, 10_000));
    if (mode === "slow") await new Promise((r) => setTimeout(r, 300));
    return this.env.REAL.verify(key);
  }
  async revoke(kid) {
    await fail("revoke");
    return this.env.REAL.revoke(kid);
  }
  async list(role) {
    await fail("list");
    return this.env.REAL.list(role);
  }
  setMode(m) {
    mode = m;
  }
  calls() {
    return calls;
  }
  clear() {
    calls.length = 0;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
