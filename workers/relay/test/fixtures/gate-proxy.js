// Привязка GATE в тестах relay: настоящий gate за переключателем режима.
// real — настоящий gate с секретом теста; nosecret — настоящий gate без FLEET_SECRET; throw — gate не ответил.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls = [];
let mode = "real";
// номера, отозванные «новым выпуском gate» после входа соединения
let revokedLater = [];

export class Gate extends WorkerEntrypoint {
  async verify(key) {
    calls.push(key);
    if (mode === "throw") throw new Error("gate сломан");
    // отзыв «новым выпуском gate» — и на входе, как у настоящего gate
    if (revokedLater.includes(String(key).split(".").slice(0, 3).join("."))) return { error: "revoked" };
    return (mode === "nosecret" ? this.env.NOSECRET : this.env.REAL).verify(key);
  }
  async revoked(ids) {
    if (mode === "throw") throw new Error("gate сломан");
    if (mode === "hang") return new Promise((r) => setTimeout(() => r([]), 10_000));
    const real = await this.env.REAL.revoked(ids);
    return [...new Set([...real, ...ids.filter((id) => revokedLater.includes(id))])];
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
