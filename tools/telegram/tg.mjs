// Клиент Telegram живых проверок: тестовый аккаунт, чтение его чатов, файл настроек проверки.
// Шаг, ожидание, запрос флоту и уборка — у обвязки проверок (tools/fleet/harness.mjs).
// Аккаунты пишут только @BotFather, боту тестового флота и тестовой группе; чужие чаты не читаются.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { dev, fleetEnv, readEnv } from "../dev.mjs";
export { dev, fleetEnv };
const tg = createRequire(path.join(dev, "tg", "package.json"));
export const { TelegramClient, Api } = tg("telegram");
const { StringSession } = tg("telegram/sessions");

const app = readEnv(path.join(dev, "telegram.env"));

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

/** Сообщение чата, подходящее под условие и новее отметки after, — одним чтением; нет такого — undefined.
 *  Ждёт его проверка: t.wait("…", () => newer(c, peer, test, { after })). */
export async function newer(c, peer, test, { after = 0, replyTo } = {}) {
  const list = await c.getMessages(peer, { limit: 15, ...(replyTo ? { replyTo } : {}) });
  return list.find((m) => m.id > after && test(m));
}

/** Номер последнего сообщения чата: отметка «после этого». */
export const lastId = async (c, peer) => (await c.getMessages(peer, { limit: 1 }))[0]?.id ?? 0;

/** Реакции на сообщение — одним чтением, строкой значков. */
export async function reactions(c, peer, id) {
  const [m] = await c.getMessages(peer, { ids: [id] });
  return m?.reactions?.results?.map((x) => x.reaction?.emoticon).join("") ?? "";
}
