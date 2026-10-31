// Привязка GATE в тестах relay: настоящий gate за переключателем режима.
// real — настоящий gate с секретом теста; nosecret — настоящий gate без FLEET_SECRET; throw — gate не ответил.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls = [];
let mode = "real";

export class Gate extends WorkerEntrypoint {
  async verify(key) {
    calls.push(key);
    if (mode === "throw") throw new Error("gate сломан");
    return (mode === "nosecret" ? this.env.NOSECRET : this.env.REAL).verify(key);
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
