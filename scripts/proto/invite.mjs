// Приглашение клиента прода для прототипа: у gate приложения пропуском агента; секрет — из файла, ссылка — в файл.
//   node scripts/proto/invite.mjs <имя устройства> <почта> <файл ссылки> [--port 4800] [--app pult]
//   пропуск агента — PROTO_AGENT_PASS (путь к файлу), по умолчанию ~/.switchboard-dev/prod-agent.pass
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const port = flag("--port", "4800");
const app = flag("--app", "pult");
const [name, person, out] = args;
if (!name || !person || !out) {
  console.error("нужно: <имя устройства> <почта> <файл ссылки> [--port 4800] [--app pult]");
  process.exit(1);
}
const list = await fetch(`https://${app}.pfarm.app/build.json`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
const key = fs.readFileSync(process.env.PROTO_AGENT_PASS ?? path.join(os.homedir(), ".switchboard-dev", "prod-agent.pass"), "utf8").trim();
const r = await fetch(list.workers.gate, { method: "POST", body: JSON.stringify({ type: "keys.invite", id: "proto-invite", v: 1, key, role: "client", name, person }), signal: AbortSignal.timeout(10_000) }).then((x) => x.json());
if (!r.ok) {
  console.error(`отказ gate: ${r.error}${r.why ? ` — ${r.why}` : ""}`);
  process.exit(1);
}
fs.appendFileSync(out, `${r.result.addr}: http://localhost:${port}/?app=${app}#invite=${encodeURIComponent(r.result.invite)}\n`);
console.log(`приглашение ${r.result.addr} · номер ${r.result.kid} → ${out}`);
