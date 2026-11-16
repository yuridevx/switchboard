// Живая проверка «Ошибки на виду»: node tools/fleet/live-errors.mjs [флот] [устройство] [машина] [папка снимков]
// Сессия на дешёвой модели (SB2_KEY и SB2_MODEL, по умолчанию claude и claude-haiku-5-5) получает негодный PDF — провайдер отклоняет вызов.
// Проверяет: причина словами провайдера стоит в журнале машины, в ленте сессии (история отдаёт её на месте) и на выложенной странице — до и после перезагрузки.
// SB2_GOAL_KEY и SB2_GOAL_MODEL (ключ и модель Meta) — ещё и проверка цели: «/goal» на Meta проходит, отказов провайдера и сбоя хука нет.
import fs from "node:fs";
import path from "node:path";
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall, root } from "./harness.mjs";

const [fleet = "test", device = "cli", machine = "devbox", outArg] = process.argv.slice(2);
const out = outArg ?? path.join(root, "dist", "live");
fs.mkdirSync(out, { recursive: true });
const { call, must } = fleetCall(fleet, device);
const tag = Date.now().toString(36).slice(-4);
// папка пробных сессий — от домашней папки машины: годится любой ОС и чужой машине; SB2_CWD — своя
const cwd = process.env.SB2_CWD ?? "~/sb2-live-errors";
const REFUSED = "вызов модели отклонён (4";

let bad = 0, total = 0;
const made = [];
async function step(label, fn) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message ?? e).split("\n")[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowOf = (cs) => must("fleet.list", { machine, full: true }).sessions.find((s) => s.callsign === cs);
async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(2000);
  }
}
const open = (name, doc) => {
  const cs = must("session.open", { to: "@" + machine, spec: { name, cwd, ...doc }, mkdir: true }).callsign;
  made.push(cs);
  return cs;
};
/** Ход: сообщение ушло, сессия взяла его и снова свободна. */
async function turn(cs, fields) {
  must("message", { to: cs, ...fields });
  await until(`${cs} взяла ход`, () => ["busy", "waiting"].includes(rowOf(cs)?.state ?? ""), 30_000).catch(() => {});
  await until(`${cs} свободна`, () => rowOf(cs)?.state === "idle", 300_000);
}
const history = (cs) => must("session.history", { to: cs, limit: 100 }).events;
const logsOf = (cs) => history(cs).filter((e) => e.type === "log");

const DOC = { key: process.env.SB2_KEY ?? "claude", model: process.env.SB2_MODEL ?? "claude-haiku-5-5" };
let cs = "";
let line = "";

await step("сессия на дешёвой модели открыта", async () => {
  cs = open("err-" + tag, DOC);
  await until(`${cs} свободна`, () => rowOf(cs)?.state === "idle", 120_000);
  return `${cs} · ${DOC.key}/${DOC.model}`;
});

await step("провайдер отклонил вызов: причина его словами — событием log в ленте сессии", async () => {
  await turn(cs, { text: "Что в этом файле? Ответь одним словом.", files: [{ name: "broken.pdf", mime: "application/pdf", base64: Buffer.from("это не PDF").toString("base64") }] });
  const refused = await until("строка отказа в ленте", () => logsOf(cs).find((e) => e.msg === "call" && String(e.why ?? "").startsWith(REFUSED)), 60_000);
  // причина — не один статус: за двоеточием стоят слова провайдера
  const said = String(refused.why).split("): ")[1] ?? "";
  if (said.length < 8) throw new Error(`в строке нет слов провайдера: ${refused.why}`);
  line = String(refused.why);
  return `${refused.level} · ${line.slice(0, 160)}`;
});

await step("журнал машины: строка вызова с отказом несёт причину — 1 из 1", async () => {
  const lines = must("machine.journal", { to: "@" + machine, session: cs, level: "warn", limit: 50 }).lines.filter((l) => l.msg === "call");
  const withWhy = lines.filter((l) => String(l.why ?? "").startsWith(REFUSED) && String(l.why).includes("): "));
  if (!lines.length || withWhy.length !== lines.length) throw new Error(`строк вызова с отказом ${lines.length}, с причиной ${withWhy.length}`);
  return `строк вызова с отказом ${lines.length}, с причиной ${withWhy.length}`;
});

