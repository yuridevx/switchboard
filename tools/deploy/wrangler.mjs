// wrangler с токеном Cloudflare из ~/.switchboard-dev/v2-cloudflare.env: токен идёт окружением, не аргументом.
// node tools/deploy/wrangler.mjs <пакет> <аргументы wrangler…>; stdin передаётся дальше (для `secret put`).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = process.env.SB2_CLOUDFLARE_ENV ?? path.join(os.homedir(), ".switchboard-dev", "v2-cloudflare.env");
const env = { ...process.env };
for (const l of fs.readFileSync(file, "utf8").split("\n")) {
  if (!l || l.startsWith("#")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i)] = l.slice(i + 1).trim();
}
const [pkg, ...args] = process.argv.slice(2);
const r = spawnSync("npx", ["wrangler", ...args], { cwd: path.join(root, pkg), env, stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
