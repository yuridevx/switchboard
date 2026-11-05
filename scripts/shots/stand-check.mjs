// Прогон стенда настоящим браузером на тестовом флоте: страница входит по приглашению и видит настоящие сессии, комментарии по C в обеих раскладках,
// мышью и пальцем, файл для агента, разделение флотов, перезагрузка при правке. Пропуска проверки отзываются в конце. npm run stand:check
// STAND_CHECK=fake — без настоящих флотов и пропуска: страница stand-fake.ts, адреса флотов от своего сервера, проверяются сервер стенда и комментарии.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checker } from "./kit.mjs";
import { launch } from "./stand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "dist", "stand-check");
const PORT = 4799;
const TEST = `http://localhost:${PORT}/`;
const PROD = `http://localhost:${PORT + 1}/`;
const fileOf = (fleet) => join(OUT, `comments-${fleet}.json`);
const FAKE = process.env.STAND_CHECK === "fake";
const AGENT = FAKE ? "" : readFileSync(join(process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev"), "test-agent.pass"), "utf8").trim();
const WAIT_MS = 5000;
const FLEET_MS = 30_000;
const ROW = ".bd-row[data-callsign]";

const { check, bad } = checker();
const stored = (fleet = "test") => (existsSync(fileOf(fleet)) ? JSON.parse(readFileSync(fileOf(fleet), "utf8")).comments : []);
const until = async (f, ms = WAIT_MS) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** Что видно у наложения: режим выбора, карточка, сколько меток видно. */
const overlay = (p) =>
  p.evaluate(() => {
    const r = document.getElementById("stand-comments").shadowRoot;
    return { pick: !r.querySelector(".chip").hidden, card: !r.querySelector(".card").hidden, pins: [...r.querySelectorAll(".pin")].filter((x) => !x.hidden).length };
  });
/** Клавиша, как её шлёт браузер в другой раскладке: Playwright печатает только латиницу. */
const key = (p, k, code, extra = {}) => p.evaluate(([k, code, extra]) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, composed: true, ...extra })), [k, code, extra]);
const inShadow = (p, sel) => p.locator(`#stand-comments ${sel}`);
/** Строки сессий: у проверочного пропуска своих нет — фильтр «Всё», проект свёрнут — раскрыть первый. */
async function allSessions(p) {
  await p.evaluate(() => (location.hash = "#sessions"));
  if (FAKE) return void (await p.waitForSelector(ROW, { timeout: FLEET_MS }));
  await p.locator('.fbar .fc:has-text("Всё")').first().click({ timeout: FLEET_MS });
  await p.waitForSelector(".pj-t", { timeout: FLEET_MS });
  const shut = p.locator('.pj-t[aria-expanded="false"]');
  if (!(await p.locator(ROW).count()) && (await shut.count())) await shut.first().click();
  await p.waitForSelector(ROW, { timeout: FLEET_MS });
}

rmSync(OUT, { recursive: true, force: true });
/** Страница флота в поддельном режиме: только build.json. */
const fleetPage = (fleet) =>
  new Promise((done) => {
    const s = createServer((_, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ workers: { relay: `wss://${fleet}`, gate: `https://gate-${fleet}` } }));
    });
    s.listen(0, "127.0.0.1", () => done(s));
  });
const fakes = FAKE ? [await fleetPage("test"), await fleetPage("prod")] : [];
const fakeEnv = FAKE ? { STAND_ENTRY: join(here, "stand-fake.ts"), STAND_PAGES: JSON.stringify({ test: `http://127.0.0.1:${fakes[0].address().port}`, prod: `http://127.0.0.1:${fakes[1].address().port}` }) } : {};
const server = spawn(process.execPath, [join(here, "dev.mjs")], { env: { ...process.env, STAND_OUT: OUT, STAND_PORT: String(PORT), ...fakeEnv }, stdio: ["ignore", "pipe", "inherit"] });
const output = [];
server.stdout.on("data", (d) => output.push(String(d)));
await until(() => output.join("").includes("стенд prod:") && output.join("").includes("стенд test:"), FLEET_MS);

const test = await (await fetch(`${TEST}fleet.json`)).json();
const prod = await (await fetch(`${PROD}fleet.json`)).json();
check("у флотов свои адреса: тест и прод", test.fleet === "test" && prod.fleet === "prod" && test.workers.relay !== prod.workers.relay, `${test.workers.relay} · ${prod.workers.relay}`);

