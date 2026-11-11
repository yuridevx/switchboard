// Срок токена Cloudflare v2: показать и продлить (слово пользователя 10 нояб. 2026: «токен продлевай себе сам»).
// node tools/deploy/token.mjs            — показать срок
// node tools/deploy/token.mjs extend 30  — продлить на столько дней от сегодня
// Токен — из ~/.switchboard-dev/v2-cloudflare.env; значение токена не меняется и не печатается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".switchboard-dev", "v2-cloudflare.env");
const env = Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const acc = env.CLOUDFLARE_ACCOUNT_ID;
const api = async (p, init = {}) => {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { ...init, headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, "content-type": "application/json" } });
  const j = await r.json();
  if (!j.success) throw new Error(`${p}: HTTP ${r.status} ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.result;
};

const seen = await api(`/accounts/${acc}/tokens/verify`);
console.log(`токен ${seen.id}: ${seen.status}, действует до ${seen.expires_on ?? "без срока"}`);
if (process.argv[2] === "extend") {
  const days = Number(process.argv[3] ?? 30);
  const t = await api(`/accounts/${acc}/tokens/${seen.id}`);
  const until = new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const body = { name: t.name, status: t.status, policies: t.policies, not_before: t.not_before, expires_on: until, ...(t.condition ? { condition: t.condition } : {}) };
  const done = await api(`/accounts/${acc}/tokens/${seen.id}`, { method: "PUT", body: JSON.stringify(body) });
  console.log(`продлён до ${done.expires_on}; правил: ${done.policies.length}`);
}
