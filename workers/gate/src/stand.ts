// Стенд gate для тестов чужих Worker'ов в miniflare: Worker switchboard-gate с входом Gate без базы.
// Пропуск стенда role.name.kid.<любой секрет>; секрет «bad» и отозванный номер — bad_key;
// адрес — @имя у машины, имя~test@example.com у клиента; машины флота для list — setHosts(имена).
const SCRIPT = `import { WorkerEntrypoint } from "cloudflare:workers";

const revokedKids = new Set();
const kidOf = (id) => id.slice(id.lastIndexOf(".") + 1);
let hosts = [];

export class Gate extends WorkerEntrypoint {
  async verify(key) {
    const [role, name, kid, secret, ...rest] = String(key ?? "").split(".");
    if (secret === undefined || rest.length || (role !== "host" && role !== "client") || secret === "bad" || revokedKids.has(kid)) return { error: "bad_key" };
    return { role, name, kid, addr: role === "host" ? "@" + name : name + "~test@example.com" };
  }
  async revoke(kid) {
    revokedKids.add(kid);
    return { addr: "?" };
  }
  async revoked(ids) {
    return ids.filter((id) => revokedKids.has(kidOf(id)));
  }
  /** машины флота стенда — задаёт тест */
  setHosts(names) {
    hosts = names;
  }
  async list(role) {
    if (role === "client") return [];
    return hosts.map((name) => ({ id: name, role: "host", name, person: null, addr: "@" + name, state: "ok", by: "stand", at: 0 }));
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
`;

/** Описание Worker'а для miniflare.workers: привязка { service: "switchboard-gate", entrypoint: "Gate" } найдёт его. */
export const gateStand = () => ({ name: "switchboard-gate", modules: true, script: SCRIPT, compatibilityDate: "2026-08-01" });
