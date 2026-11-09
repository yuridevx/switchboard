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
let fleet = read("v2-fleet.env");

if (!fleet.SB2_VAPID_PRIVATE) {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  fs.appendFileSync(path.join(dir, "v2-fleet.env"), "SB2_VAPID_PRIVATE=" + jwk + "\n");
  fleet = read("v2-fleet.env");
}

const secrets = {
  R2_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: cf.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: cf.R2_SECRET_ACCESS_KEY,
  VAPID_PRIVATE: fleet.SB2_VAPID_PRIVATE,
};
for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT", "CH_URL", "CH_USER", "CH_PASSWORD"]) if (fleet["SB2_" + k]) secrets[k] = fleet["SB2_" + k];

const r = spawnSync(process.execPath, [path.join(here, "wrangler.mjs"), "services", "secret", "bulk"], { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"] });
console.log("секреты служб:", Object.keys(secrets).join(", "));
process.exit(r.status ?? 1);
