// Живая проверка третьей итерации на настоящем флоте: node shots/live3.mjs [флот] [устройство] [порт] [машина-цель переноса]
// Вопрос сессии («Вопрос видят», «отвечено»), архив (точки, проверка правил на вызове), перенос живой сессии на другую машину,
// перезапуск Host на машине-цели, команда установки Keeper. Свои тестовые сессии на ключе флота; после себя убирает.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const [fleet = "test", device = "cli", port = "4834", target = "wsl"] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const out = path.join(root, "dist", "live3");
fs.mkdirSync(out, { recursive: true });
const call = (type, fields) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString());
  } catch (e) {
    return JSON.parse(e.stdout.toString());
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => call("fleet.list", {}).result.sessions;
const waitRow = async (callsign, ok, ms = 60_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1500)) {
    const r = rows().find((s) => s.callsign === callsign);
    if (r && ok(r)) return r;
  }
  throw new Error(`строка ${callsign} не дождалась нужного состояния`);
};

const vite = spawn("npx", ["vite", "--config", "vite.live.config.ts", "--port", port], { cwd: web, shell: true, env: { ...process.env, SB2_BASE: env.SB2_BASE }, stdio: "pipe" });
const stopVite = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : vite.kill());
const local = "http://localhost:" + port;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(local)).ok) break;
  } catch {}
  await sleep(500);
}

const me = call("whoami", {}).result;
const tag = Date.now().toString(36).slice(-4);
const invite = call("invite", { addr: "w3" + tag + me.person }).result;
const source = me.machines.find((m) => m !== target) ?? "devbox";
const name = "w3-" + tag;
const callsign = `${name}@${source}`;
const cwd = path.join(os.tmpdir(), "sb2-w3-" + tag).replaceAll("\\", "/");
fs.mkdirSync(cwd, { recursive: true });

const steps = [];
const step = async (label, fn) => {
  const t0 = Date.now();
  try {
    const note = await fn();
    steps.push(`✓ ${label}${note ? " · " + note : ""} · ${Date.now() - t0} мс`);
  } catch (e) {
    steps.push(`✗ ${label} · ${String(e.message).split("\n")[0].slice(0, 200)}`);
  }
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
const open = async (hash) => (await page.goto(`${local}/?fleet=${local}#${hash}`), page.waitForTimeout(1500));

await step("страница открыта по приглашению", async () => {
  await page.goto(`${local}/?fleet=${local}#invite=${encodeURIComponent(invite.invite)}`);
  await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 20_000 });
});

/* вопрос сессии */
await step("сессия в режиме «спрашивать» задаёт вопрос разрешения", async () => {
  const r = call("session.open", { to: "@" + source, spec: { name, cwd, account: "deepseek", mode: "ask", backup: true }, prompt: "Создай в этой папке файл w3.txt со словом ok. Больше ничего не делай." });
  if (!r.ok) throw new Error(r.error + " " + (r.why ?? ""));
  const row = await waitRow(callsign, (s) => !!s.ask);
  return `вопрос ${row.ask.kind}, адресат ${row.ask.to ?? "—"}`;
});
await step("в разговоре под вопросом — «Вопрос видят»", async () => {
  await open(`/work/${callsign}`);
  const el = page.getByText(/Вопрос видят/).first();
  await el.waitFor({ timeout: 15_000 });
  return (await el.innerText()).slice(0, 80);
});
await page.screenshot({ path: path.join(out, "1-ask.png") });
await step("ответ человека: «отвечено» с тем, кто ответил", async () => {
  await page.getByRole("button", { name: /^Разрешить$/ }).first().click();
  await waitRow(callsign, (s) => !s.ask && s.state === "idle", 90_000);
  const el = page.getByText(/отвечено/).first();
  await el.waitFor({ timeout: 20_000 });
  return (await el.innerText()).slice(0, 90);
});
await page.screenshot({ path: path.join(out, "2-answered.png") });

/* архив */
let sid = "";
await step("точка сохранена, сессия в архиве с точками", async () => {
  const p = call("points.save", { to: callsign, label: "проверка w3" });
  if (!p.ok) throw new Error(p.error + " " + (p.why ?? ""));
  const list = call("points.list", { machine: source }).result.sessions;
  sid = list.find((s) => s.callsign === callsign)?.sid ?? "";
  if (!sid) throw new Error("сессии нет в каталоге архива");
  await open(`/archive/${sid}`);
  await page.getByText("проверка w3").first().waitFor({ timeout: 15_000 });
  return "sid " + sid.slice(0, 8);
});
await step("проверка правил на вызове из архива: части вызова чипами", async () => {
  const calls = call("points.calls", { sid }).result.calls;
  if (!calls.length) throw new Error("вызовов модели у точки нет");
  await open(`/settings/proxy?call=${encodeURIComponent(sid)}/${encodeURIComponent(calls[0].call)}`);
  await page.getByText("Свой текст").first().waitFor({ timeout: 15_000 });
  const chips = await page.locator('[aria-label="Часть вызова"] label').allInnerTexts();
  const text = await page.getByLabel("Текст для проверки").inputValue();
  if (!text.trim()) throw new Error("текст вызова в проверку не встал");
  return `частей: ${chips.length - 1}, текст ${text.length} знаков`;
});
await page.screenshot({ path: path.join(out, "3-rules-call.png") });

