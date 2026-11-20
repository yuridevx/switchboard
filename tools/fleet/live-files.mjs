// Живая проверка «Файлов сессии» на настоящем флоте: node tools/fleet/live-files.mjs [флот] [устройство] [машина]
// Своя сессия на машине (провайдер и модель — SB2_KEY и SB2_MODEL), настоящий браузер на выложенной странице:
//   человек загружает файл из поля ввода → файл в хранилище и в папке сессии; сессия читает загруженное; сессия отправляет файл инструментом —
//   содержимое мимо её разговора; сессия поднимает сайт — он открывается в песочнице; большой файл с телефона в папку сессии и обратно — секунды.
// Размер большого файла — SB2_BIG_MB (по умолчанию 100). KEEP=1 — сессию не убирать. Снимки — dist/live/files.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const BIG_MB = Number(process.env.SB2_BIG_MB ?? 100);
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

await check(async (t) => {
  // файлы проверки на этом компьютере: случайные байты туда, скачанное обратно
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-live-files-"));
  t.defer("папка файлов проверки", async () => void fs.rmSync(tmp, { recursive: true, force: true }));
  let s, page;
  const box = () => page.getByLabel("Сообщение сессии");
  /** Строки журнала машины о своей сессии. */
  const journal = async () => (await t.must("machine.journal", { to: "@" + t.machine, session: s.callsign, limit: 200 })).lines;
  /** Файл — в поле ввода страницы, сообщение — Enter; ждём, пока машина примет сообщение: в истории оно с файлом по имени. Ответ — запись сообщения. */
  async function uploadFromPage(file, text) {
    const name = path.basename(file);
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByRole("button", { name: `Убрать ${name}` }).waitFor();
    await box().fill(text);
    const t0 = Date.now();
    await box().press("Enter");
    const again = page.getByRole("button", { name: "Отправить ещё раз" });
    const said = await t.wait(`сообщение с ${name} принято машиной`, async () => {
      // файл не уложился в предел одного запроса — страница предлагает человеку отправить ещё раз: это отказ шага, жать за человека проверка не станет
      if (await again.count()) throw new Error(`сообщение с ${name} не ушло с первой отправки: страница предлагает «Отправить ещё раз»`);
      return (await s.history()).findLast((e) => e.type === "user" && e.files?.some((f) => f.name === name));
    }, () => "сообщения с файлом в истории ещё нет");
    return { uuid: said.uuid, file: said.files.find((f) => f.name === name), text: said.message?.content, ms: Date.now() - t0 };
  }
  /** «Скачать» в карточке или строке файла: содержимое на диск, его хэш. */
  async function downloadFromPage(scope, fileName) {
    const got = page.waitForEvent("download");
    await scope.getByRole("button", { name: `Скачать ${fileName}` }).first().click();
    const d = await got;
    const to = path.join(tmp, "back-" + d.suggestedFilename());
    await d.saveAs(to);
    return { name: d.suggestedFilename(), hash: await sha(to), size: fs.statSync(to).size };
  }

  await t.step("приглашение принято, разговор сессии открыт", async () => {
    s = await t.session({ name: "files" });
    page = await t.page({ width: 1280, height: 900, acceptDownloads: true, console: true });
    await page.goto(t.base + "/#/work/" + s.callsign);
    await box().waitFor();
    return s.callsign;
  });

  await t.step("страница кладёт 5 МиБ в хранилище и читает обратно — хэш сходится; файл встал в папку сессии", async () => {
    const file = randomFile(path.join(tmp, "five.bin"), 5);
    const hash = await sha(file);
    const up = await uploadFromPage(file, script(say("принято")));
    if (up.file.hash !== hash || up.file.size !== 5 * 1024 * 1024) throw new Error(`в сообщении не тот файл: ${JSON.stringify(up.file)}`);
    if (String(up.text).includes("Загружены файлы")) throw new Error("лента получила строку уведомления, а не разобранное");
    await s.ended(up.uuid);
    const back = await downloadFromPage(page.locator('.me-file[data-file="five.bin"]'), "five.bin");
    if (back.hash !== hash || back.name !== "five.bin") throw new Error(`скачалось не то: ${JSON.stringify(back)}`);
    return `туда ${up.ms} мс, хэш ${hash.slice(0, 12)}…`;
  });

  await t.step("сессия читает загруженный файл: ответ — его содержимое", async () => {
    const word = "слово-" + crypto.randomBytes(4).toString("hex");
    const file = path.join(tmp, "secret.txt");
    fs.writeFileSync(file, word + "\n");
    const up = await uploadFromPage(file, script(tool("Read", { file_path: `${s.cwd}/uploads/secret.txt` }), say("в файле: {итог 1}")));
    const reply = await s.ended(up.uuid);
    if (!reply.text.includes(word)) throw new Error(`в ответе нет содержимого файла: ${reply.text.slice(0, 120)}`);
    return word;
  });

  await t.step("сессия отправляет файл инструментом: в хранилище он целиком, в её разговоре содержимого нет", async () => {
    await s.turn(script(
      tool("Bash", { command: `node -e "const c=require('crypto'),f=require('fs');f.mkdirSync('out',{recursive:true});f.writeFileSync('out/data.txt',c.randomBytes(150000).toString('hex'))"` }),
      tool("mcp__fleet__file_send", { to: s.callsign, path: "out/data.txt", title: "Данные" }),
      say("отправлено"),
    ));
    const events = await s.history();
    // путь сессия называет и от своей папки, и полным; вызов, потерянный на обрыве связи машины, она повторяет — число вызовов идёт в заметку шага
    const mine = (i) => String(i.path).replaceAll("\\", "/").endsWith("out/data.txt");
    const calls = blocksOf(events).filter((b) => b.type === "tool_use" && String(b.name).endsWith("file_send") && mine(b.input ?? {})).length;
    const sent = answerOf(events, "file_send", mine);
    if (sent.name !== "data.txt" || sent.size !== 300_000 || Object.keys(sent).sort().join() !== "hash,name,size") throw new Error(`ответ инструмента не тот: ${JSON.stringify(sent)}`);
    const body = Buffer.from(await (await t.fetch((await t.must("files.get", { hash: sent.hash })).url)).arrayBuffer());
    if (body.length !== 300_000 || crypto.createHash("sha256").update(body).digest("hex") !== sent.hash) throw new Error("содержимое в хранилище не сходится с хэшем");
    // содержимого в разговоре нет: кусок из середины файла не встречается ни в одной записи
    const piece = body.subarray(150_000, 150_064).toString();
    if (JSON.stringify(events).includes(piece)) throw new Error("содержимое файла попало в разговор");
    const card = page.locator('.fileshow[data-file$="data.txt"]').last();
    await card.waitFor();
    await card.locator("pre.filetext").waitFor();
    return `файл 300 000 знаков (~75 000 токенов), в контексте сессии ${(await s.row())?.cache?.size ?? "?"} токенов, содержимого в разговоре 0; вызовов file_send: ${calls}`;
  });

  await t.step("сессия поднимает сайт из 3 файлов: открывается по адресу, стили и скрипт по относительным путям, пропуск страницы ему не виден", async () => {
    await s.turn(script(
      tool("Write", { file_path: `${s.cwd}/out/site/index.html`, content: `<!doctype html><meta charset="utf-8"><title>ждёт</title><link rel="stylesheet" href="site.css"><h1>Отчёт ${t.tag}</h1><script src="js/site.js"></script>` }),
      tool("Write", { file_path: `${s.cwd}/out/site/site.css`, content: "h1 { color: rgb(1, 2, 3); }" }),
      tool("Write", { file_path: `${s.cwd}/out/site/js/site.js`, content: `document.title = "loaded-${t.tag}";` }),
      tool("mcp__fleet__site_publish", { to: s.callsign, dir: "out/site", title: "Отчёт" }),
      say("поднято"),
    ));
    const site = answerOf(await s.history(), "site_publish", (i) => String(i.dir).replace(/\\/g, "/").replace(/\/$/, "").endsWith("out/site"));
    if (!/\/s\/[0-9a-f]{32}\/$/.test(site.url) || site.files !== 3 || "sent" in site) throw new Error(`ответ сайта не тот: ${JSON.stringify(site)}`);
    // сайт — во вкладке того же окна, где у страницы лежит пропуск: песочница закрывает его и здесь
    const tab = await page.context().newPage();
    try {
      const res = await tab.goto(site.url);
      if (res.headers()["content-security-policy"] !== "sandbox allow-scripts allow-forms allow-popups") throw new Error("сайт отдан без заголовка песочницы");
      await tab.waitForFunction((tag) => document.title === "loaded-" + tag, t.tag);
      const seen = await tab.evaluate(() => {
        let store;
        try { localStorage.getItem("x"); store = "open"; } catch (e) { store = e.name; }
        return { h1: document.querySelector("h1")?.textContent, color: getComputedStyle(document.querySelector("h1")).color, store, origin: location.origin, self: window.origin };
      });
      if (seen.h1 !== `Отчёт ${t.tag}` || seen.color !== "rgb(1, 2, 3)") throw new Error(`сайт показан не тот: ${JSON.stringify(seen)}`);
      if (seen.store !== "SecurityError" || seen.self !== "null") throw new Error(`сайт не в песочнице: ${JSON.stringify(seen)}`);
    } finally {
      await tab.close();
    }
    await page.locator('.fileshow[data-site] iframe.htmlframe').last().waitFor();
    await page.frameLocator('.fileshow[data-site] iframe.htmlframe').last().locator("h1").waitFor();
    await page.screenshot({ path: path.join(t.shots(), `files-${t.machine}-1280.png`) });
    return site.url;
  });

  await t.step(`телефон: файл ${BIG_MB} МиБ в папку сессии и обратно — хэш сходится`, async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const file = randomFile(path.join(tmp, "big.bin"), BIG_MB);
    const hash = await sha(file);
    const up = await uploadFromPage(file, script(tool("mcp__fleet__file_send", { to: s.callsign, path: "uploads/big.bin", title: "Обратно" }), say("отправлено")));
    if (up.file.hash !== hash) throw new Error("в сообщении не тот хэш");
    await s.ended(up.uuid);
    const back = answerOf(await s.history(), "file_send", (i) => String(i.path).replace(/\\/g, "/").endsWith("uploads/big.bin"));
    if (back.hash !== hash || back.size !== BIG_MB * 1024 * 1024) throw new Error(`сессия отправила не то: ${JSON.stringify(back)}`);
    const card = page.locator('.fileshow[data-file$="big.bin"]').last();
    await card.waitFor();
    const t0 = Date.now();
    const got = await downloadFromPage(card, "big.bin");
    if (got.hash !== hash) throw new Error("скачанное с телефона не сходится с хэшем");
    await page.screenshot({ path: path.join(t.shots(), `files-${t.machine}-390.png`) });
    // сколько заняла сама машина — в её журнале: приём файла в папку и отправка обратно
    const lines = (await journal()).filter((l) => l.hash === hash);
    const ms = (msg) => lines.find((l) => l.msg === msg)?.ms;
    return `туда ${(up.ms / 1000).toFixed(1)} с (из них машина ${((ms("file_upload") ?? 0) / 1000).toFixed(1)} с), обратно: машина ${((ms("file_send") ?? 0) / 1000).toFixed(1)} с, скачивание ${((Date.now() - t0) / 1000).toFixed(1)} с`;
  });

  await t.step("журнал машины: строка на каждую загрузку, отправку и сайт — с хэшем, без содержимого", async () => {
    const count = (lines) => ({ file_upload: lines.filter((l) => l.msg === "file_upload").length, file_send: lines.filter((l) => l.msg === "file_send").length, site_publish: lines.filter((l) => l.msg === "site_publish").length });
    let n = {};
    // строк не меньше, чем действий: три загрузки, две отправки, один сайт
    const lines = await t.wait("строки журнала о каждой загрузке, отправке и сайте", async () => {
      const got = await journal();
      n = count(got);
      return n.file_upload >= 3 && n.file_send >= 2 && n.site_publish >= 1 && got;
    }, () => `строк журнала: ${JSON.stringify(n)}`);
    if (!lines.filter((l) => l.msg === "file_send" || l.msg === "file_upload").every((l) => /^[0-9a-f]{64}$/.test(l.hash) && typeof l.size === "number")) throw new Error("в строке журнала нет хэша или размера");
    return JSON.stringify(n);
  });
});
