// Живая проверка «Файлов сессии» на настоящем флоте: node tools/fleet/live-files.mjs [флот] [устройство] [машина] [папка снимков]
// Своя сессия на машине (провайдер и модель — SB2_KEY и SB2_MODEL), настоящий Chrome на выложенной странице:
//   человек загружает файл из поля ввода → файл в хранилище и в папке сессии; сессия читает загруженное; сессия отправляет файл инструментом —
//   содержимое мимо её разговора; сессия поднимает сайт — он открывается в песочнице; большой файл с телефона в папку сессии и обратно — секунды.
// Размер большого файла — SB2_BIG_MB (по умолчанию 100). KEEP=1 — сессию не убирать.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../dev.mjs";
import { fleetCall, launchBrowser, machineTmp, newTag } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet = "test", device = "cli", machine = "devbox", outArg] = process.argv.slice(2);
const SEAT = process.env.SB2_KEY ?? "claude";
const MODEL = process.env.SB2_MODEL ?? "claude-haiku-5-5";
const BIG_MB = Number(process.env.SB2_BIG_MB ?? 100);
const out = outArg ?? path.join(root, "dist", "live");
fs.mkdirSync(out, { recursive: true });
const { call, must } = fleetCall(fleet, device);
const base = fleetEnv.SB2_BASE;

const tag = newTag();
const name = "files" + tag;
// папка сессии — полным путём машины: его называют шаги сценария хода
const cwd = `${machineTmp(fleet, device, machine)}/sb2-live-files-${tag}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-live-files-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => new Promise((done, fail) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => done(h.digest("hex"))).on("error", fail);
});
/** Файл случайных байт: содержимое, которого нет ни в одном разговоре. */
function randomFile(file, mb) {
  const fd = fs.openSync(file, "w");
  for (let i = 0; i < mb; i++) fs.writeSync(fd, crypto.randomBytes(1024 * 1024));
  fs.closeSync(fd);
  return file;
}

const steps = [];
let bad = 0;
async function step(label, fn) {
  const t0 = Date.now();
  try {
    steps.push(`✓ ${label} · ${(await fn()) ?? ""} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    steps.push(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
  console.log(steps.at(-1));
}
/** Причина, по которой ждать дальше незачем. */
class Stop extends Error {}
async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { if (e instanceof Stop) throw e; v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(2000);
  }
}

