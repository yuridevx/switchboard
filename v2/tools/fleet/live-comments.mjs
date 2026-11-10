// Живая проверка комментариев к странице: node tools/fleet/live-comments.mjs [флот] [устройство]
// В настоящем Chrome: Ctrl+C, клик по элементу, текст, «Передать Claude»; затем пачку читает сторож comments.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall } from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet = "test", device = "cli"] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const run = (file, ...args) => execFileSync(process.execPath, [path.join(root, "tools/fleet", file), fleet, device, ...args], { cwd: root }).toString();
const { call } = fleetCall(fleet, device);

const me = call("whoami", {}).result;
const invite = call("invite", { addr: "cmt" + Date.now().toString(36).slice(-5) + me.person }).result;
const word = "проверка-" + Math.random().toString(36).slice(2, 8);
// сторож ждёт только новое: отметка — сейчас
fs.writeFileSync(path.join(dir, `v2-${fleet}-comments.at`), String(Date.now()));

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${env.SB2_BASE}/#invite=${encodeURIComponent(invite.invite)}`);
await page.waitForSelector("nav a", { timeout: 20_000 });
await page.keyboard.press("Control+KeyC");
await page.waitForSelector("body.pc-on", { timeout: 5000 });
const link = page.locator("nav a").first();
const before = page.url();
await link.click();
if (page.url() !== before) throw new Error("клик в режиме комментариев дошёл до страницы");
await page.fill(".pc-pop textarea", word);
await page.click('.pc-pop [data-a="ok"]');
await page.click('.pc-bar [data-pc="send"]');
await page.waitForFunction(() => !document.querySelector('.pc-bar [data-pc="send"]'), null, { timeout: 15_000 });
await browser.close();

const got = run("comments.ts", "0.01");
if (!got.includes(word) || /элемент: \n/.test(got)) throw new Error("сторож не получил пачку:\n" + got);
if (errors.length) throw new Error("ошибки страницы: " + errors.join(" | "));
console.log(got.trim() + "\n\nкомментарии: пачка дошла");
