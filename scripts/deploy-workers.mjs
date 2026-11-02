// Выпуск Worker-модулей: сначала участники и gate, потом relay (его привязки смотрят на них).
// Токен деплоя и секреты — из переменных окружения (так в GitHub Actions), иначе из файлов env вне репо
// (SWITCHBOARD_DEV_DIR, по умолчанию ~/.switchboard-dev). Секреты уходят в wrangler только через stdin.
// Запуск: node scripts/deploy-workers.mjs [модуль…]   без списка — все; первую выкладку нового Worker и новых миграций
// делает только этот путь. node scripts/deploy-workers.mjs --upload <номер> — загрузка без выкладки (CI): каждая часть
// Cloudflare, включая телефон и пульт, — версией с меткой-номером; секреты не трогает, stable двигает «выпуски».
// --env prod — то же для прода: Worker'ы с суффиксом -prod на pfarm.app, свой FLEET_SECRET из prod.env.
// phone и pult в списке — сборка и выкладка веба (первая выкладка прода вешает домен).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev");
const args = process.argv.slice(2);
const prod = args.includes("--env") && args[args.indexOf("--env") + 1] === "prod";
const rest = args.filter((a, i) => a !== "--env" && args[i - 1] !== "--env");
// prod.env первым: его FLEET_SECRET важнее тестового
const FILES = [...(prod ? ["prod.env"] : []), "cf-deploy.env", "fleet-secrets.env", "r2-points.env"];

const fromFiles = {};
for (const f of FILES) {
  const p = join(dev, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) fromFiles[line.slice(0, i)] ??= line.slice(i + 1);
  }
}
const val = (k) => process.env[k] || fromFiles[k];

// модуль → секреты, которые кладутся в него; «ИМЯ=ИСТОЧНИК» — секрет модуля из значения с другим именем.
// releases: токен API — выкладка версий Worker'ов; ключ R2 бакета выпусков — подпись ссылок на архивы
const SECRETS = {
  gate: ["FLEET_SECRET"],
  push: ["VAPID_PRIVATE"],
  points: ["R2_TOKEN"],
  releases: ["CLOUDFLARE_API_TOKEN", "R2_LINK_KEY_ID=R2_ACCESS_KEY_ID", "R2_LINK_SECRET=R2_SECRET_ACCESS_KEY"],
};
const ORDER = ["gate", "push", "points", "ledger", "github", "releases", "relay"];
const WEB = ["phone", "pult"];
const upload = rest[0] === "--upload" ? rest[1] : undefined;
if (rest[0] === "--upload" && !/^\d+\.\d+\.\d+$/.test(upload ?? "")) {
  console.error("deploy: --upload <номер вида 1.1.58>");
  process.exit(1);
}
const want = upload ? [] : rest;
const list = want.length ? [...ORDER, ...WEB].filter((m) => want.includes(m)) : ORDER;
const ENV = prod ? ["--env", "prod"] : [];
// веб собирается с адресом relay своего флота
if (prod) process.env.RELAY_URL = "wss://relay.pfarm.app";
const dirOf = (m) => join(root, WEB.includes(m) ? "web" : "workers", m);
function build(dir) {
  if (existsSync(join(dir, "build.mjs")) && spawnSync(process.execPath, ["build.mjs"], { cwd: dir, stdio: "inherit" }).status !== 0) {
    console.error(`deploy: сборка ${dir} не прошла`);
    process.exit(1);
  }
}

const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const base = { ...process.env, CLOUDFLARE_API_TOKEN: val("CLOUDFLARE_API_TOKEN"), CLOUDFLARE_ACCOUNT_ID: val("CLOUDFLARE_ACCOUNT_ID") };
if (!base.CLOUDFLARE_API_TOKEN || !base.CLOUDFLARE_ACCOUNT_ID) {
  console.error("deploy: нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

function run(cwd, args, input) {
  const r = spawnSync(process.execPath, [wrangler, ...args], { cwd, env: base, input, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`deploy: wrangler ${args.join(" ")} в workers/${cwd.split(/[\\/]/).pop()} — выход ${r.status}`);
    process.exit(1);
  }
}

if (upload) {
  for (const dir of [...ORDER, ...WEB].map(dirOf)) {
    console.log(`\n=== ${dir.split(/[\\/]/).slice(-2).join("/")} ${upload}${prod ? " prod" : ""} ===`);
    build(dir);
    run(dir, ["versions", "upload", ...ENV, "--tag", upload, "--message", upload]);
  }
  console.log(`\ndeploy: загружено ${upload}, ничего не выложено`);
  process.exit(0);
}

for (const m of list) {
  const cwd = dirOf(m);
  if (!existsSync(cwd)) {
    console.error(`deploy: нет ${cwd}`);
    process.exit(1);
  }
  console.log(`\n=== ${m}${prod ? " prod" : ""} ===`);
  build(cwd);
  run(cwd, ["deploy", ...ENV]);
  for (const s of SECRETS[m] ?? []) {
    const [k, from = k] = s.split("=");
    const v = val(from);
    if (!v) {
      console.error(`deploy: нет секрета ${from}`);
      process.exit(1);
    }
    run(cwd, ["secret", "put", k, ...ENV], v);
  }
}
console.log("\ndeploy: ok · " + list.join(", "));
