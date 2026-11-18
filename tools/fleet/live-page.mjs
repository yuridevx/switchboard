// Живая проверка страницы на настоящем флоте: node tools/fleet/live-page.mjs <флот> <устройство с пропуском> <позывной сессии> [папка снимков]
// Принимает приглашение в браузере, открывает сессию, пишет ей и ждёт ответа, сворачивает её дочернюю в списке; печатает исход шагов и ошибки страницы.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dev, fleetEnv } from "../dev.mjs";
import { fleetCall, launchBrowser, machineTmp, newTag } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// третьим аргументом — машина, на которой сценарий открывает свою сессию; ключ флота — SB2_KEY (по умолчанию muse)
const [fleet = "test", device = "cli", machine = "devbox", outArg] = process.argv.slice(2);
const SEAT = process.env.SB2_KEY ?? "muse";
const out = outArg ?? path.join(root, "dist", "live");
fs.mkdirSync(out, { recursive: true });
const dir = dev;
const env = fleetEnv;
const { call } = fleetCall(fleet, device);

const me = call("whoami", {}).result;
// модель сессии сценария — SB2_MODEL или первая из каталога провайдера
const MODEL = process.env.SB2_MODEL ?? call("keys.models", { name: SEAT }).result.models[0].id;
const name = "live" + newTag();
const invite = call("invite", { addr: name + me.person }).result;
// своя сессия на ключе флота: ответ модели не зависит от чужой сессии и её ключа
const cwd = machineTmp(fleet, device, machine) + "/sb2-live-steps";
const opened = call("session.open", { to: "@" + machine, spec: { name, cwd, key: SEAT, model: MODEL }, mkdir: true });
const callsign = opened.ok ? opened.result.callsign : "";
if (!opened.ok) console.log(`сессия не открылась: ${opened.error} ${opened.why ?? ""}`);
// дочерняя сессия той же: без сообщений, модель не зовётся — в списке она стоит под родителем
const kid = callsign ? call("session.open", { to: "@" + machine, spec: { name: name + "k", cwd, key: SEAT, model: MODEL, parent: callsign }, mkdir: true }) : null;
const kidCall = kid?.ok ? kid.result.callsign : "";
if (kid && !kid.ok) console.log(`дочерняя сессия не открылась: ${kid.error} ${kid.why ?? ""}`);

const steps = [];
const step = async (label, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    steps.push(`✓ ${label} · ${Date.now() - t0} мс`);
  } catch (e) {
    steps.push(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
};

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await step("приглашение принято, картина пришла", async () => {
  await page.goto(env.SB2_BASE + "/#invite=" + encodeURIComponent(invite.invite));
  await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 20_000 });
});
await page.screenshot({ path: path.join(out, "1-home.png") });
if (callsign) {
  const text = turn(say(name));
  await step("сессия открыта из «Работы»", async () => {
    await page.goto(env.SB2_BASE + "/#/work/" + callsign);
    await page.getByPlaceholder(/Сообщение/).waitFor({ timeout: 20_000 });
  });
  await page.screenshot({ path: path.join(out, "2-session.png") });
  await step("сообщение отправлено и ответ модели пришёл в ленту", async () => {
    const box = page.getByPlaceholder(/Сообщение/);
    await box.fill(text);
    await box.press("Enter");
    await page.getByText("Ответь текстом: " + name).first().waitFor({ timeout: 15_000 });
    // ответ модели повторяет слово проверки: оно должно появиться в ленте вне своего сообщения
    await page.waitForFunction((word) => [...document.querySelectorAll("p, li, span, div")].filter((e) => e.children.length === 0 && e.textContent.includes(word) && !e.textContent.includes("Ответь текстом")).length > 0, name, { timeout: 90_000 });
  });
  await page.screenshot({ path: path.join(out, "3-answered.png") });
  await step("родитель сворачивает дочернюю в свою строку; после перезагрузки страницы она свёрнута", async () => {
    if (!kidCall) throw new Error("дочерней сессии нет");
    const list = page.locator('section[aria-label="Работа"]');
    const row = list.locator(`.row[data-call="${kidCall}"]`);
    await row.waitFor({ timeout: 20_000 });
    await list.getByRole("button", { name: "Свернуть дочерние: " + callsign }).click();
    if (await row.count()) throw new Error("дочерняя строка осталась в списке");
    await page.reload();
    await list.getByRole("button", { name: "Показать дочерние: " + callsign }).waitFor({ timeout: 20_000 });
    if (await row.count()) throw new Error("после перезагрузки дочерняя раскрыта");
  });
  await page.screenshot({ path: path.join(out, "4-folded.png") });
}
await step("экран «Наблюдение» показывает запросы", async () => {
  await page.goto(env.SB2_BASE + "/#/observe");
  await page.getByText("message").first().waitFor({ timeout: 20_000 });
});
await page.screenshot({ path: path.join(out, "5-observe.png") });
await browser.close();
call("revoke", { kid: invite.kid });
if (kidCall) call("session.remove", { to: kidCall });
if (callsign) call("session.remove", { to: callsign });

for (const s of steps) console.log(s);
console.log("ошибок страницы:", errors.length, errors.slice(0, 5).join(" | ").slice(0, 600));
console.log("снимки:", out);
process.exit(!callsign || steps.some((s) => s.startsWith("✗")) || errors.length ? 1 : 0);
