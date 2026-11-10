// Секреты служб v2 из файлов ~/.switchboard-dev: ключи R2 и ключ VAPID (заводится при первом запуске). Значения идут в wrangler через stdin.
// node tools/deploy/secrets.mjs
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(os.homedir(), ".switchboard-dev");
const read = (f) => Object.fromEntries(fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const cf = read("v2-cloudflare.env");
// SB2_ENV=prod — прод: настройки v2-prod.env, пользователь ClickHouse прода, wrangler --env prod
const prod = process.env.SB2_ENV === "prod";
const envFile = prod ? "v2-prod.env" : "v2-fleet.env";
let fleet = read(envFile);

if (!fleet.SB2_VAPID_PRIVATE) {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  fs.appendFileSync(path.join(dir, envFile), "SB2_VAPID_PRIVATE=" + jwk + "\n");
  fleet = read(envFile);
}

const secrets = {
  R2_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: cf.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: cf.R2_SECRET_ACCESS_KEY,
  VAPID_PRIVATE: fleet.SB2_VAPID_PRIVATE,
};
for (const k of ["CH_URL", "CH_USER", "CH_PASSWORD"]) if (fleet["SB2_" + k]) secrets[k] = fleet["SB2_" + k];
// ClickHouse старой системы (слово пользователя 10 нояб. 2026: «бери старый»): тестовый пользователь, своя таблица sb2_calls
const oldCh = path.join(dir, "clickhouse.env");
if (!secrets.CH_URL && fs.existsSync(oldCh)) {
  const ch = read("clickhouse.env");
  Object.assign(secrets, { CH_URL: fleet.SB2_CH_URL ?? "https://ch.pfarm.app", CH_USER: prod ? ch.CH_USER_PROD : ch.CH_USER_TEST, CH_PASSWORD: prod ? ch.CH_PASSWORD_PROD : ch.CH_PASSWORD_TEST, CH_ACCESS_ID: ch.CH_ACCESS_ID, CH_ACCESS_SECRET: ch.CH_ACCESS_SECRET });
}

const r = spawnSync(process.execPath, [path.join(here, "wrangler.mjs"), "services", "secret", "bulk", ...(prod ? ["--env", "prod"] : [])], { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"] });
console.log("секреты служб:", Object.keys(secrets).join(", "));
process.exit(r.status ?? 1);