/* перенос живой сессии */
let moved = "";
await step(`перенос живой сессии на ${target} (move)`, async () => {
  await open(`/archive/${sid}`);
  await page.getByRole("button", { name: "Действия с сессией архива" }).click();
  await page.getByRole("menuitem", { name: /Перенести на машину/ }).click();
  await page.getByLabel("Папка").fill(target === "wsl" ? "/tmp/sb2-w3-" + tag : cwd + "-moved");
  await page.getByRole("button", { name: /^Перенести$/ }).click();
  moved = `${name}@${target}`;
  await waitRow(moved, (s) => s.state === "idle" || s.state === "busy", 90_000);
  const left = rows().some((s) => s.callsign === callsign);
  return `${moved} на связи; на прежней машине ${left ? "ещё есть" : "убрана"}`;
});
await page.screenshot({ path: path.join(out, "4-moved.png") });

/* перезапуск Host на машине-цели */
await step(`перезапуск Host на ${target}: сессии остаются`, async () => {
  const before = rows().filter((s) => s.callsign.endsWith("@" + target)).map((s) => s.callsign).sort();
  const pid0 = call("keeper.state", { to: ".keeper@" + target }).result.host.pid;
  await open("/fleet/releases");
  const row = page.locator("tr, .card, .line").filter({ hasText: target }).filter({ has: page.getByRole("button", { name: "Перезапустить Host" }) }).first();
  await row.getByRole("button", { name: "Перезапустить Host" }).click();
  await page.getByRole("button", { name: /^Перезапустить$/ }).click();
  let pid1 = pid0;
  for (const t0 = Date.now(); Date.now() - t0 < 60_000 && (pid1 === pid0 || !pid1); await sleep(2000)) {
    const k = call("keeper.state", { to: ".keeper@" + target });
    pid1 = k.ok && k.result.host.state === "running" ? k.result.host.pid : pid0;
  }
  if (pid1 === pid0) throw new Error("pid Host не сменился за минуту");
  await sleep(4000);
  const after = rows().filter((s) => s.callsign.endsWith("@" + target)).map((s) => s.callsign).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`сессии изменились: было ${before.join(", ")}, стало ${after.join(", ")}`);
  return `pid ${pid0} → ${pid1}, сессий ${after.length}`;
});
await page.screenshot({ path: path.join(out, "5-restart.png") });

/* команда установки Keeper */
await step("«Добавить машину»: команда установки со ссылкой на Keeper", async () => {
  await open("/fleet/machines");
  await page.getByRole("button", { name: "Добавить машину" }).click();
  const box = page.getByRole("dialog");
  await box.getByRole("textbox").first().fill("probe-" + tag);
  await box.getByRole("button", { name: /Выдать|Пригласить|Создать/ }).first().click();
  const cmd = box.locator("pre").first();
  await cmd.waitFor({ timeout: 15_000 });
  // ссылка приходит запросом: команда сначала стоит без неё
  await page.waitForFunction(() => /curl/.test(document.querySelector("[role=dialog] pre")?.textContent ?? ""), null, { timeout: 15_000 }).catch(() => {});
  const text = await cmd.innerText();
  if (!/https?:\/\/\S+keeper/i.test(text)) throw new Error("в команде нет ссылки на Keeper: " + text.slice(0, 120));
  return text.replace(/\s+/g, " ").replace(/sig=\S+/g, "sig=…").slice(0, 110);
});
await page.screenshot({ path: path.join(out, "6-install.png") });

/* уборка */
await browser.close();
stopVite();
for (const c of [moved, callsign]) if (c) call("session.remove", { to: c });
if (sid) call("points.delete", { sid });
for (const p of call("passes", {}).result.passes) if (p.wait && /probe-/.test(p.addr)) call("revoke", { kid: p.kid });
call("revoke", { kid: invite.kid });

for (const s of steps) console.log(s);
console.log("ошибок страницы:", errors.length, errors.slice(0, 4).join(" | ").slice(0, 400));
console.log("снимки:", out);
process.exit(steps.some((s) => s.startsWith("✗")) || errors.length ? 1 : 0);
