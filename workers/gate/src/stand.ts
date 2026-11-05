// Стенд gate для тестов соседей: Worker текстом для miniflare, пропуска без базы. Секрет bad — отказ, остальное по виду пропуска.
import { PASS } from "./format.ts";

const script = `
import { WorkerEntrypoint } from "cloudflare:workers";

const PASS = ${PASS};
const gone = new Set();
let hosts = [];
const kidOf = (id) => id.split(".").at(-1);

export class Gate extends WorkerEntrypoint {
  verify(key) {
    const m = PASS.exec(key);
    if (!m || m[4] === "bad" || gone.has(m[3])) return { error: "bad_key" };
    const [, role, name, kid] = m;
    return { role, name, kid, addr: role === "host" ? "@" + name : name + "~test@example.com" };
  }
  revoke(kid) {
    gone.add(kid);
    return { addr: "?" };
  }
  revoked(ids) {
    return ids.filter((id) => gone.has(kidOf(id)));
  }
  list(role) {
    if (role === "client") return [];
    return hosts.map((name) => ({ id: name, role: "host", name, person: null, addr: "@" + name, state: "ok", by: "stand", at: 0 }));
  }
  setHosts(names) {
    hosts = names;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
`;

export const gateStand = () => ({ name: "switchboard-gate", modules: true, compatibilityDate: "2026-08-01", script });
