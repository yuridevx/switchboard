// Живая проверка разговора на выложенной странице: node tools/fleet/live-talk.mjs [флот] [устройство] [машина] [папка снимков]
// Настоящий Chrome и настоящая сессия на ключе флота: откат в том же окне (разговор и файлы), очистка, кольцо контекста, вопрос и ответ карточками ленты,
// «Идут сейчас» со временем от начала работы после перезагрузки, перетаскивание границы списка, разговоры папки в «Новой сессии».
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall, machineTmp } from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet = "test", device = "cli", machine = "devbox", outArg] = process.argv.slice(2);
const out = outArg ?? path.join(root, "dist", "talk");
fs.mkdirSync(out, { recursive: true });
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { call, must } = fleetCall(fleet, device);
const me = must("whoami", {});
const tag = Date.now().toString(36).slice(-4);
const cwd = `${machineTmp(fleet, device, machine)}/sb2-talk-${tag}`;
const made = [];
const state = (cs) => must("fleet.list", { machine }).sessions.find((s) => s.callsign === cs)?.state;
const idle = async (cs, ms = 150_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(1500)) if (state(cs) === "idle") return; throw new Error(`${cs} не освободилась`); };
const fileOn = (name) => String(must("shell.run", { to: "@" + machine, shell: "node", script: `import fs from "node:fs";const p=${JSON.stringify(cwd + "/" + name)};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"")`, wait: 30 }).out ?? "").trim();

// модель сессии сценария — SB2_MODEL или первая из каталога провайдера
const SEAT = process.env.SB2_KEY ?? "muse";
const MODEL = process.env.SB2_MODEL ?? must("keys.models", { name: SEAT }).models[0].id;
const cs = must("session.open", { to: "@" + machine, spec: { name: "talk-" + tag, cwd, key: SEAT, model: MODEL }, mkdir: true }).callsign;
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
// части проверки: turn — ходы сессии со страницы (очередь, молния, откат, вопрос, фон, кольцо); screen — экран (очистка, границы, разрешение, пара, списки)
const PART = process.env.SB2_PART ?? "";
const skip = async () => {};
const stepTurn = !PART || PART === "turn" ? step : skip;
const stepScreen = !PART || PART === "screen" ? step : skip;
const box = page.getByRole("textbox", { name: "Сообщение сессии" });
const opts = page.locator(".composer-opts");
const say = async (text) => { await box.fill(text); await box.press("Enter"); await sleep(2500); await idle(cs); await sleep(1500); };

