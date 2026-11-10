// Живая проверка оповещения о сбое: node tools/fleet/live-alert.mjs <флот> <устройство с пропуском админа> [headless|window]
// Настоящий Chrome подписывается на уведомления выложенной страницы; затем в журнал флота пишется сбой Host выдуманной машины —
// служба наблюдения должна позвать админа, и пуш должен показаться сервис-воркером. Подписка и пропуск проверки в конце убираются.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const [fleet = "test", device = "cli", mode = "window"] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const base = env.SB2_BASE;
const call = (type, fields) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString());
  } catch (e) {
    return JSON.parse(e.stdout.toString());
  }
};

const steps = [];
const say = (ok, label, note = "") => steps.push(`${ok ? "✓" : "✗"} ${label}${note ? ` · ${note}` : ""}`);
const me = call("whoami", {}).result;
const tag = Date.now().toString(36).slice(-5);
const invite = call("invite", { addr: "alert" + tag + me.person }).result;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-alert-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: mode === "headless", viewport: { width: 1280, height: 800 }, permissions: ["notifications"] });
await ctx.grantPermissions(["notifications"], { origin: base });
const page = ctx.pages()[0] ?? (await ctx.newPage());
let deviceId = "";
try {
  await page.goto(`${base}/#invite=${encodeURIComponent(invite.invite)}`);
  await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 25_000 });
  // подписка браузера ключом флота — запросами договора, без кода страницы: проверяется служба, а не кнопка
  const sub = await page.evaluate(async () => {
    const key = localStorage.getItem("sb2.key");
    const ask = async (type, fields = {}) => (await (await fetch("/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ type, id: "r" + Math.random().toString(36).slice(2), ...fields }) })).json());
    const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    try {
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await navigator.serviceWorker.ready;
      const k = await ask("reach.key");
      if (!k.ok) return { error: "reach.key: " + k.error };
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(k.result.key) });
      const r = await ask("reach.subscribe", { kind: "webpush", endpoint: s.endpoint, p256dh: b64u(s.getKey("p256dh")), auth: b64u(s.getKey("auth")), label: "живая проверка оповещения" });
      return r.ok ? { id: r.result.id } : { error: "reach.subscribe: " + r.error + " " + (r.why ?? "") };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  });
  deviceId = sub.id ?? "";
  say(!!sub.id, "браузер подписан на уведомления флота", sub.id ? "" : sub.error);
  if (sub.id) {
    // сбой Host выдуманной машины: причина новая при каждом запуске — получасовое молчание об одной причине не мешает
    const text = "живая проверка оповещения " + tag;
    const add = call("ledger.add", { what: "host.failed", machine: "probe-" + tag, text });
    say(add.ok, "сбой части записан в журнал флота", add.ok ? "" : `${add.error}: ${add.why ?? ""}`);
    let got = [];
    for (let i = 0; i < 10 && !got.length; i++) {
      await page.waitForTimeout(1500);
      got = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/")).getNotifications()).map((n) => n.title + " — " + n.body));
    }
    const mine = got.filter((n) => n.includes(tag));
    say(mine.length > 0, "оповещение админу показано уведомлением", mine[0] ?? `уведомлений с меткой нет (всего ${got.length})`);
  }
} catch (e) {
  say(false, "проверка оборвалась", String(e.message).split("\n")[0]);
} finally {
  await ctx.close().catch(() => {});
  if (deviceId) call("reach.remove", { device: deviceId });
  call("revoke", { kid: invite.kid });
  fs.rmSync(profile, { recursive: true, force: true });
}
for (const s of steps) console.log(s);
process.exit(steps.some((s) => s.startsWith("✗")) ? 1 : 0);
