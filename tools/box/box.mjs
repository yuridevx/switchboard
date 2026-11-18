// Флот в коробке: весь Switchboard на одном компьютере — без Cloudflare, машин флота, ключей и аккаунтов.
//   node tools/box/box.mjs <команда…>   поднять, выполнить команду, снять; код выхода — её
//   node tools/box/box.mjs              поднять и держать: печатает адрес страницы со входом; Ctrl+C — снять
// Что поднимается: платформа и службы (wrangler dev на этом компьютере, свои порты и своя папка данных), страница из web/dist,
// хранилище — локальный R2 служб и вход в него по подписанным ссылкам (tools/box/storage),
// машины m1 и m2: сборка Host уходит в каталог флота шагом «машины» выкладки, ставит и держит Host служба машины из этой же сборки;
// claude — настоящий, из пакета SDK; поддельная модель — ключ провайдера «box».
// Команда получает: SB2_DEV — папка настроек (адрес флота, пропуск устройства cli), SB2_KEY, SB2_MODEL, SB2_SWITCH — ключ и модели коробки.
// Сбой подъёма или красная команда — хвосты журналов частей. Папка коробки dist/box/<номер процесса> после зелёной команды убирается.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage } from "../build/page.mjs";
import * as github from "./github.mjs";
import { MODELS, serve } from "./model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv.slice(2);
const FLEET = "box", DEVICE = "cli", MACHINES = ["m1", "m2"], KEY = "box";
// чего в коробке нет: проверки и шаги, которым это нужно, на ней не идут (tools/fleet/harness.mjs, lacks)
// история флота — настоящий ClickHouse: коробка его не запускает, а получает адрес в SB2_BOX_CH (http://пользователь:пароль@хост:порт);
// на раннере это служба работы, у себя — `docker run -p 127.0.0.1:18123:8123 -e CLICKHOUSE_PASSWORD=box clickhouse/clickhouse-server`
const history = process.env.SB2_BOX_CH ? new URL(process.env.SB2_BOX_CH) : null;
const WITHOUT = ["mind", "push", ...(history ? [] : ["clickhouse"])].join(" ");
const ACCOUNTS = ["a", "b"];
const DIALECTS = ["openai", "meta"];
const UP_MS = 60_000; // предел подъёма одной части
const MACHINES_MS = 5 * 60_000; // предел, за который службы машин ставят Host из сборки и выходят на связь
const win = process.platform === "win32";
const state = path.join(root, "dist", "box", String(process.pid));
fs.mkdirSync(state, { recursive: true });

