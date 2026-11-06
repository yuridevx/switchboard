// Выпуск Worker-модулей и страниц: wrangler с пределом, секреты только через stdin.
//   node scripts/deploy-workers.mjs [имена] [--env prod]   выложить; без имён — все Worker-модули
//   node scripts/deploy-workers.mjs --upload <номер> [--env prod]   загрузить версии без выкладки (CI)
// Токены и секреты — окружение, затем файлы ~/.switchboard-dev (SWITCHBOARD_DEV_DIR); тестовый флот файла прода не читает.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
/** Настоящая выкладка 5 нояб.: при 45 с wrangler выложил prefs, но не завершился под нагрузкой. */
const LIMIT_MS = 300_000;
/** relay смотрит привязками на остальных — последним. */
const WORKERS = ["gate", "push", "points", "ledger", "github", "prefs", "releases", "relay"];
const WEB = ["phone", "pult"];

const stop = (word) => {
  console.error(`deploy: ${word}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const env = flag("--env");
const upload = flag("--upload");
if (env !== undefined && env !== "prod") stop("--env — только prod");
if (upload !== undefined && !/^\d+\.\d+\.\d+$/.test(upload)) stop("--upload <номер вида 1.1.58>");
const prod = env === "prod";
const envArgs = prod ? ["--env", "prod"] : [];
const tail = prod ? " prod" : "";

/** Значения из файлов: первый файл важнее следующих, окружение важнее файлов. */
const dev = process.env.SWITCHBOARD_DEV_DIR ?? path.join(homedir(), ".switchboard-dev");
const files = [...(prod ? ["prod.env"] : []), "cf-deploy.env", "fleet-secrets.env", "r2-points.env"].map((f) => path.join(dev, f)).filter(existsSync);
const pairs = files.reverse().flatMap((f) => [...readFileSync(f, "utf8").matchAll(/^([A-Z0-9_]+)=(.*?)\r?$/gm)].map((m) => [m[1], m[2]]));
const known = { ...Object.fromEntries(pairs), ...process.env };
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = known;
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) stop("нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");

/** Имя секрета Worker'а → значение. Тестовая пара прав на бакет прода не имеет: точки прода — свой секрет. */
const secrets = {
  push: { VAPID_PRIVATE: "VAPID_PRIVATE" },
  points: { R2_KEY_SECRET: prod ? "PROD_R2_SECRET_ACCESS_KEY" : "R2_SECRET_ACCESS_KEY" },
  releases: { CLOUDFLARE_API_TOKEN: "CLOUDFLARE_API_TOKEN", R2_LINK_KEY_ID: "R2_ACCESS_KEY_ID", R2_LINK_SECRET: "R2_SECRET_ACCESS_KEY" },
};

const childEnv = { ...process.env, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID };
function run(program, words, cwd, what, input) {
  const r = spawnSync(process.execPath, [program, ...words], { cwd: path.join(ROOT, cwd), env: childEnv, input, stdio: ["pipe", "inherit", "inherit"], timeout: LIMIT_MS });
  if (r.error?.code === "ETIMEDOUT") stop(`${what} в ${cwd} — не завершился за ${LIMIT_MS / 1000} с`);
  return r.status;
}
function wrangler(cwd, words, after = [], input) {
  const what = `wrangler ${words.slice(0, 2).join(" ")}`;
  const status = run(WRANGLER, [...words, ...envArgs, ...after], cwd, what, input);
  if (status !== 0) stop(`${what} в ${cwd} — выход ${status}`);
}

if (upload) {
  for (const name of WORKERS) {
    console.log(`=== workers/${name} ${upload}${tail} ===`);
    wrangler(`workers/${name}`, ["versions", "upload"], ["--tag", upload, "--message", upload]);
  }
  console.log(`deploy: загружено ${upload}, ничего не выложено`);
  process.exit(0);
}

const named = args.length ? args : WORKERS;
const workers = WORKERS.filter((w) => named.includes(w));
const web = WEB.filter((w) => named.includes(w));
for (const w of workers) for (const from of Object.values(secrets[w] ?? {})) if (!known[from]) stop(`нет секрета ${from}`);

for (const name of workers) {
  const cwd = `workers/${name}`;
  console.log(`=== ${name}${tail} ===`);
  if (existsSync(path.join(ROOT, cwd, "migrations"))) wrangler(cwd, ["d1", "migrations", "apply", "DB", "--remote"]);
  wrangler(cwd, ["deploy"]);
  for (const [secret, from] of Object.entries(secrets[name] ?? {})) wrangler(cwd, ["secret", "put", secret], [], known[from]);
}
for (const name of web) {
  const cwd = `web/${name}`;
  console.log(`=== ${name}${tail} ===`);
  if (run("build.mjs", [], cwd, `сборка ${cwd}`) !== 0) stop(`сборка ${cwd} не прошла`);
  wrangler(cwd, ["deploy"]);
}
console.log(`deploy: ok · ${[...workers, ...web].join(", ")}`);
