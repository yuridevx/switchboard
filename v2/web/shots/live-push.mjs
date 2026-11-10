// Живая проверка уведомлений на настоящем флоте: node shots/live-push.mjs [флот] [устройство с пропуском] [порт] [headless|window]
// Настоящий Chrome: разрешение уведомлений → подписка браузера ключом флота → reach.subscribe → reach.send этому человеку.
// Печатает, что получилось на каждом шаге. Подписка и пропуск проверки в конце убираются.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../../tools/dev.mjs";
import { chromium, fleetCall } from "../../tools/fleet/harness.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const [fleet = "test", device = "cli", port = "4832", mode = "window"] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const { call } = fleetCall(fleet, device);

const vite = spawn("npx", ["vite", "--config", "vite.live.config.ts", "--port", port], { cwd: web, shell: true, env: { ...process.env, SB2_BASE: env.SB2_BASE }, stdio: "pipe" });
const stopVite = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : vite.kill());
const local = "http://localhost:" + port;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(local)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const me = call("whoami", {}).result;
const name = "push" + Date.now().toString(36).slice(-5);
const invite = call("invite", { addr: name + me.person }).result;
const steps = [];
const say = (ok, label, note = "") => steps.push(`${ok ? "✓" : "✗"} ${label}${note ? ` · ${note}` : ""}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-push-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: mode === "headless", viewport: { width: 1280, height: 800 }, permissions: ["notifications"] });
await ctx.grantPermissions(["notifications"], { origin: local });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
try {
  await page.goto(`${local}/?fleet=${local}#invite=${encodeURIComponent(invite.invite)}`);
  await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 25_000 });
  say(true, "страница открыта по приглашению");
  await page.goto(`${local}/?fleet=${local}#/settings/alerts`);
  await page.waitForTimeout(1500);
  const sw = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration("/")) || !!(await navigator.serviceWorker.register("/sw.js", { scope: "/" })));
  say(sw, "сервис-воркер зарегистрирован");
  const perm = await page.evaluate(() => Notification.permission);
  say(perm === "granted", "разрешение уведомлений", perm);
  // подписка браузера ключом флота и запись устройства — тем же кодом, что у кнопки «Включить»
  const result = await page.evaluate(async () => {
    try {
      const { enablePush } = await import("/src/lib/push.ts");
      const { api } = await import("/src/api.ts");
      return { state: await enablePush(api) };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  });
  say(result.state === "on", "подписка браузера и reach.subscribe", result.state ?? result.error);
  const devices = call("reach.devices", {}).result?.devices ?? [];
  const mine = devices.filter((d) => d.kind === "webpush" && d.kid === invite.kid);
  say(mine.length === 1, "устройство записано у службы", `подписок этого пропуска: ${mine.length}`);
  if (mine.length) {
    const sent = call("reach.send", { to: me.person, title: "Проверка уведомлений", text: "живая проверка " + name, kind: "message", force: true });
    say(sent.ok && sent.result.sent > 0, "reach.send дошёл до службы пушей", sent.ok ? `отправлено: ${sent.result.sent}` : `${sent.error}: ${sent.why ?? ""}`);
    await page.waitForTimeout(6000);
    const got = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/")).getNotifications()).map((n) => n.title + " — " + n.body));
    say(got.some((t) => t.includes(name)), "уведомление показано сервис-воркером", got.join(" | ") || "уведомлений нет");
    for (const d of mine) call("reach.remove", { device: d.id });
  }
} catch (e) {
  say(false, "сценарий прерван", String(e.message).split("\n")[0]);
}
await ctx.close();
stopVite();
call("revoke", { kid: invite.kid });
fs.rmSync(profile, { recursive: true, force: true });
for (const s of steps) console.log(s);
console.log("ошибок страницы:", errors.length, errors.slice(0, 3).join(" | "));
process.exit(0);
