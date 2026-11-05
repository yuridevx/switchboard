// снесено
export const gateStand = () => ({
  name: "switchboard-gate",
  modules: true,
  compatibilityDate: "2026-08-01",
  script: `import { WorkerEntrypoint } from "cloudflare:workers"; export class Gate extends WorkerEntrypoint { verify() { throw new Error("снесено"); } } export default { fetch() { return new Response("снесено", { status: 501 }); } };`,
});
