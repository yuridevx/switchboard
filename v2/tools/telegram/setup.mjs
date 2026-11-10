// Бот тестового флота v2: создать в @BotFather первым тестовым аккаунтом (если ещё нет), подключить к флоту, привязать личный чат.
// node tools/telegram/setup.mjs
import { account, call, note, notes, reporter, sleep, waitMessage } from "./tg.mjs";

const r = reporter();
const c = await account(1);
const TOKEN = /\b(\d{6,}:[A-Za-z0-9_-]{30,})\b/;

await r.step("бот тестового флота создан в BotFather", async () => {
  if (notes().BOT_TOKEN) return "уже есть: @" + notes().BOT_NAME;
  const father = "BotFather";
  const say = async (text) => {
    const last = (await c.getMessages(father, { limit: 1 }))[0]?.id ?? 0;
    await c.sendMessage(father, { message: text });
    const reply = await waitMessage(c, father, (m) => !m.out, { after: last, ms: 20_000 });
    if (!reply) throw new Error("BotFather не ответил на «" + text.slice(0, 20) + "»");
    return reply.message ?? "";
  };
  await say("/cancel");
  await say("/newbot");
  await say("Switchboard v2 тест");
  const name = "sb2t_" + Math.random().toString(36).slice(2, 8) + "_bot";
  const done = await say(name);
  const token = TOKEN.exec(done)?.[1];
  if (!token) throw new Error("в ответе BotFather нет токена: " + done.slice(0, 80));
  note("BOT_TOKEN", token);
  note("BOT_NAME", name);
  return "@" + name;
});

await r.step("бот подключён к флоту test, вебхук поставлен", async () => {
  const a = await call("reach.bot", { token: notes().BOT_TOKEN });
  if (!a.ok) throw new Error(a.error + " " + (a.why ?? ""));
  return JSON.stringify(a.result).slice(0, 120);
});

await r.step("личный чат привязан кодом", async () => {
  const code = await call("reach.telegram", {});
  if (!code.ok) throw new Error(code.error + " " + (code.why ?? ""));
  const bot = notes().BOT_NAME;
  const last = (await c.getMessages(bot, { limit: 1 }))[0]?.id ?? 0;
  await c.sendMessage(bot, { message: "/start " + code.result.code });
  const reply = await waitMessage(c, bot, (m) => !m.out, { after: last, ms: 25_000 });
  if (!reply) throw new Error("бот не ответил на код привязки");
  return "бот ответил: " + (reply.message ?? "").slice(0, 80);
});

await r.step("чат записан устройством человека", async () => {
  const d = await call("reach.devices", {});
  const tg = (d.result?.devices ?? []).filter((x) => x.kind === "telegram");
  if (!tg.length) throw new Error("устройств Telegram нет");
  return `устройств Telegram: ${tg.length}`;
});

await r.step("сообщение человеку доходит в чат", async () => {
  const bot = notes().BOT_NAME;
  const last = (await c.getMessages(bot, { limit: 1 }))[0]?.id ?? 0;
  const word = "проба-" + Math.random().toString(36).slice(2, 7);
  const me = await call("whoami", {});
  const sent = await call("reach.send", { to: me.result.person, title: "Проверка Telegram", text: word, force: true });
  if (!sent.ok || !sent.result.sent) throw new Error("reach.send: " + JSON.stringify(sent.result ?? sent.error));
  const got = await waitMessage(c, bot, (m) => !m.out && (m.message ?? "").includes(word), { after: last, ms: 25_000 });
  if (!got) throw new Error("сообщение в чат не пришло");
  return "пришло: " + (got.message ?? "").replace(/\n/g, " ").slice(0, 80);
});

await c.disconnect();
await sleep(200);
console.log(r.bad ? `сбоев: ${r.bad}` : `Telegram подключён: ${r.total} из ${r.total}`);
process.exit(r.bad ? 1 : 0);
