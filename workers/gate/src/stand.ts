// Стенд gate для тестов чужих Worker'ов в miniflare: Worker switchboard-gate с входом Gate без базы.
// Пропуск стенда role.name.kid.<любой секрет>; секрет «bad» — bad_key, «revoked» — revoked;
// адрес — @имя у машины, имя~test@example.com у клиента.
const SCRIPT = "import { WorkerEntrypoint } from \"cloudflare:workers\";\n\nconst revokedKids = new Set();\n\nexport class Gate extends WorkerEntrypoint {\n  async verify(key) {\n    const p = String(key ?? \"\").split(\".\");\n    if (p.length !== 4 || (p[0] !== \"host\" && p[0] !== \"client\") || p[3] === \"bad\") return { error: \"bad_key\" };\n    if (p[3] === \"revoked\" || revokedKids.has(p[2])) return { error: \"revoked\" };\n    return { role: p[0], name: p[1], kid: p[2], addr: p[0] === \"host\" ? `@${p[1]}` : `${p[1]}~test@example.com` };\n  }\n  async revoke(kid) {\n    revokedKids.add(kid);\n    return { addr: \"?\" };\n  }\n  async revoked(ids) {\n    return ids.filter((id) => revokedKids.has(id.slice(id.lastIndexOf(\".\") + 1)));\n  }\n  async list() {\n    return [];\n  }\n}\n\nexport default { fetch: () => new Response(null, { status: 404 }) };\n";

/** Описание Worker'а для miniflare.workers: привязка { service: "switchboard-gate", entrypoint: "Gate" } найдёт его. */
export const gateStand = () => ({ name: "switchboard-gate", modules: true, script: SCRIPT, compatibilityDate: "2026-08-01" });
