// Вход двух тестовых аккаунтов Telegram по QR: node tools/telegram/login-qr.mjs [порт]
// Поднимает локальную страницу с двумя QR-кодами. Человек сканирует их в Telegram (Настройки → Устройства → Подключить устройство);
// пароль двухэтапной проверки, если он есть, вводит на той же странице — он идёт только в этот процесс и нигде не сохраняется.
// Сессии пишутся в ~/.switchboard-dev/v2-tg-1.session и v2-tg-2.session. Ключи приложения — из ~/.switchboard-dev/telegram.env.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dev = path.join(os.homedir(), ".switchboard-dev");
const tg = createRequire(path.join(dev, "tg", "package.json"));
const { TelegramClient } = tg("telegram");
const { StringSession } = tg("telegram/sessions");
const qrcode = createRequire(path.join(root, "package.json"))("qrcode-generator");

const env = Object.fromEntries(fs.readFileSync(path.join(dev, "telegram.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const apiId = Number(env.TELEGRAM_API_ID), apiHash = env.TELEGRAM_API_HASH;
const port = Number(process.argv[2] ?? 4850);

const accounts = [1, 2].map((n) => ({ n, file: path.join(dev, `v2-tg-${n}.session`), state: "starting", url: "", who: "", error: "", give: null }));

function svg(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

async function login(a) {
  if (fs.existsSync(a.file)) {
    const c = new TelegramClient(new StringSession(fs.readFileSync(a.file, "utf8").trim()), apiId, apiHash, { connectionRetries: 3 });
    c.setLogLevel("none");
    try {
      await c.connect();
      if (await c.checkAuthorization()) {
        const me = await c.getMe();
        a.state = "done";
        a.who = me.firstName ?? "вошёл";
        await c.disconnect();
        return;
      }
    } catch {}
    await c.disconnect().catch(() => {});
  }
  const c = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  c.setLogLevel("none");
  await c.connect();
  try {
    await c.signInUserWithQrCode({ apiId, apiHash }, {
      qrCode: async ({ token }) => {
        a.url = "tg://login?token=" + Buffer.from(token).toString("base64url");
        a.state = "qr";
      },
      password: async () => {
        a.state = "password";
        return new Promise((res) => (a.give = res));
      },
      onError: async (e) => {
        a.error = e.message;
        return true;
      },
    });
    fs.writeFileSync(a.file, c.session.save() + "\n", { mode: 0o600 });
    const me = await c.getMe();
    a.who = me.firstName ?? "вошёл";
    a.state = "done";
  } catch (e) {
    a.state = "failed";
    a.error = e.message;
  }
  await c.disconnect().catch(() => {});
}

const page = `<!doctype html><meta charset="utf-8"><title>Вход Telegram для проверок v2</title>
<style>body{font:15px system-ui;margin:32px;background:#f2f4f8;color:#131a25}h1{font-size:20px}.row{display:flex;gap:24px;flex-wrap:wrap}
.card{background:#fff;border:1px solid #d2d9e3;border-radius:12px;padding:20px;width:320px}.qr{width:280px;height:280px}.qr svg{width:100%;height:100%}
.ok{color:#1c7548;font-weight:600}.bad{color:#b0222e}input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box;margin:8px 0}button{font:inherit;padding:6px 12px}</style>
<h1>Вход Telegram для проверок v2</h1>
<p>Telegram на телефоне → Настройки → Устройства → Подключить устройство → навести на код.</p>
<div class="row" id="row"></div>
<script>
async function tick(){
  const s = await (await fetch("/state")).json();
  const row = document.getElementById("row");
  for (const a of s) {
    let el = document.getElementById("a"+a.n);
    if (!el) { el = document.createElement("div"); el.className = "card"; el.id = "a"+a.n; row.appendChild(el); }
    const key = a.state + a.qr.length + a.error;
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    let body = "";
    if (a.state === "qr") body = '<div class="qr">'+a.qr+'</div>';
    else if (a.state === "password") body = '<p>Нужен пароль двухэтапной проверки.</p><form onsubmit="send(event,'+a.n+')"><input type="password" id="p'+a.n+'" autocomplete="off"><button>Войти</button></form>';
    else if (a.state === "done") body = '<p class="ok">Вошёл: '+a.who+'</p>';
    else if (a.state === "failed") body = '<p class="bad">Не вышло: '+a.error+'</p>';
    else body = "<p>Готовлю код…</p>";
    el.innerHTML = "<h2>Аккаунт "+a.n+"</h2>"+body;
  }
}
async function send(e, n){ e.preventDefault(); const v = document.getElementById("p"+n).value; await fetch("/password/"+n, {method:"POST", body:v}); }
setInterval(tick, 1500); tick();
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === "/state") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(accounts.map((a) => ({ n: a.n, state: a.state, who: a.who, error: a.error, qr: a.state === "qr" && a.url ? svg(a.url) : "" }))));
  }
  const m = /^\/password\/([12])$/.exec(req.url ?? "");
  if (m && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const a = accounts[Number(m[1]) - 1];
      a.give?.(body);
      a.give = null;
      a.state = "starting";
      res.end("ok");
    });
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(page);
});
server.listen(port, "127.0.0.1", () => console.log(`страница входа: http://localhost:${port}`));

await Promise.all(accounts.map(login));
for (const a of accounts) console.log(`аккаунт ${a.n}: ${a.state}${a.state === "done" ? "" : " " + a.error}`);
// страница ещё минуту показывает итог, затем сервер закрывается
setTimeout(() => (server.close(), process.exit(accounts.every((a) => a.state === "done") ? 0 : 1)), 60_000);