const post = async (url, f) => (await fetch(url, { method: "POST", body: JSON.stringify({ id: "stand-check", v: 1, key: AGENT, ...f }) })).json();
const mine = [];
/** Приглашение проверочного устройства тестового флота; отзыв — в конце прогона. */
async function invite(name) {
  if (FAKE) return `fake-${name}`;
  const r = await post(test.workers.gate, { type: "keys.invite", role: "client", name, person: "stand-check@example.com" });
  if (!r.ok) throw new Error(`keys.invite: ${r.error}`);
  mine.push(r.result.kid);
  return r.result.invite;
}

const b = await launch();
try {
  const machines = FAKE ? ["pc"] : (await post(test.workers.gate, { type: "keys.list", role: "host" })).result.passes.map((x) => x.name);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [];
  const react = new Set();
  p.on("pageerror", (e) => errs.push(e.message));
  // 400 — страница прочла файл посреди записи и перечитает его по следующему событию; предупреждения React о коде страниц — находки, а не отказ стенда
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error" || t.includes("status of 400")) return;
    if (t.includes("Encountered two children")) react.add(t.slice(t.indexOf("version.") + 8, t.indexOf("version.") + 88).trim());
    else errs.push(t);
  });
  await p.goto(`${TEST}#invite=${await invite("stand-check")}`);
  await p.waitForFunction(() => !location.hash.includes("invite"), null, { timeout: FLEET_MS });
  await allSessions(p);
  const cs = await p.locator(ROW).first().getAttribute("data-callsign");
  check("страница по приглашению видит настоящие сессии флота", machines.some((m) => cs.endsWith(`@${m}`)), `${cs} · машины ${machines.join(" ")}`);

  // ───── клавиша ─────
  for (const [k, code, name] of [["c", "KeyC", "латинская c"], ["C", "KeyC", "заглавная C"], ["с", "KeyC", "русская с"], ["С", "KeyC", "заглавная С"], ["с", "", "русская с без кода клавиши"]]) {
    await key(p, k, code);
    const on = (await overlay(p)).pick;
    await p.keyboard.press("Escape");
    check(`${name} включает выбор, Esc выключает`, on && !(await overlay(p)).pick);
  }
  await key(p, "c", "KeyC", { ctrlKey: true });
  check("Ctrl+C не включает выбор", !(await overlay(p)).pick);
  await p.keyboard.press("Control+k");
  await p.waitForSelector(".sb-palin");
  await p.keyboard.type("c");
  check("в поле ввода c печатается, а не включает выбор", (await p.inputValue(".sb-palin")) === "c" && !(await overlay(p)).pick);
  await p.keyboard.press("Escape");

  // ───── мышь: элемент → текст → файл ─────
  const target = `${ROW}[data-callsign="${cs}"]`;
  const hash = await p.evaluate(() => location.hash);
  await p.keyboard.press("c");
  await p.hover(target);
  check("наведение рисует рамку", await p.evaluate(() => !document.getElementById("stand-comments").shadowRoot.querySelector(".box").hidden));
  await p.click(target);
  check("нажатие в режиме выбора не открывает сессию", (await p.evaluate(() => location.hash)) === hash);
  check("нажатие открывает поле комментария", (await overlay(p)).card);
  await p.keyboard.type("Строка слишком низкая");
  await p.keyboard.press("Enter");
  check("Enter сохраняет в файл своего флота", await until(() => stored().length === 1), stored()[0]?.selector);
  const c = stored()[0];
  check("запись несёт текст, флот, приложение, экран и адрес", c?.text === "Строка слишком низкая" && c.kind === "test" && c.app === "pult" && c.screen === "board" && c.hash === hash, JSON.stringify({ kind: c?.kind, app: c?.app, screen: c?.screen, hash: c?.hash }));
  check("метка появилась", await until(async () => (await overlay(p)).pins === 1));
  await p.reload();
  await allSessions(p);
  check("пропуск и метка переживают перезагрузку", await until(async () => (await overlay(p)).pins === 1));

  // ───── метка на чужом экране и список ─────
  await p.evaluate(() => (location.hash = "#machines"));
  check("на другом экране метки нет", await until(async () => (await overlay(p)).pins === 0));
  await p.keyboard.press("c");
  await inShadow(p, ".it").first().click();
  check("строка списка возвращает на экран комментария", await until(async () => { const o = await overlay(p); return o.pins === 1 && o.card; }));
  await p.keyboard.press("Escape");

  // ───── агент закрывает: запись удалена из файла ─────
  writeFileSync(fileOf("test"), JSON.stringify({ comments: [] }, null, 1));
  check("запись удалена из файла — метка снята без перезагрузки", await until(async () => (await overlay(p)).pins === 0));

  // ───── удаление на странице ─────
  await p.keyboard.press("c");
  await p.click(target);
  await p.keyboard.type("На удаление");
  await p.keyboard.press("Enter");
  await until(async () => (await overlay(p)).pins === 1);
  await inShadow(p, ".pin").first().click();
  await inShadow(p, ".card .act").last().click();
  check("«Удалить» убирает запись из файла и метку", (await until(() => stored().length === 0)) && (await until(async () => (await overlay(p)).pins === 0)));

  // ───── обход разделов на настоящем флоте ─────
  for (const h of ["#inbox", "#incidents", "#machines", "#accounts", "#profiles", "#journal", "#points", "#settings", "#sessions"]) {
    await p.evaluate((x) => (location.hash = x), h);
    await p.waitForTimeout(600);
  }
  check("ошибок страницы нет", errs.length === 0, errs.slice(0, 3).join(" | ").slice(0, 400));
  if (react.size) console.log(`! React: повторяющиеся ключи · ${[...react].join(" · ")}`);

  // ───── перезагрузка при правке ─────
  await p.evaluate(() => (window.__mark = 1));
  const src = join(here, FAKE ? "stand-fake.ts" : "live.ts");
  const was = readFileSync(src, "utf8");
  let reloaded = false;
  try {
    writeFileSync(src, was + "\n");
    reloaded = await until(() => p.evaluate(() => window.__mark === undefined).catch(() => false), 15000);
  } finally {
    writeFileSync(src, was);
  }
  check("правка исходника перезагружает страницу", reloaded);
  await ctx.close();

  // ───── прод: свой адрес, без пропуска — поле приглашения, комментарии отдельно ─────
  {
    const c2 = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const q = await c2.newPage();
    await q.goto(PROD);
    await q.waitForSelector(".sb-keyin", { timeout: FLEET_MS });
    check("прод без пропуска просит приглашение", true);
    await q.keyboard.press("c");
    await q.click("h1, h2, p");
    await q.keyboard.type("Про прод");
    await q.keyboard.press("Enter");
    check("комментарий прода — в файле прода, не теста", (await until(() => stored("prod").length === 1)) && stored("test").length === 0 && stored("prod")[0].kind === "prod");
    await c2.close();
  }

  // ───── телефон: рамка на широком окне и палец ─────
  {
    const c3 = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const q = await c3.newPage();
    await q.goto(`${TEST}?app=phone`);
    await q.frameLocator("iframe").locator(".sb-keyin").waitFor({ timeout: FLEET_MS });
    const w = await q.evaluate(() => document.querySelector("iframe").contentWindow.innerWidth);
    check("телефон на широком окне — окно в 390 пикселей", w === 390, w);
    await q.keyboard.press("c");
    check("C работает внутри рамки", (await overlay(q.frames()[1])).pick);
    await c3.close();

    const c4 = await b.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const t = await c4.newPage();
    await t.goto(`${TEST}?app=phone#invite=${await invite("stand-check-phone")}`);
    await t.waitForFunction(() => !location.hash.includes("invite"), null, { timeout: FLEET_MS });
    await allSessions(t);
    check("в окне телефона рамки нет", (await t.locator("iframe").count()) === 0);
    const h0 = await t.evaluate(() => location.hash);
    await t.keyboard.press("c");
    await t.tap(ROW);
    check("палец: касание выбирает элемент и не открывает сессию", (await overlay(t)).card && (await t.evaluate(() => location.hash)) === h0);
    await t.keyboard.type("С телефона");
    await t.keyboard.press("Enter");
    check("палец: запись с телефона в файле", await until(() => stored().some((x) => x.app === "phone")));
    await c4.close();
  }
} finally {
  await b.close();
  server.kill();
  for (const s of fakes) s.close();
  for (const kid of mine) {
    const r = await post(test.workers.relay, { type: "keys.revoke", kid });
    if (!r.ok) {
      check(`пропуск ${kid} отозван`, false, r.error);
    }
  }
  console.log(`пропусков проверки отозвано: ${mine.length}`);
}
console.log(bad() ? `не прошло: ${bad()}` : "без замечаний");
process.exit(bad() ? 1 : 0);