const me = must("whoami", {});
const invite = must("invite", { addr: name + me.person });
const callsign = must("session.open", { to: "@" + machine, spec: { name, cwd, key: SEAT, model: MODEL }, mkdir: true }).callsign;
const rowOf = () => must("fleet.list", { machine, full: true }).sessions.find((s) => s.callsign === callsign);
/** Конец хода. Сессия ждёт аккаунт или упала — ждать нечего: отказ сразу, с причиной из её строки. */
const idle = () => until(`${callsign} свободна`, () => {
  const r = rowOf();
  if (r?.wait || r?.state === "failed") throw new Stop(r.wait ? `у сессии нет годного аккаунта до ${new Date(r.wait).toISOString()}` : `сессия упала: ${r.error ?? ""}`);
  return r?.state === "idle";
}, 400_000);
/** Сообщение сессии и конец её хода. */
async function turn(text) {
  must("message", { to: callsign, text });
  await until("ход начался", () => ["busy", "waiting"].includes(rowOf()?.state ?? ""), 30_000).catch(() => {});
  await idle();
}
const history = () => must("session.history", { to: callsign, limit: 200 }).events;
const blocksOf = (events) => events.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
/** Ответ вызова инструмента, чьё имя кончается на tool и чей ввод подошёл: разобранный JSON. */
function answerOf(events, tool, fits) {
  const blocks = blocksOf(events);
  const use = blocks.findLast((b) => b.type === "tool_use" && String(b.name).endsWith(tool) && fits(b.input ?? {}));
  if (!use) throw new Error(`вызова ${tool} в разговоре нет`);
  const res = blocks.find((b) => b.type === "tool_result" && b.tool_use_id === use.id);
  const text = typeof res?.content === "string" ? res.content : (res?.content ?? []).map((c) => c.text ?? "").join("");
  if (res?.is_error) throw new Error(`${tool} отказал: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const linkOf = (hash, fileName) => must("files.get", { hash, ...(fileName ? { name: fileName } : {}) }).url;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const box = () => page.getByLabel("Сообщение сессии");
/** Файл — в поле ввода страницы, сообщение — Enter; ждём, пока машина примет сообщение: в истории оно с файлом по имени.
 *  Сообщение «не ушло» (файл не уложился в предел запроса) — человек жмёт «Отправить ещё раз»: машина докачивает с места обрыва. sends — сколько раз отправляли. */
async function uploadFromPage(file, text, ms = 600_000) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.getByRole("button", { name: `Убрать ${path.basename(file)}` }).waitFor({ timeout: 30_000 });
  await box().fill(text);
  const t0 = Date.now();
  await box().press("Enter");
  let sends = 1;
  const again = page.getByRole("button", { name: "Отправить ещё раз" });
  const said = await until(`сообщение с ${path.basename(file)} принято машиной`, async () => {
    const got = history().findLast((e) => e.type === "user" && e.files?.some((f) => f.name === path.basename(file)));
    if (!got && (await again.count())) {
      sends++;
      await again.first().click();
    }
    return got;
  }, ms);
  return { file: said.files.find((f) => f.name === path.basename(file)), text: said.message?.content, ms: Date.now() - t0, sends };
}
/** «Скачать» в карточке или строке файла: содержимое на диск, его хэш. */
async function downloadFromPage(scope, fileName) {
  const got = page.waitForEvent("download", { timeout: 600_000 });
  await scope.getByRole("button", { name: `Скачать ${fileName}` }).first().click();
  const d = await got;
  const to = path.join(tmp, "back-" + d.suggestedFilename());
  await d.saveAs(to);
  return { name: d.suggestedFilename(), hash: await sha(to), size: fs.statSync(to).size };
}

try {
  await step("приглашение принято, разговор сессии открыт", async () => {
    await page.goto(base + "/#invite=" + encodeURIComponent(invite.invite));
    await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 30_000 });
    await idle();
    await page.goto(base + "/#/work/" + callsign);
    await box().waitFor({ timeout: 30_000 });
    return callsign;
  });

  await step("страница кладёт 5 МиБ в хранилище и читает обратно — хэш сходится; файл встал в папку сессии", async () => {
    const file = randomFile(path.join(tmp, "five.bin"), 5);
    const hash = await sha(file);
    const up = await uploadFromPage(file, script(say("принято")));
    if (up.file.hash !== hash || up.file.size !== 5 * 1024 * 1024) throw new Error(`в сообщении не тот файл: ${JSON.stringify(up.file)}`);
    if (String(up.text).includes("Загружены файлы")) throw new Error("лента получила строку уведомления, а не разобранное");
    await idle();
    const back = await downloadFromPage(page.locator('.me-file[data-file="five.bin"]'), "five.bin");
    if (back.hash !== hash || back.name !== "five.bin") throw new Error(`скачалось не то: ${JSON.stringify(back)}`);
    return `туда ${up.ms} мс, хэш ${hash.slice(0, 12)}…`;
  });

  await step("сессия читает загруженный файл: ответ — его содержимое", async () => {
    const word = "слово-" + crypto.randomBytes(4).toString("hex");
    const file = path.join(tmp, "secret.txt");
    fs.writeFileSync(file, word + "\n");
    await uploadFromPage(file, script(tool("Read", { file_path: `${cwd}/uploads/secret.txt` }), say("в файле: {итог 1}")));
    await idle();
    const texts = blocksOf(history().filter((e) => e.type === "assistant")).filter((b) => b.type === "text").map((b) => b.text);
    if (!texts.at(-1)?.includes(word)) throw new Error(`в ответе нет содержимого файла: ${String(texts.at(-1)).slice(0, 120)}`);
    return word;
  });

  let sent;
  await step("сессия отправляет файл инструментом: в хранилище он целиком, в её разговоре содержимого нет", async () => {
    await turn(script(
      tool("Bash", { command: `node -e "const c=require('crypto'),f=require('fs');f.mkdirSync('out',{recursive:true});f.writeFileSync('out/data.txt',c.randomBytes(150000).toString('hex'))"` }),
      tool("mcp__fleet__file_send", { to: callsign, path: "out/data.txt", title: "Данные" }),
      say("отправлено"),
    ));
    const events = history();
    // путь сессия называет и от своей папки, и полным; вызов, потерянный на обрыве связи машины, она повторяет — считаем вызовы
    const mine = (i) => String(i.path).replaceAll("\\", "/").endsWith("out/data.txt");
    const calls = blocksOf(events).filter((b) => b.type === "tool_use" && String(b.name).endsWith("file_send") && mine(b.input ?? {})).length;
    sent = answerOf(events, "file_send", mine);
    if (sent.name !== "data.txt" || sent.size !== 300_000 || Object.keys(sent).sort().join() !== "hash,name,size") throw new Error(`ответ инструмента не тот: ${JSON.stringify(sent)}`);
    const body = Buffer.from(await (await fetch(linkOf(sent.hash))).arrayBuffer());
    if (body.length !== 300_000 || crypto.createHash("sha256").update(body).digest("hex") !== sent.hash) throw new Error("содержимое в хранилище не сходится с хэшем");
    // содержимого в разговоре нет: кусок из середины файла не встречается ни в одной записи
    const piece = body.subarray(150_000, 150_064).toString();
    if (JSON.stringify(events).includes(piece)) throw new Error("содержимое файла попало в разговор");
    const card = page.locator('.fileshow[data-file$="data.txt"]').last();
    await card.waitFor({ timeout: 30_000 });
    await card.locator("pre.filetext").waitFor({ timeout: 30_000 });
    const size = rowOf()?.cache?.size;
    return `файл 300 000 знаков (~75 000 токенов), в контексте сессии ${size ?? "?"} токенов, содержимого в разговоре 0; вызовов file_send: ${calls}`;
  });

  await step("сессия поднимает сайт из 3 файлов: открывается по адресу, стили и скрипт по относительным путям, пропуск страницы ему не виден", async () => {
    await turn(script(
      tool("Write", { file_path: `${cwd}/out/site/index.html`, content: `<!doctype html><meta charset="utf-8"><title>ждёт</title><link rel="stylesheet" href="site.css"><h1>Отчёт ${tag}</h1><script src="js/site.js"></script>` }),
      tool("Write", { file_path: `${cwd}/out/site/site.css`, content: "h1 { color: rgb(1, 2, 3); }" }),
      tool("Write", { file_path: `${cwd}/out/site/js/site.js`, content: `document.title = "loaded-${tag}";` }),
      tool("mcp__fleet__site_publish", { to: callsign, dir: "out/site", title: "Отчёт" }),
      say("поднято"),
    ));
    const site = answerOf(history(), "site_publish", (i) => String(i.dir).replace(/\\/g, "/").replace(/\/$/, "").endsWith("out/site"));
    if (!/\/s\/[0-9a-f]{32}\/$/.test(site.url) || site.files !== 3 || "sent" in site) throw new Error(`ответ сайта не тот: ${JSON.stringify(site)}`);
    const tab = await browser.newPage();
    try {
      const res = await tab.goto(site.url);
      if (res.headers()["content-security-policy"] !== "sandbox allow-scripts allow-forms allow-popups") throw new Error("сайт отдан без заголовка песочницы");
      await tab.waitForFunction((t) => document.title === "loaded-" + t, tag, { timeout: 15_000 });
      const seen = await tab.evaluate(() => {
        let store;
        try { localStorage.getItem("x"); store = "open"; } catch (e) { store = e.name; }
        return { h1: document.querySelector("h1")?.textContent, color: getComputedStyle(document.querySelector("h1")).color, store, origin: location.origin, self: window.origin };
      });
      if (seen.h1 !== `Отчёт ${tag}` || seen.color !== "rgb(1, 2, 3)") throw new Error(`сайт показан не тот: ${JSON.stringify(seen)}`);
      if (seen.store !== "SecurityError" || seen.self !== "null") throw new Error(`сайт не в песочнице: ${JSON.stringify(seen)}`);
    } finally {
      await tab.close();
    }
    const frame = page.locator('.fileshow[data-site] iframe.htmlframe').last();
    await frame.waitFor({ timeout: 30_000 });
    await page.frameLocator('.fileshow[data-site] iframe.htmlframe').last().locator("h1").waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(out, `files-${machine}-1280.png`) });
    return site.url;
  });

  await step(`телефон: файл ${BIG_MB} МиБ в папку сессии и обратно — хэш сходится`, async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const file = randomFile(path.join(tmp, "big.bin"), BIG_MB);
    const hash = await sha(file);
    const up = await uploadFromPage(file, script(tool("mcp__fleet__file_send", { to: callsign, path: "uploads/big.bin", title: "Обратно" }), say("отправлено")), 1_200_000);
    if (up.file.hash !== hash) throw new Error("в сообщении не тот хэш");
    await idle();
    const back = answerOf(history(), "file_send", (i) => String(i.path).replace(/\\/g, "/").endsWith("uploads/big.bin"));
    if (back.hash !== hash || back.size !== BIG_MB * 1024 * 1024) throw new Error(`сессия отправила не то: ${JSON.stringify(back)}`);
    const card = page.locator('.fileshow[data-file$="big.bin"]').last();
    await card.waitFor({ timeout: 30_000 });
    const t0 = Date.now();
    const got = await downloadFromPage(card, "big.bin");
    if (got.hash !== hash) throw new Error("скачанное с телефона не сходится с хэшем");
    await page.screenshot({ path: path.join(out, `files-${machine}-390.png`) });
    // сколько заняла сама машина — в её журнале: приём файла в папку и отправка обратно
    const lines = must("machine.journal", { to: "@" + machine, session: callsign, limit: 200 }).lines.filter((l) => l.hash === hash);
    const ms = (msg) => lines.find((l) => l.msg === msg)?.ms;
    return `туда ${(up.ms / 1000).toFixed(1)} с за ${up.sends} отправк. (из них машина ${((ms("file_upload") ?? 0) / 1000).toFixed(1)} с), обратно: машина ${((ms("file_send") ?? 0) / 1000).toFixed(1)} с, скачивание ${((Date.now() - t0) / 1000).toFixed(1)} с`;
  });

  await step("журнал машины: строка на каждую загрузку, отправку и сайт — с хэшем, без содержимого", async () => {
    const lines = must("machine.journal", { to: "@" + machine, session: callsign, limit: 200 }).lines;
    const count = (msg) => lines.filter((l) => l.msg === msg).length;
    const n = { file_upload: count("file_upload"), file_send: count("file_send"), site_publish: count("site_publish") };
    if (n.file_upload < 3 || n.file_send < 2 || n.site_publish < 1) throw new Error(`строк журнала меньше, чем действий: ${JSON.stringify(n)}`);
    if (!lines.filter((l) => l.msg === "file_send" || l.msg === "file_upload").every((l) => /^[0-9a-f]{64}$/.test(l.hash) && typeof l.size === "number")) throw new Error("в строке журнала нет хэша или размера");
    return JSON.stringify(n);
  });
} finally {
  await browser.close();
  call("revoke", { kid: invite.kid });
  if (!process.env.KEEP) call("session.remove", { to: callsign });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`шагов: ${steps.length - bad} из ${steps.length} · машина ${machine} · ошибок страницы: ${errors.length} ${errors.slice(0, 5).join(" | ").slice(0, 600)}`);
console.log("снимки:", out);
process.exit(bad || errors.length ? 1 : 0);
