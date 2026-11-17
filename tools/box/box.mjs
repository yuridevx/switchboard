// Флот в коробке: весь Switchboard на одном компьютере — без Cloudflare, машин флота, ключей и аккаунтов.
//   node tools/box/box.mjs <команда…>   поднять, выполнить команду, снять; код выхода — её
//   node tools/box/box.mjs              поднять и держать: печатает адрес страницы со входом; Ctrl+C — снять
// Что поднимается: платформа и службы (wrangler dev на этом компьютере, свои порты и своя папка данных), страница из web/dist,
// Host на каждой машине (m1, m2) с настоящим claude из пакета SDK и держателем keeper, поддельная модель — ключ провайдера «box».
// Команда получает: SB2_DEV — папка настроек (адрес флота, пропуск устройства cli), SB2_KEY, SB2_MODEL, SB2_SWITCH — ключ и модели коробки.
// Сбой подъёма — хвосты журналов частей и код 1. Папка коробки dist/box/<номер процесса> после зелёной команды убирается.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage } from "../build/page.mjs";
import { MODELS, serve } from "./model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv.slice(2);
const FLEET = "box", DEVICE = "cli", MACHINES = ["m1", "m2"], KEY = "box";
const UP_MS = 60_000; // предел подъёма одной части
const STOP_MS = 10_000; // предел штатной остановки Host
const win = process.platform === "win32";
const state = path.join(root, "dist", "box", String(process.pid));
fs.mkdirSync(state, { recursive: true });

const t0 = Date.now();
const say = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с · ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((done) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); });
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
  const log = fs.openSync(path.join(state, name + ".log"), "w");
  const child = spawn(file, args, { cwd: root, stdio: [stdin, log, log], detached: !win, windowsHide: true, env: { ...process.env, ...env } });
  parts.push({ name, child });
  return child;
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
const tails = () => parts.map(({ name }) => `── ${name}\n${fs.readFileSync(path.join(state, name + ".log"), "utf8").split("\n").slice(-12).join("\n")}`).join("\n");

let down = false;
/** Снять коробку: Host — штатно (закрытый ввод), процессы сессий у держателей и Worker'ы — снять. */
async function teardown() {
  if (down) return;
  down = true;
  const hosts = parts.filter((p) => p.name.startsWith("host-"));
  await Promise.all(hosts.map(({ child }) => new Promise((done) => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => (killTree(child.pid), done()), STOP_MS);
    child.once("exit", () => (clearTimeout(timer), done()));
    child.stdin.end();
  })));
  for (const m of MACHINES) {
    const procs = path.join(state, m, "procs");
    for (const f of fs.existsSync(procs) ? fs.readdirSync(procs).filter((n) => n.endsWith(".json")) : []) {
      try { killTree(JSON.parse(fs.readFileSync(path.join(procs, f), "utf8")).pid); } catch { /* файл держателя дописывают */ }
    }
  }
  for (const { child } of parts) if (child.exitCode === null) killTree(child.pid);
  model?.close();
}

let model;
async function up() {
  buildPage(root);
  say("страница собрана");
  const [pModel, pPlatform, pServices, iPlatform, iServices] = await Promise.all([1, 2, 3, 4, 5].map(freePort));
  model = await serve(pModel, (line) => fs.appendFileSync(path.join(state, "model.log"), line + "\n"));
  const base = `http://127.0.0.1:${pServices}`, platform = `http://127.0.0.1:${pPlatform}`;

  // держатель процессов — keeper этого дерева
  const keeper = path.join(state, win ? "keeper.exe" : "keeper");
  const built = spawn("go", ["build", "-o", keeper, "."], { cwd: path.join(root, "keeper"), stdio: ["ignore", "inherit", "inherit"] });
  const keeperReady = new Promise((done, fail) => built.on("exit", (code) => (code === 0 ? done() : fail(new Error(`keeper не собрался: go build вышел с кодом ${code}`)))));

  // свой реестр wrangler: службы находят платформу этой коробки, а не соседней
  const wrangler = (part, port, inspector, vars) => start(part, process.execPath, [
    path.join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "-c", path.join(root, part, "wrangler.jsonc"), "--port", String(port), "--ip", "127.0.0.1",
    "--inspector-port", String(inspector), "--persist-to", path.join(state, "data"), "--show-interactive-dev-session=false", ...vars.flatMap((v) => ["--var", v]),
  ], { WRANGLER_REGISTRY_PATH: path.join(state, "registry"), WRANGLER_SEND_METRICS: "false", CI: "1" });
  wrangler("platform", pPlatform, iPlatform, ["BOOT:box", "DIGEST:box"]);
  wrangler("services", pServices, iServices, ["DIGEST:box"]);
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

  await keeperReady;
  for (const m of MACHINES) {
    const home = path.join(state, m);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "machine.key"), (await call("redeem", { invite: (await call("invite", { addr: "@" + m }, admin)).invite })).key + "\n");
    start("host-" + m, process.execPath, [path.join(root, "host/src/main.ts")], { SB_HOME: home, SB_MACHINE: m, SB_FLEET: FLEET, SB_BASE: base, SB_BUILD: "1", SB_HOLDER: keeper }, "pipe");
  }
  await until("машины на связи", async () => (await call("fleet.list", {}, admin)).machines.filter((m) => m.online).length === MACHINES.length);
  await call("keys.set", { name: KEY, protocol: "anthropic", base: `http://127.0.0.1:${pModel}`, value: "box-key-0000" }, admin);
  say(`флот ${FLEET}: машины ${MACHINES.join(", ")}, ключ ${KEY}, модели ${MODELS.map((m) => m.id).join(", ")}`);

  // папка настроек — той же формы, что ~/.switchboard-dev: её читают проверки и инструменты флота
  const dev = path.join(state, "dev");
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, "v2-fleet.env"), `SB2_BASE=${base}\nSB2_PLATFORM=${platform}\nSB2_BOOT=box\n`);
  fs.writeFileSync(path.join(dev, `v2-${FLEET}-${DEVICE}.pass`), admin + "\n");
  return { base, dev, admin, call };
}

/** Команда в окружении коробки; код выхода — её. */
const run = (dev) => new Promise((done) => {
  const env = { ...process.env, SB2_DEV: dev, SB2_KEY: KEY, SB2_MODEL: MODELS[0].id, SB2_SWITCH: MODELS.map((m) => `${KEY}/${m.id}`).join(" ") };
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
if (code === 0) fs.rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
else console.error(`журналы частей: ${state}`);
process.exit(code);
