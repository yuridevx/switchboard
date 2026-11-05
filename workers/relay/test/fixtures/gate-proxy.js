// Привязка GATE в тестах relay: настоящий gate за переключателем режима.
// real — настоящий gate над базой стенда; throw — gate сломан; slow — отвечает с задержкой; hang — молчит дольше предела вызова.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls = [];
let mode = "real";
// номера, отозванные «новым выпуском gate» после входа соединения
let revokedLater = [];

export class Gate extends WorkerEntrypoint {
  async verify(key) {
    calls.push(key);
    if (mode === "throw") throw new Error("gate сломан");
    if (mode === "hang") await new Promise((r) => setTimeout(r, 10_000));
    if (mode === "slow") await new Promise((r) => setTimeout(r, 300));
    // отзыв «новым выпуском gate» — и на входе, как у настоящего gate
    if (revokedLater.includes(String(key).split(".").slice(0, 3).join("."))) return { error: "bad_key" };
    return this.env.REAL.verify(key);
  }
  revoke(kid) {
    return this.env.REAL.revoke(kid);
  }
  list(role) {
    return this.env.REAL.list(role);
  }
  revokeLater(ids) {
    revokedLater = ids;
  }
  setMode(m) {
    mode = m;
  }
  calls() {
    return calls;
  }
  clear() {
    calls.length = 0;
    revokedLater = [];
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