try {
  await page.goto(`${env.SB2_BASE}/#invite=${encodeURIComponent(invite.invite)}`);
  await page.waitForSelector("nav.rail a", { timeout: 25_000 });
  await page.goto(`${env.SB2_BASE}/#/work/${cs}`);
  await box.waitFor({ timeout: 15_000 });

  await stepTurn("панель сессии после загрузки закрыта: кнопка открывает её и закрывает", async () => {
    const panel = page.locator('aside.insp[aria-label="Инспектор"]');
    if (await panel.count()) throw new Error("панель справа открыта сама");
    const button = opts.getByRole("button", { name: "Инспектор", exact: true });
    await button.click();
    await panel.waitFor({ timeout: 8000 });
    await button.click();
    await panel.waitFor({ state: "detached", timeout: 8000 });
  });

  await stepTurn("Enter во время хода ставит сообщение в очередь: пометка «в очереди» и «Отменить», слов «после хода» нет", async () => {
    // ход на полминуты: команда, которая ничего не делает
    await box.fill("Выполни инструментом Bash одну команду: node -e \"setTimeout(()=>{},30000)\" — и после неё ответь одним словом: готово.");
    await box.press("Enter");
    for (const end = Date.now() + 60_000; state(cs) !== "busy"; await sleep(1000)) if (Date.now() > end) throw new Error(`${cs} не начала ход`);
    for (const name of ["Отправить следующим", "Отправить сейчас", "Прервать ход"]) await page.getByRole("button", { name, exact: true }).waitFor({ timeout: 8000 });
    if (await page.getByLabel("Когда взять сообщение").count()) throw new Error("меню срочности осталось");
    await box.fill("Ответь одним словом: очередь");
    await box.press("Enter");
    const note = page.locator(".me-note").filter({ hasText: "в очереди" }).last();
    await note.waitFor({ timeout: 15_000 });
    await note.getByRole("button", { name: "Отменить" }).waitFor({ timeout: 5000 });
    if (/после хода/.test(await note.innerText())) throw new Error("в пометке осталось «после хода»");
    await shot("queued");
  });

  await stepTurn("молния прерывает ход: в ленте «прервано», сообщение взято сразу", async () => {
    const t0 = Date.now();
    await box.fill("Ответь одним словом: стоп");
    await page.getByRole("button", { name: "Отправить сейчас", exact: true }).click();
    await page.getByText(/^прервано/).last().waitFor({ timeout: 20_000 });
    const ms = Date.now() - t0;
    await shot("now");
    await sleep(2500);
    await idle(cs);
    return `прервано через ${Math.round(ms / 1000)} с после нажатия`;
  });

  await stepTurn("ход со страницы: сессия записала файл", async () => {
    await say("Создай инструментом Write файл page.txt ровно с одной строкой: первый. Больше ничего не делай.");
    await say("Перезапиши инструментом Write файл page.txt ровно с одной строкой: второй. Больше ничего не делай.");
    const text = fileOn("page.txt");
    if (!/второй/.test(text)) throw new Error("файл: " + JSON.stringify(text));
    return "файл: " + text;
  });

  await stepTurn("откат «разговор и файлы» в том же окне: адрес тот же, лента обрезана, след отката, текст в поле ввода, файл вернулся", async () => {
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

  await stepTurn("перезагрузка страницы: лента та же обрезанная, след отката на месте", async () => {
    await page.reload();
    await box.waitFor({ timeout: 15_000 });
    await page.getByText(/Откат к «.+»/).first().waitFor({ timeout: 15_000 });
    if (await page.locator(".feed-in .me").getByText("ровно с одной строкой: второй").count()) throw new Error("откаченное сообщение вернулось");
  });

  await stepTurn("вопрос сессии — карточкой ленты; ответ остаётся карточкой с выбранным вариантом", async () => {
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

  await stepTurn("«Идут сейчас»: фоновая команда строкой; время — от начала работы и после перезагрузки страницы", async () => {
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

  await stepTurn("кольцо контекста: процент виден, нажатие сжимает", async () => {
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

  await stepTurn("ряд под полем: значки действий на месте, «/ команды» нет; шапка без кнопок действий", async () => {
    for (const name of ["Фокус", "Инспектор", "Ещё", "Очистить"]) await opts.getByRole("button", { name, exact: true }).waitFor({ timeout: 8000 });
    if (await opts.getByText("/ команды").count()) throw new Error("кнопка «/ команды» осталась");
    if (await page.locator(".conv-head").getByRole("button", { name: /Ещё|Инспектор/ }).count()) throw new Error("кнопки действий остались в шапке");
  });

  await stepScreen("очистка страницей подтверждения: в ленте «Разговор очищен», адрес тот же", async () => {
    const url = page.url();
    await opts.getByRole("button", { name: "Очистить" }).click();
    await page.getByRole("button", { name: "Очистить", exact: true }).click();
    await page.getByText("Разговор очищен").first().waitFor({ timeout: 40_000 });
    if (page.url().replace(/\?do=.*$/, "") !== url) throw new Error("адрес сменился: " + page.url());
    await shot("cleared");
  });

  await stepScreen("граница списка тянется мышью; ширину помнит устройство", async () => {
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

  await stepScreen("карточка разрешения: причина вопроса и строка правила «Разрешать всегда»; «Разрешить» продолжает ход", async () => {
    await page.goto(`${env.SB2_BASE}/#/work/${cs}`);
    await box.waitFor({ timeout: 15_000 });
    must("session.update", { to: cs, patch: { mode: "ask" } });
    try {
      await idle(cs);
      // файл вне папки сессии: Claude называет причину вопроса и правило с этой папкой (отдельного поля пути SDK для Write не даёт — факт прогона 10 нояб.)
      const outside = "../sb2-talk-" + tag + "-out.txt";
      await box.fill(`Создай инструментом Write файл ${cwd}-out.txt (это рядом с рабочей папкой, вне её) со словом ok. Ничего больше.`);
      await box.press("Enter");
      const card = page.locator(".feed-in .askcard[data-open]");
      await card.first().waitFor({ timeout: 90_000 });
      await card.getByText(/запишет правило/).first().waitFor({ timeout: 5000 });
      await card.getByText(/outside allowed working directories/).first().waitFor({ timeout: 5000 });
      await shot("permission");
      await card.getByRole("button", { name: "Разрешить", exact: true }).click();
      await idle(cs);
      if (fileOn(outside) !== "ok") throw new Error("файл не создан после разрешения");
    } finally {
      // режим возвращается и при сбое шага: следующие шаги идут на свободной сессии
      const open = must("fleet.list", { machine, full: true }).sessions.find((x) => x.callsign === cs)?.ask;
      if (open) call("answer", { to: cs, ask: open.id, answer: { action: "deny" } });
      call("session.update", { to: cs, patch: { mode: "all" } });
      call("shell.run", { to: "@" + machine, shell: "node", script: `import fs from "node:fs";fs.rmSync(${JSON.stringify(cwd + "-out.txt")},{force:true})`, wait: 30 });
    }
  });

  await stepScreen("граница списка тянется пальцем", async () => {
    await idle(cs);
    const width = async () => Math.round((await page.locator(".pane.list").boundingBox()).width);
    const w0 = await width();
    const b = await page.getByRole("separator", { name: "Ширина списка" }).boundingBox();
    // настоящее касание через протокол браузера: события указателя вида touch рождает сам Chrome
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const x0 = Math.round(b.x + b.width / 2), y = Math.round(b.y + 200);
    const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    try {
      await touch("touchStart", x0);
      for (const dx of [20, 40, 60]) { await touch("touchMove", x0 + dx); await sleep(60); }
      await touch("touchEnd", x0 + 60);
      await sleep(300);
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    const w1 = await width();
    await page.getByRole("separator", { name: "Ширина списка" }).dblclick();
    if (Math.abs(w1 - w0 - 60) > 12) throw new Error(`ширина ${w0} → ${w1}`);
    return `${w0} → ${w1}`;
  });

  await stepScreen("пара: шапка с двумя участниками, выбор стороны, «обе» и инспектор у стороны ведомого", async () => {
    const wing = must("session.update", { to: cs, patch: {}, pair: true }).wing;
    try {
      await idle(wing);
      await page.goto(`${env.SB2_BASE}/#/work/${cs}`);
      const bar = page.getByRole("group", { name: "Пара" });
      await bar.waitFor({ timeout: 20_000 });
      if ((await bar.locator(".pm-who").count()) !== 2) throw new Error("в шапке пары не два участника");
      const who = bar.locator(`.pm-who[aria-label$="${wing}"]`);
      // выбрать ведомого: показана его сторона, адрес — его
      await who.click();
      await page.waitForFunction((w) => location.hash.includes(w), wing, { timeout: 10_000 });
      // повторное нажатие на показанную сторону — обе рядом
      if (!(await page.locator(".talk.pair").count())) await who.click();
      await page.locator(".talk.pair").waitFor({ timeout: 10_000 });
      if ((await page.locator(".talk.pair .conv").count()) !== 2) throw new Error("при «обе» не два разговора");
      // инспектор стороны ведомого: его разговор и инспектор, ведущая остаётся участником шапки
      await page.locator(".talk.pair .conv").nth(1).locator(".composer-opts").getByRole("button", { name: "Инспектор" }).click();
      await page.locator('aside.insp[aria-label="Инспектор"]').waitFor({ timeout: 10_000 });
      if ((await page.locator(".talk .conv").count()) !== 1) throw new Error("с инспектором показаны оба разговора");
      if ((await bar.locator(".pm-who").count()) !== 2) throw new Error("вторая сторона пропала из шапки");
      await shot("pair-inspector");
      // закрытие инспектора возвращает обе стороны
      await page.locator(".composer-opts").getByRole("button", { name: "Инспектор" }).first().click();
      await page.locator(".talk.pair").waitFor({ timeout: 10_000 });
    } finally {
      call("session.update", { to: cs, patch: { wing: null } });
    }
  });

  await stepScreen("«Работа» открывает последнюю сессию; раздела «Вам» нет", async () => {
    // последняя — та, что человек открывал последней
    await page.goto(`${env.SB2_BASE}/#/work/${cs}`);
    await box.first().waitFor({ timeout: 15_000 });
    await page.goto(`${env.SB2_BASE}/#/fleet/machines`);
    await page.waitForFunction(() => location.hash.startsWith("#/fleet"), null, { timeout: 10_000 });
    await page.goto(`${env.SB2_BASE}/#/work`);
    await page.waitForFunction((c) => location.hash.includes(c), cs, { timeout: 10_000 });
    if (await page.locator("nav.rail").getByText("Вам", { exact: true }).count()) throw new Error("пункт «Вам» остался");
  });

  await stepScreen("«Новая сессия»: разговоры папки списком; занятый — только копией; продолжение открывает сессию", async () => {
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
