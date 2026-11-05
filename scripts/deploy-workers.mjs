// Выпуск Worker-модулей. node scripts/deploy-workers.mjs [имена] [--env prod] — выкладка; --upload <номер> — загрузка версий всех Worker-модулей без выкладки.
// Веб — только по имени: phone, pult. Токены и секреты — из окружения или файлов ~/.switchboard-dev (SWITCHBOARD_DEV_DIR); окружение важнее файла, файл прода — тестовых.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DEV_DIR = process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev");
const STEP_S = 300; // при 45 с настоящая выкладка оборвалась на полпути: wrangler deploy под нагрузкой
const PROD_RELAY = "wss://relay.pfarm.app";
// relay последним: он смотрит привязками на остальных
const WORKERS = ["gate", "push", "points", "ledger", "github", "prefs", "releases", "relay"];
const WEB = ["phone", "pult"];

const fail = (word) => {
  console.error(`deploy: ${word}`);
  process.exit(1);
};

const { values: flags, positionals: names } = parseArgs({ strict: false, options: { upload: { type: "string" }, env: { type: "string" } } });
const prod = flags.env === "prod";
const envArgs = prod ? ["--env", "prod"] : [];
if (flags.upload !== undefined && !/^\d+\.\d+\.\d+$/.test(flags.upload)) fail("--upload <номер вида 1.1.58>");

/** Значения файлов: раньше в списке — важнее. Прод читает свой файл, тест его не видит. */
function fileValues() {
  const values = {};
  for (const name of [...(prod ? ["prod.env"] : []), "cf-deploy.env", "fleet-secrets.env", "r2-points.env"]) {
    const file = join(DEV_DIR, name);
    if (!existsSync(file)) continue;
    for (const [, key, value] of readFileSync(file, "utf8").matchAll(/^([A-Z0-9_]+)=(.*?)\r?$/gm)) values[key] ??= value;
  }
  return values;
}

const known = { ...fileValues(), ...process.env };
if (!known.CLOUDFLARE_API_TOKEN || !known.CLOUDFLARE_ACCOUNT_ID) fail("нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");
const childEnv = { ...process.env, CLOUDFLARE_API_TOKEN: known.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: known.CLOUDFLARE_ACCOUNT_ID, ...(prod ? { RELAY_URL: PROD_RELAY } : {}) };

// секрет Worker'а → откуда значение; тестовая пара R2 прав на бакет точек прода не имеет
const SECRETS = {
  push: { VAPID_PRIVATE: "VAPID_PRIVATE" },
  points: { R2_KEY_SECRET: prod ? "PROD_R2_SECRET_ACCESS_KEY" : "R2_SECRET_ACCESS_KEY" },
  releases: { CLOUDFLARE_API_TOKEN: "CLOUDFLARE_API_TOKEN", R2_LINK_KEY_ID: "R2_ACCESS_KEY_ID", R2_LINK_SECRET: "R2_SECRET_ACCESS_KEY" },
};

/** Шаг с пределом: не вышло — отказ словами, дальше не идём. Секрет — только через stdin. */
function step(what, cwd, args, input) {
  const r = spawnSync(process.execPath, args, { cwd, env: childEnv, input, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], timeout: STEP_S * 1000 });
  if (r.error?.code === "ETIMEDOUT") fail(`${what} — не завершился за ${STEP_S} с`);
  if (r.status !== 0) fail(`${what} — выход ${r.status}`);
}

/** Команда wrangler в папке модуля; в отказе — её слова без флагов. */
const wrangler = (folder, args, input) => step(`wrangler ${args.join(" ").split(" --")[0]} в ${folder}`, join(ROOT, folder), [WRANGLER, ...args], input);

if (flags.upload) {
  for (const w of WORKERS) {
    console.log(`\n=== workers/${w} ${flags.upload}${prod ? " prod" : ""} ===`);
    wrangler(`workers/${w}`, ["versions", "upload", ...envArgs, "--tag", flags.upload, "--message", flags.upload]);
  }
  console.log(`\ndeploy: загружено ${flags.upload}, ничего не выложено`);
  process.exit(0);
}

const workers = WORKERS.filter((w) => !names.length || names.includes(w));
const web = WEB.filter((w) => names.includes(w));
const title = (name) => console.log(`\n=== ${name}${prod ? " prod" : ""} ===`);
for (const w of workers) {
  title(w);
  const folder = `workers/${w}`;
  if (existsSync(join(ROOT, folder, "migrations"))) wrangler(folder, ["d1", "migrations", "apply", "DB", "--remote", ...envArgs]);
  wrangler(folder, ["deploy", ...envArgs]);
  for (const [secret, source] of Object.entries(SECRETS[w] ?? {})) {
    if (!known[source]) fail(`нет секрета ${source}`);
    wrangler(folder, ["secret", "put", secret, ...envArgs], known[source]);
  }
}
for (const w of web) {
  title(w);
  const folder = `web/${w}`;
  step(`сборка ${folder} не прошла`, join(ROOT, folder), ["build.mjs"]);
  wrangler(folder, ["deploy", ...envArgs]);
}
console.log(`\ndeploy: ok · ${[...workers, ...web].join(", ")}`);
