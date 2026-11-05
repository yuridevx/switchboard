// Выпуск Worker-модулей: сначала участники и gate, потом relay (его привязки смотрят на них).
// Токен деплоя и секреты — из переменных окружения (так в GitHub Actions), иначе из файлов env вне репо
// (SWITCHBOARD_DEV_DIR, по умолчанию ~/.switchboard-dev). Секреты уходят в wrangler только через stdin.
// Запуск: node scripts/deploy-workers.mjs [модуль…]   без списка — все; первую выкладку нового Worker и новых миграций
// делает только этот путь. node scripts/deploy-workers.mjs --upload <номер> — загрузка без выкладки (CI): каждый
// Worker-модуль — версией с меткой-номером; секреты не трогает, stable двигает «выпуски». Веб не загружает.
// --env prod — то же для прода: Worker'ы с суффиксом -prod на pfarm.app, свои секреты из prod.env.
// phone и pult в списке — сборка и выкладка веба (первая выкладка прода вешает домен).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS = ["gate", "push", "points", "ledger", "github", "prefs", "releases", "relay"];
const WEB = ["phone", "pult"];
/** Предел вызова сборки и wrangler: вдвое выше самого долгого шага загрузки в CI (22 с). */
const SPAWN_MS = 45_000;
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

const fail = (word) => {
  console.error(`deploy: ${word}`);
  process.exit(1);
};

/** Разбор командной строки: прод, загрузка с номером или список модулей. */
function parseArgs(argv) {
  const prod = argv.includes("--env") && argv[argv.indexOf("--env") + 1] === "prod";
  const rest = argv.filter((a, i) => a !== "--env" && argv[i - 1] !== "--env");
  if (rest[0] !== "--upload") return { prod, names: rest };
  if (!/^\d+\.\d+\.\d+$/.test(rest[1] ?? "")) fail("--upload <номер вида 1.1.58>");
  return { prod, upload: rest[1] };
}

/** Значения из файлов env: первый файл важнее. */
function fileValues(prod) {
  const dir = process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev");
  const values = {};
  for (const name of [...(prod ? ["prod.env"] : []), "cf-deploy.env", "fleet-secrets.env", "r2-points.env"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) values[line.slice(0, eq)] ??= line.slice(eq + 1);
    }
  }
  return values;
}

/**
 * Модуль → секреты: «ИМЯ=ИСТОЧНИК» — секрет модуля из значения с другим именем.
 * releases: токен API — выкладка версий Worker'ов; ключ R2 бакета выпусков — подпись ссылок на архивы.
 * points: секрет пары S3 токена R2 бакета точек — подпись ссылок на блоки; у прода своя пара (prod.env), тестовая прав на бакет прода не имеет.
 */
const secretsOf = (prod) => ({
  push: ["VAPID_PRIVATE"],
  points: [prod ? "R2_KEY_SECRET=PROD_R2_SECRET_ACCESS_KEY" : "R2_KEY_SECRET=R2_SECRET_ACCESS_KEY"],
  releases: ["CLOUDFLARE_API_TOKEN", "R2_LINK_KEY_ID=R2_ACCESS_KEY_ID", "R2_LINK_SECRET=R2_SECRET_ACCESS_KEY"],
});

/** Вызов не уложился в предел — причина словами. */
const lateWord = (r) => (r.error?.code === "ETIMEDOUT" ? ` — не завершился за ${SPAWN_MS / 1000} с` : "");

const { prod, upload, names = [] } = parseArgs(process.argv.slice(2));
const ENV_ARGS = prod ? ["--env", "prod"] : [];
// веб собирается с адресом relay своего флота
if (prod) process.env.RELAY_URL = "wss://relay.pfarm.app";
const fromFiles = fileValues(prod);
const value = (key) => process.env[key] || fromFiles[key];
const dirOf = (name) => join(root, WEB.includes(name) ? "web" : "workers", name);

const wranglerEnv = { ...process.env, CLOUDFLARE_API_TOKEN: value("CLOUDFLARE_API_TOKEN"), CLOUDFLARE_ACCOUNT_ID: value("CLOUDFLARE_ACCOUNT_ID") };
if (!wranglerEnv.CLOUDFLARE_API_TOKEN || !wranglerEnv.CLOUDFLARE_ACCOUNT_ID) fail("нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");

function runWrangler(cwd, args, input) {
  const r = spawnSync(process.execPath, [wrangler, ...args], { cwd, env: wranglerEnv, input, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], timeout: SPAWN_MS });
  if (r.status !== 0) fail(`wrangler ${args.join(" ")} в workers/${basename(cwd)} — выход ${r.status}${lateWord(r)}`);
}

function buildIfNeeded(cwd) {
  if (!existsSync(join(cwd, "build.mjs"))) return;
  const r = spawnSync(process.execPath, ["build.mjs"], { cwd, stdio: "inherit", timeout: SPAWN_MS });
  if (r.status !== 0) fail(`сборка ${cwd} не прошла${lateWord(r)}`);
}

function uploadAll(number) {
  for (const name of WORKERS) {
    console.log(`\n=== workers/${name} ${number}${prod ? " prod" : ""} ===`);
    runWrangler(dirOf(name), ["versions", "upload", ...ENV_ARGS, "--tag", number, "--message", number]);
  }
  console.log(`\ndeploy: загружено ${number}, ничего не выложено`);
}

function deployOne(name) {
  const cwd = dirOf(name);
  console.log(`\n=== ${name}${prod ? " prod" : ""} ===`);
  buildIfNeeded(cwd);
  // схема базы D1 модуля — миграциями wrangler до выкладки кода, который ею пользуется
  if (existsSync(join(cwd, "migrations"))) runWrangler(cwd, ["d1", "migrations", "apply", "DB", "--remote", ...ENV_ARGS]);
  runWrangler(cwd, ["deploy", ...ENV_ARGS]);
  for (const spec of secretsOf(prod)[name] ?? []) {
    const [secret, source = secret] = spec.split("=");
    const v = value(source);
    if (!v) fail(`нет секрета ${source}`);
    runWrangler(cwd, ["secret", "put", secret, ...ENV_ARGS], v);
  }
}

if (upload) {
  uploadAll(upload);
} else {
  const list = names.length ? [...WORKERS, ...WEB].filter((m) => names.includes(m)) : WORKERS;
  list.forEach(deployOne);
  console.log(`\ndeploy: ok · ${list.join(", ")}`);
}