const t0 = Date.now();
const say = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с · ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// порт части — случайный из 20000–29999 и проверенный: ниже диапазона, из которого ОС раздаёт временные порты.
// Порт, взятый у ОС (listen 0), до старта части успевал занять соседний процесс — сам из того же диапазона.
const taken = new Set();
const freePort = () => new Promise((done) => {
  const port = 20000 + Math.floor(Math.random() * 10000);
  if (taken.has(port)) return void done(freePort());
  taken.add(port);
  const s = net.createServer();
  s.once("error", () => done(freePort()));
  s.listen(port, "127.0.0.1", () => s.close(() => done(port)));
});
async function until(what, fn, ms = UP_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался за ${ms / 1000} с: ${what}`);
    await sleep(300);
  }
}

/** Части коробки — процессы со своим журналом в папке коробки. */
const parts = [];
function start(name, file, args, env, stdin = "ignore") {
  const log = fs.openSync(path.join(state, name + ".log"), "a");
  const child = spawn(file, args, { cwd: root, stdio: [stdin, log, log], detached: !win, windowsHide: true, env: { ...process.env, ...env } });
  parts.push({ name, child });
  return child;
}
/** Служба машины на переднем плане. После обновления себя она выходит с кодом 3: в системе её поднимает ОС, здесь — коробка. */
function keep(name, bin, home, gitconfig) {
  // общий файл настроек git машины — коробки: в нём подмена адреса GitHub на репозиторий с диска
  const child = start("keeper-" + name, bin, ["run"], { SB_HOME: home, GIT_CONFIG_GLOBAL: gitconfig });
  child.on("exit", (code) => { if (code === 3 && !down) keep(name, bin, home, gitconfig); });
}
/** Снять процесс вместе с потомками. */
function killTree(pid) {
  try {
    if (win) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // процесса уже нет
  }
}
const tails = () => [...new Set(parts.map((p) => p.name)), "model"].filter((name) => fs.existsSync(path.join(state, name + ".log"))).map((name) => `── ${name}\n${fs.readFileSync(path.join(state, name + ".log"), "utf8").split("\n").slice(-12).join("\n")}`).join("\n");

let down = false;
/** Снять коробку: службы машин, всё, что у держателей (Host и процессы сессий), и Worker'ы. */
async function teardown() {
  if (down) return;
  down = true;
  // сначала службы машин и Worker'ы: живая служба подняла бы снятый Host снова
  for (const { child } of parts) if (child.exitCode === null) killTree(child.pid);
  for (const m of MACHINES) {
    const procs = path.join(state, m, "procs");
    for (const f of fs.existsSync(procs) ? fs.readdirSync(procs).filter((n) => n.endsWith(".json")) : []) {
      try { killTree(JSON.parse(fs.readFileSync(path.join(procs, f), "utf8")).pid); } catch { /* файл держателя дописывают */ }
    }
  }
  for (const { child } of parts) if (child.exitCode === null) killTree(child.pid);
  model?.close();
  githubApi?.close();
}

let model, githubApi;
async function up() {
  buildPage(root);
  say("страница собрана");
  const [pModel, pPlatform, pServices, iPlatform, iServices, pGithub] = await Promise.all([1, 2, 3, 4, 5, 6].map(freePort));
  model = await serve(pModel, (line) => fs.appendFileSync(path.join(state, "model.log"), line + "\n"));
  const base = `http://127.0.0.1:${pServices}`, platform = `http://127.0.0.1:${pPlatform}`;

  // свой реестр wrangler: службы находят платформу этой коробки, а не соседней
  const wrangler = (name, port, inspector, vars, configs) => start(name, process.execPath, [
    path.join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", ...configs.flatMap((c) => ["-c", c]), "--port", String(port), "--ip", "127.0.0.1",
    // папка данных — своя у каждого процесса: общего хранилища у платформы и служб нет, а на общей папке их старты сталкивались («database is locked»)
    "--inspector-port", String(inspector), "--persist-to", path.join(state, "data", name), "--show-interactive-dev-session=false", ...vars.flatMap((v) => ["--var", v]),
  ], { WRANGLER_REGISTRY_PATH: path.join(state, "registry"), WRANGLER_SEND_METRICS: "false", CI: "1" });
  wrangler("platform", pPlatform, iPlatform, ["BOOT:box", "DIGEST:box"], [path.join(root, "platform/wrangler.jsonc")]);
  if (history) await until(`ClickHouse по адресу ${history.origin}`, async () => (await fetch(history.origin + "/ping", { signal: AbortSignal.timeout(3000) })).ok);
  // Службы и вход хранилища по подписанным ссылкам — один процесс: бакет у них общий, локальный R2 (двум процессам на одной базе бакета тесно:
  // «database is locked»). Первым стоит вход (tools/box/storage): подписанную ссылку принимает сам, всё остальное отдаёт службам привязкой.
  // Настройки из --var до второго Worker'а не доходят, поэтому у служб — производная настройка: та же, что в репо, с адресами коробки.
  const product = JSON.parse(fs.readFileSync(path.join(root, "services/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const { env: _prod, ...local } = product;
  const bucket = product.r2_buckets[0].bucket_name;
  const secret = { R2_ACCESS_KEY_ID: "box", R2_SECRET_ACCESS_KEY: "box-secret-0000" };
  const ch = history ? { CH_URL: history.origin, CH_USER: decodeURIComponent(history.username) || "default", CH_PASSWORD: decodeURIComponent(history.password) } : {};
  fs.writeFileSync(path.join(state, "services.jsonc"), JSON.stringify({ ...local, main: path.join(root, "services", product.main), assets: { ...product.assets, directory: path.join(root, "web/dist") }, vars: { ...product.vars, DIGEST: "box", R2_ENDPOINT: base, GITHUB_API: `http://127.0.0.1:${pGithub}`, ...secret, ...ch } }));
  fs.writeFileSync(path.join(state, "storage.jsonc"), JSON.stringify({ name: "sb2-box-storage", main: path.join(root, "tools/box/storage/worker.js"), compatibility_date: product.compatibility_date, r2_buckets: [{ binding: "FILES", bucket_name: bucket }], services: [{ binding: "SERVICES", service: product.name }], vars: { FILES_BUCKET: bucket, ...secret } }));
  wrangler("services", pServices, iServices, [], [path.join(state, "storage.jsonc"), path.join(state, "services.jsonc")]);
  const healthy = (url) => until(url, async () => (await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()).ok);
  await Promise.all([healthy(platform + "/health"), healthy(base + "/health")]);
  await healthy(base + "/health/platform");
  say("платформа и службы отвечают");

  let n = 0;
  const call = async (type, fields = {}, key = "") => {
    const r = await (await fetch(base + "/call", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) }, body: JSON.stringify({ type, id: "box" + ++n, ...fields }) })).json();
    if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`);
    return r.result;
  };
  const boot = await (await fetch(platform + "/boot", { method: "POST", headers: { authorization: "Bearer box", "content-type": "application/json" }, body: JSON.stringify({ fleet: FLEET, person: "~owner@fleet.test", device: DEVICE }) })).json();
  if (!boot.ok) throw new Error("флот не завёлся: " + JSON.stringify(boot));
  const admin = (await call("redeem", { invite: boot.invite })).key;

  // папка настроек — той же формы, что ~/.switchboard-dev: её читают проверки и инструменты флота, первым — шаг «машины»
  const dev = path.join(state, "dev");
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, "v2-fleet.env"), `SB2_BASE=${base}\nSB2_PLATFORM=${platform}\nSB2_BOOT=box\n`);
  fs.writeFileSync(path.join(dev, `v2-${FLEET}-${DEVICE}.pass`), admin + "\n");
  // GitHub: токены приложения выдаёт двойник, репозиторий кусочков — настоящий git на диске коробки (tools/box/github.mjs)
  githubApi = await github.serve(pGithub, (line) => fs.appendFileSync(path.join(state, "github.log"), line + "\n"));
  const gitconfig = github.seed(state);
  await call("github.setup", { code: "box" }, admin);
  await call("prefs.set", { scope: "fleet", name: "profiles.repos", value: [github.REPO] }, admin);
  // сборка идёт в каталог флота тем же шагом, которым её доводит выкладка; машины ставит и держит служба машины из этой сборки
  // шаг идёт рядом, коробку не останавливая: её двойник модели и соединения со службами живут в этом же процессе
  const rolled = await new Promise((done) => spawn(process.execPath, [path.join(root, "tools/deploy/machines.mjs"), FLEET, DEVICE], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SB2_DEV: dev } }).on("exit", done));
  if (rolled !== 0) throw new Error(`сборка не дошла до каталога флота: код ${rolled}`);
  const build = (await call("builds.list", {}, admin)).stable;
  say(`сборка ${build} в каталоге флота`);
  for (const m of MACHINES) {
    const home = path.join(state, m);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "machine.key"), (await call("redeem", { invite: (await call("invite", { addr: "@" + m }, admin)).invite })).key + "\n");
    fs.writeFileSync(path.join(home, "keeper.json"), JSON.stringify({ base, machine: m, node: process.execPath }));
    // у каждой машины свой файл службы: обновляя себя, она подменяет именно его
    const bin = path.join(home, win ? "keeper.exe" : "keeper");
    fs.copyFileSync(path.join(root, "dist/builds", String(build), win ? "keeper-windows-amd64.exe" : "keeper-linux-amd64"), bin);
    if (!win) fs.chmodSync(bin, 0o755);
    keep(m, bin, home, gitconfig);
  }
  await until("машины на связи", async () => (await call("fleet.list", {}, admin)).machines.filter((m) => m.online && m.build === build).length === MACHINES.length, MACHINES_MS);
  await call("keys.set", { name: KEY, protocol: "anthropic", base: `http://127.0.0.1:${pModel}`, value: "box-key-0000" }, admin);
  // ключи двух других языков провайдеров: тот же двойник, запрос и поток между языками переводит Host
  for (const protocol of DIALECTS) await call("keys.set", { name: `${KEY}-${protocol}`, protocol, base: `http://127.0.0.1:${pModel}/v1`, value: "box-key-0000" }, admin);
  // два аккаунта Claude: их адрес — тот же двойник модели, он узнаёт аккаунт по токену без ключа провайдера
  for (const a of ACCOUNTS) await call("keys.set", { name: `${a}@box.test`, protocol: "claude", base: `http://127.0.0.1:${pModel}`, value: `sk-ant-oat01-box-${a}-0000000000000000` }, admin);
  await call("project.set", { project: "box", name: "Коробка", members: ["~owner@fleet.test"] }, admin);
  say(`флот ${FLEET}: машины ${MACHINES.join(", ")}, ключ ${KEY}, модели ${MODELS.map((m) => m.id).join(", ")}`);

  return { base, dev, admin, call };
}

/** Команда в окружении коробки; код выхода — её. */
const run = (dev) => new Promise((done) => {
  const env = { ...process.env, SB2_DEV: dev, SB2_KEY: KEY, SB2_MODEL: MODELS[0].id, SB2_SWITCH: [KEY, ...DIALECTS.map((d) => `${KEY}-${d}`)].map((k, i) => `${k}/${MODELS[i % MODELS.length].id}`).join(" "), SB2_WITHOUT: WITHOUT };
  delete env.SB2_ENV;
  const child = spawn(command[0], command.slice(1), { cwd: process.cwd(), stdio: "inherit", env, shell: win });
  child.on("error", (e) => (console.error(`команда не запустилась: ${e.message}`), done(1)));
  child.on("exit", (code) => done(code ?? 1));
});

let code = 1;
try {
  const box = await up();
  if (command.length) code = await run(box.dev);
  else {
    const invite = (await box.call("invite", { addr: "page" + Date.now().toString(36).slice(-4) + "~owner@fleet.test" }, box.admin)).invite;
    console.log(`\nстраница: ${box.base}/#invite=${encodeURIComponent(invite)}\nнастройки для инструментов: SB2_DEV=${box.dev}\nCtrl+C — снять коробку`);
    await new Promise((done) => (process.on("SIGINT", done), process.on("SIGTERM", done)));
    code = 0;
  }
} catch (e) {
  console.error(`коробка не поднялась: ${e.message}\n${tails()}`);
}
await teardown();
// на Windows снятые процессы отпускают свои файлы не сразу: неубранная папка исход команды не меняет
if (code === 0) try { fs.rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.error(`папка коробки осталась: ${state} (${e.code})`); }
else if (command.length) console.error(`\nхвосты журналов частей (целиком — ${state}):\n${tails()}`);
process.exit(code);
