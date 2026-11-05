// Снесено: стенд отказывает словом, пока не написан заново.
const SCRIPT = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Gate extends WorkerEntrypoint {
  verify() { return { error: "снесено" }; }
  revoke() { return { error: "снесено" }; }
  revoked() { return ["снесено"]; }
  setHosts() {}
  list() { return [{ name: "снесено" }]; }
}
export default { fetch: () => new Response(null, { status: 500 }) };
`;

export const gateStand = () => ({ name: "switchboard-gate", modules: true, script: SCRIPT, compatibilityDate: "2026-08-01" });