// у одних провайдеров отказ обрывает ход, у других claude повторяет вызов без негодного файла и ход кончается ответом: строк «ход остановлен» — ровно по числу оборванных ходов
await step("ход остановлен — строкой error в ленте, по одной на оборванный ход", async () => {
  const h = history(cs);
  const ended = h.filter((e) => e.type === "result" && e.is_error).length;
  const stopped = h.filter((e) => e.type === "log" && e.level === "error" && e.msg === "sdk.result");
  if (stopped.length !== ended) throw new Error(`оборванных ходов ${ended}, строк «ход остановлен» ${stopped.length}: ${JSON.stringify(logsOf(cs).map((e) => e.msg))}`);
  return ended ? String(stopped[0].why).slice(0, 140) : "ход не оборвался: claude повторил вызов без файла и ответил";
});

await step("история отдаёт строку на месте: за сообщением человека, перед итогом хода", async () => {
  const h = history(cs);
  const at = h.findIndex((e) => e.type === "log" && e.why === line);
  const asked = h.findIndex((e) => e.type === "user" && JSON.stringify(e.message ?? {}).includes("Что в этом файле"));
  if (at < 0 || asked < 0 || at < asked) throw new Error(`строка на месте ${at}, сообщение человека на месте ${asked}`);
  return `сообщение — ${asked}, строка — ${at} из ${h.length}`;
});

const me = must("whoami", {});
const invite = must("invite", { addr: "errors" + tag + me.person });
const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  page.on("pageerror", (e) => errors.push(e.message));
  const shown = () => page.locator(".sysline.tone-wait, .sysline.tone-bad").allInnerTexts();
  await step("страница: причина отказа в ленте сессии — 1 из 1", async () => {
    await page.goto(fleetEnv.SB2_BASE + "/#invite=" + encodeURIComponent(invite.invite));
    for (let i = 0; i < 40 && !(await page.locator("body").innerText()).includes(cs); i++) await page.waitForTimeout(1000);
    await page.goto(fleetEnv.SB2_BASE + "/#/work/" + cs);
    await page.locator(".sysline.tone-wait").first().waitFor({ state: "attached", timeout: 30_000 });
    const rows = await shown();
    if (!rows.some((r) => r.startsWith(line.slice(0, 60)))) throw new Error(`строки нет: ${JSON.stringify(rows)}`);
    await page.screenshot({ path: path.join(out, `errors-${machine}-1280-light.png`) });
    return `строк беды ${rows.length}`;
  });
  await step("страница перезагружена: причина на месте — 1 из 1", async () => {
    await page.reload();
    await page.locator(".sysline.tone-wait").first().waitFor({ state: "attached", timeout: 30_000 });
    const rows = await shown();
    if (!rows.some((r) => r.startsWith(line.slice(0, 60)))) throw new Error(`строки нет: ${JSON.stringify(rows)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `errors-${machine}-390-dark.png`) });
    return `строк беды ${rows.length}, ошибок страницы ${errors.length}`;
  });
} finally {
  await browser.close();
  call("revoke", { kid: invite.kid });
}
if (errors.length) (bad++, console.log(`✗ ошибки страницы: ${errors.slice(0, 3).join(" | ").slice(0, 400)}`));

if (process.env.SB2_GOAL_KEY) {
  const goalDoc = { key: process.env.SB2_GOAL_KEY, model: process.env.SB2_GOAL_MODEL ?? "muse-spark-1.3" };
  await step("проверка цели на Meta проходит: отказов провайдера и сбоя хука нет — 0 из 1", async () => {
    const goal = open("goal-" + tag, goalDoc);
    await until(`${goal} свободна`, () => rowOf(goal)?.state === "idle", 120_000);
    must("message", { to: goal, text: "/goal В ответе есть слово ok" });
    await sleep(3000);
    await turn(goal, { text: "Ответь одним словом: ok" });
    const logs = logsOf(goal);
    const refusals = logs.filter((e) => e.msg === "call");
    const hook = logs.filter((e) => /hook error/i.test(String(e.why ?? "")));
    if (refusals.length || hook.length) throw new Error(`отказов провайдера ${refusals.length}, сбоев хука ${hook.length}: ${String((refusals[0] ?? hook[0]).why).slice(0, 200)}`);
    return `${goal} · ${goalDoc.key}/${goalDoc.model} · строк беды ${logs.length}`;
  });
}

if (!process.env.KEEP) for (const c of made.reverse()) call("session.remove", { to: c });
console.log(`${total - bad} из ${total}`);
console.log("снимки:", out);
process.exit(bad ? 1 : 0);
