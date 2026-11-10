// Общие приёмы живых проверок Telegram: клиент тестового аккаунта, запрос флоту, файл настроек проверки.
// Аккаунты пишут только @BotFather, боту тестового флота и тестовой группе; чужие чаты не читаются.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const dev = path.join(os.homedir(), ".switchboard-dev");
const tg = createRequire(path.join(dev, "tg", "package.json"));
export const { TelegramClient, Api } = tg("telegram");
const { StringSession } = tg("telegram/sessions");

const readEnv = (file) => (fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])) : {});
const app = readEnv(path.join(dev, "telegram.env"));
export const fleetEnv = readEnv(path.join(dev, "v2-fleet.env"));

const NOTES = path.join(dev, "v2-telegram.env");
/** Настройки проверки: токен бота, имя бота, группа. */
export const notes = () => readEnv(NOTES);
export function note(key, value) {
  const all = { ...notes(), [key]: value };
  fs.writeFileSync(NOTES, "# Проверки Telegram на тестовом флоте v2 (вне репо)\n" + Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

/** Клиент тестового аккаунта 1 или 2. */
export async function account(n) {
  const c = new TelegramClient(new StringSession(fs.readFileSync(path.join(dev, `v2-tg-${n}.session`), "utf8").trim()), Number(app.TELEGRAM_API_ID), app.TELEGRAM_API_HASH, { connectionRetries: 3 });
  c.setLogLevel("none");
  await c.connect();
  if (!(await c.checkAuthorization())) throw new Error(`аккаунт ${n}: сессия не принята — нужен вход заново (tools/telegram/login-qr.mjs)`);
  return c;
}

/** Запрос флоту пропуском из файла. */
export async function call(type, fields = {}, { fleet = "test", device = "cli" } = {}) {
  const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
  const id = "tg" + Math.random().toString(36).slice(2, 10);
  const res = await fetch(fleetEnv.SB2_BASE + "/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ ...fields, type, id }), signal: AbortSignal.timeout(130_000) });
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждать сообщение в чате, подходящее под условие; новее отметки. */
export async function waitMessage(c, peer, test, { after = 0, ms = 30_000, replyTo } = {}) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const list = await c.getMessages(peer, { limit: 15, ...(replyTo ? { replyTo } : {}) });
    const hit = list.find((m) => m.id > after && test(m));
    if (hit) return hit;
    await sleep(1500);
  }
  return null;
}

export function reporter() {
  const lines = [];
  let bad = 0;
  return {
    async step(label, fn) {
      const t0 = Date.now();
      try {
        const note = await fn();
        lines.push(`✓ ${label}${note ? " · " + note : ""} · ${Date.now() - t0} мс`);
        console.log(lines.at(-1));
        return true;
      } catch (e) {
        bad++;
        lines.push(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
        console.log(lines.at(-1));
        return false;
      }
    },
    get bad() {
      return bad;
    },
    get total() {
      return lines.length;
    },
  };
}
