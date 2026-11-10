// Живая проверка разговора на выложенной странице: node tools/fleet/live-talk.mjs [флот] [устройство] [машина] [папка снимков]
// Настоящий Chrome и настоящая сессия на ключе флота: откат в том же окне (разговор и файлы), очистка, кольцо контекста, вопрос и ответ карточками ленты,
// «Идут сейчас» со временем от начала работы после перезагрузки, перетаскивание границы списка, разговоры папки в «Новой сессии».
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const [fleet = "test", device = "cli", machine = "devbox", outArg] = process.argv.slice(2);
const out = outArg ?? path.join(root, "dist", "talk");
fs.mkdirSync(out, { recursive: true });
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// сеть этой машины моргает: запрос, не дошедший до флота, повторяется
const call = (type, fields) => {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString());
    } catch (e) {
      r = JSON.parse(e.stdout.toString());
    }
    if (r.ok || r.error !== "offline" || i >= 4) return r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
};
const must = (type, fields) => { const r = call(type, fields); if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`); return r.result; };
const me = must("whoami", {});
const tag = Date.now().toString(36).slice(-4);
const cwd = machine === "wsl" ? `/tmp/sb2-talk-${tag}` : `C:/Users/${os.userInfo().username}/AppData/Local/Temp/sb2-talk-${tag}`;
const made = [];
const state = (cs) => must("fleet.list", { machine }).sessions.find((s) => s.callsign === cs)?.state;
const idle = async (cs, ms = 150_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(1500)) if (state(cs) === "idle") return; throw new Error(`${cs} не освободилась`); };
const fileOn = (name) => String(must("shell.run", { to: "@" + machine, shell: "node", script: `import fs from "node:fs";const p=${JSON.stringify(cwd + "/" + name)};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"")`, wait: 30 }).out ?? "").trim();

const cs = must("session.open", { to: "@" + machine, spec: { name: "talk-" + tag, cwd, slot: "muse" }, mkdir: true }).callsign;
made.push(cs);
await idle(cs);

const browser = await chromium.launch({ channel: "chrome" });
const invite = must("invite", { addr: "talk" + tag + me.person });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let bad = 0, total = 0;
const step = async (label, fn) => {
  total++;
  try {
    const note = await fn();
    console.log(`✓ ${label}${note ? ` · ${note}` : ""}`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
    await page.screenshot({ path: path.join(out, `fail-${total}.png`) }).catch(() => {});
  }
};
const shot = (name) => page.screenshot({ path: path.join(out, name + ".png") });
const box = page.getByRole("textbox", { name: "Сообщение сессии" });
const opts = page.locator(".composer-opts");
const say = async (text) => { await box.fill(text); await box.press("Enter"); await sleep(2500); await idle(cs); await sleep(1500); };

try {
  await page.goto(`${env.SB2_BASE}/#invite=${encodeURIComponent(invite.invite)}`);
  await page.waitForSelector("nav.rail a", { timeout: 25_000 });
  await page.goto(`${env.SB2_BASE}/#/work/${cs}`);
  await box.waitFor({ timeout: 15_000 });

  await step("ход со страницы: сессия записала файл", async () => {
    await say("Создай инструментом Write файл page.txt ровно с одной строкой: первый. Больше ничего не делай.");
    await say("Перезапиши инструментом Write файл page.txt ровно с одной строкой: второй. Больше ничего не делай.");
    const text = fileOn("page.txt");
    if (!/второй/.test(text)) throw new Error("файл: " + JSON.stringify(text));
    return "файл: " + text;
  });

  await step("откат «разговор и файлы» в том же окне: адрес тот же, лента обрезана, след отката, текст в поле ввода, файл вернулся", async () => {
    const url = page.url();
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    const stepPage = page.locator('[data-step="rewind"]');
    await stepPage.getByText(/Из разговора уйдёт записей/).waitFor({ timeout: 15_000 });
    await page.getByText("Разговор и файлы", { exact: true }).click();
    await stepPage.locator(".line").getByText("page.txt").first().waitFor({ timeout: 8000 });
    await shot("rewind-step");
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("[data-step]"), null, { timeout: 60_000 });
    await page.getByText(/Откат к «.+» · файлы возвращены: 1/).first().waitFor({ timeout: 20_000 });
    if (page.url() !== url) throw new Error(`адрес сменился: ${page.url()}`);
    const text = await box.inputValue();
    if (!/второй/.test(text)) throw new Error("в поле ввода: " + JSON.stringify(text.slice(0, 60)));
    if (await page.locator(".feed-in .me").getByText("ровно с одной строкой: второй").count()) throw new Error("откаченное сообщение осталось в ленте");
    await idle(cs);
    const file = fileOn("page.txt");
    if (!/первый/.test(file) || /второй/.test(file)) throw new Error("файл на диске: " + JSON.stringify(file));
    await box.fill("");
    await shot("rewound");
    return "файл: " + file;
  });

  await step("перезагрузка страницы: лента та же обрезанная, след отката на месте", async () => {
    await page.reload();
    await box.waitFor({ timeout: 15_000 });
    await page.getByText(/Откат к «.+»/).first().waitFor({ timeout: 15_000 });
    if (await page.locator(".feed-in .me").getByText("ровно с одной строкой: второй").count()) throw new Error("откаченное сообщение вернулось");
  });

  await step("вопрос сессии — карточкой ленты; ответ остаётся карточкой с выбранным вариантом", async () => {
    await box.fill("Задай мне один вопрос инструментом AskUserQuestion: «Какой цвет?» с вариантами «Красный» и «Синий». После ответа напиши одним словом выбранный цвет.");
    await box.press("Enter");
    const card = page.locator(".feed-in .askcard[data-open]");
    await card.first().waitFor({ timeout: 90_000 });
    if (await page.locator(".dock .askcard").count()) throw new Error("вопрос стоит над полем ввода");
    await shot("ask");
    await card.getByRole("button", { name: "Синий", exact: true }).click();
    const send = card.getByRole("button", { name: "Ответить", exact: true });
    if (await send.count()) await send.click();
    const done = page.locator(".feed-in .askcard.answered");
    await done.first().waitFor({ timeout: 30_000 });
    if (!(await done.locator('.asked-opt[aria-current="true"]').getByText("Синий").count())) throw new Error("выбранный вариант не выделен");
    await done.getByText(/ответил/).first().waitFor();
    await idle(cs);
    await shot("answered");
  });

  await step("«Идут сейчас»: фоновая команда строкой; время — от начала работы и после перезагрузки страницы", async () => {
    await box.fill(machine === "wsl" ? "Запусти инструментом Bash в фоне (run_in_background: true) команду: sleep 90. Сразу ответь одним словом: запущено." : "Запусти инструментом Bash в фоне (run_in_background: true) команду: sleep 90. Сразу ответь одним словом: запущено.");
    await box.press("Enter");
    const runs = page.getByRole("group", { name: "Идут сейчас" });
    await runs.locator(".run-row").first().waitFor({ timeout: 90_000 });
    await sleep(12_000);
    const secs = async () => { const t = await runs.locator(".run-row .time").first().innerText(); const m = /(?:(\d+)\s*мин)?\s*(?:(\d+)\s*с)?/.exec(t); return Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0); };
    const before = await secs();
    if (before < 8) throw new Error(`время строки ${before} с через 12 с после начала`);
    await page.reload();
    await runs.locator(".run-row").first().waitFor({ timeout: 30_000 });
    await sleep(1500);
    const after = await secs();
    if (after < before) throw new Error(`после перезагрузки ${after} с, было ${before} с`);
    await shot("runs");
    return `${before} с → после перезагрузки ${after} с`;
  });

  await step("кольцо контекста: процент виден, нажатие сжимает", async () => {
    await idle(cs);
    const ring = opts.getByRole("button", { name: /^Контекст \d+% · сжать$/ });
    await ring.waitFor({ timeout: 40_000 });
    const word = await ring.getAttribute("aria-label");
    await ring.click();
    await sleep(3000);
    if (await page.locator(".mantine-Notification-root[data-with-title], .mantine-Notification-root").filter({ hasText: /Ошибка|не |Нет/ }).count()) throw new Error("сжатие отказано");
    await idle(cs);
    return word;
  });

  await step("ряд под полем: значки действий на месте, «/ команды» нет; шапка без кнопок действий", async () => {
    for (const name of ["Фокус", "Инспектор", "Ещё", "Очистить"]) await opts.getByRole("button", { name, exact: true }).waitFor({ timeout: 8000 });
    if (await opts.getByText("/ команды").count()) throw new Error("кнопка «/ команды» осталась");
    if (await page.locator(".conv-head").getByRole("button", { name: /Ещё|Инспектор/ }).count()) throw new Error("кнопки действий остались в шапке");
  });

  await step("очистка страницей подтверждения: в ленте «Разговор очищен», адрес тот же", async () => {
    const url = page.url();
    await opts.getByRole("button", { name: "Очистить" }).click();
    await page.getByRole("button", { name: "Очистить", exact: true }).click();
    await page.getByText("Разговор очищен").first().waitFor({ timeout: 40_000 });
    if (page.url().replace(/\?do=.*$/, "") !== url) throw new Error("адрес сменился: " + page.url());
    await shot("cleared");
  });

  await step("граница списка тянется мышью; ширину помнит устройство", async () => {
    const width = async () => Math.round((await page.locator(".pane.list").boundingBox()).width);
    const w0 = await width();
    const edge = await page.getByRole("separator", { name: "Ширина списка" }).boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 90, edge.y + 200, { steps: 6 });
    await page.mouse.up();
    const w1 = await width();
    if (Math.abs(w1 - w0 - 90) > 12) throw new Error(`ширина ${w0} → ${w1}`);
    await page.reload();
    await page.locator(".pane.list .row").first().waitFor({ timeout: 15_000 });
    const w2 = await width();
    if (Math.abs(w2 - w1) > 2) throw new Error(`после перезагрузки ${w2}, было ${w1}`);
    await page.getByRole("separator", { name: "Ширина списка" }).dblclick();
    return `${w0} → ${w1}, после перезагрузки ${w2}`;
  });

  await step("«Работа» открывает последнюю сессию; раздела «Вам» нет", async () => {
    await page.goto(`${env.SB2_BASE}/#/work`);
    await page.waitForFunction((c) => location.hash.includes(c), cs, { timeout: 10_000 });
    if (await page.locator("nav.rail").getByText("Вам", { exact: true }).count()) throw new Error("пункт «Вам» остался");
  });

  await step("«Новая сессия»: разговоры папки списком; занятый — только копией; продолжение открывает сессию", async () => {
    await page.goto(`${env.SB2_BASE}/#/new?machine=${machine}&cwd=${encodeURIComponent(cwd)}`);
    const list = page.getByRole("listbox", { name: "Разговоры папки" });
    await list.getByRole("option").first().waitFor({ timeout: 20_000 });
    const n = await list.getByRole("option").count();
    await list.getByRole("option").filter({ hasText: /занят/ }).first().click();
    if (!(await page.getByLabel("Копией").isChecked())) throw new Error("занятый разговор не стал копией");
    await shot("conversations");
    await page.getByRole("textbox", { name: "Имя" }).fill("talkcopy-" + tag);
    await page.getByRole("button", { name: "Продолжить разговор" }).click();
    await page.waitForFunction((t) => location.hash.includes("talkcopy-" + t), tag, { timeout: 60_000 });
    made.push(`talkcopy-${tag}@${machine}`);
    return `разговоров в папке ${n}`;
  });
} finally {
  await browser.close();
  for (const c of made) call("session.remove", { to: c });
  call("shell.run", { to: "@" + machine, shell: "node", script: `import fs from "node:fs";fs.rmSync(${JSON.stringify(cwd)},{recursive:true,force:true})`, wait: 30 });
  call("revoke", { kid: invite.kid });
}
if (errors.length) console.log("ошибки страницы:\n" + [...new Set(errors)].join("\n"));
console.log(bad || errors.length ? `сбоев: ${bad} из ${total}` : `разговор: ${total} из ${total}`);
process.exit(bad || errors.length ? 1 : 0);
