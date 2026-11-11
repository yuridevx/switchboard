// Стенд gate для тестов соседей: Worker текстом для miniflare, пропуска без базы. Секрет bad — отказ.
// Адрес по подписи: машины из setHosts — @подпись, остальные — подпись~test@example.com.
import { PASS } from "./format.ts";

const script = `
import { WorkerEntrypoint } from "cloudflare:workers";

const PASS = ${PASS};
const gone = new Set();
let hosts = [];

export class Gate extends WorkerEntrypoint {
  verify(key) {
    const m = PASS.exec(key);
    if (!m || m[3] === "bad" || gone.has(m[2])) return { error: "bad_key" };
    const [, label, kid] = m;
    const name = label.split(".").at(-1);
    return { kid, addr: label.startsWith("host.") || hosts.includes(name) ? "@" + name : name + "~test@example.com" };
  }
  revoke(kid) {
    gone.add(kid);
    return { addr: "?" };
  }
  list(o = {}) {
    const machines = hosts.map((name) => ({ kid: name, addr: "@" + name, owner: null, wait: false }));
    if (o.ids) return o.ids.filter((id) => !gone.has(id)).map((kid) => ({ kid, addr: kid + "~test@example.com", owner: null, wait: false }));
    return o.kind && o.kind !== "machine" ? [] : machines;
  }
  setHosts(names) {
    hosts = names;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
`;

export const gateStand = () => ({ name: "switchboard-gate", modules: true, compatibilityDate: "2026-08-01", script });
