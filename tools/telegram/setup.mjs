// Бот тестового флота v2: создать в @BotFather первым тестовым аккаунтом (если ещё нет), подключить к флоту, привязать личный чат.
// node tools/telegram/setup.mjs [флот] [устройство]
// Запускается руками и один: подключает бота всему флоту — дорожку «одна» называет себе сам, в списке проверок его нет.
import { ALONE, check } from "../fleet/harness.mjs";
import { account, lastId, newer, note, notes } from "./tg.mjs";

const TOKEN = /\b(\d{6,}:[A-Za-z0-9_-]{30,})\b/;

await check(async (t) => {
  const c = await account(1);
  t.defer("клиент Telegram", () => c.disconnect());
  /** Написать в чат и дождаться ответа на это сообщение. */
  const ask = async (peer, text, what, test = () => true) => {
    const last = await lastId(c, peer);
    await c.sendMessage(peer, { message: text });
    return t.wait(what, () => newer(c, peer, (m) => !m.out && test(m), { after: last }));
  };

  await t.step("бот тестового флота создан в BotFather", async () => {
    if (notes().BOT_TOKEN) return "уже есть: @" + notes().BOT_NAME;
    const say = async (text) => (await ask("BotFather", text, `ответ BotFather на «${text.slice(0, 20)}»`)).message ?? "";
    await say("/cancel");
    await say("/newbot");
    await say("Switchboard v2 тест");
    const name = "sb2t_" + t.tag + "_bot";
    const done = await say(name);
    const token = TOKEN.exec(done)?.[1];
    if (!token) throw new Error("в ответе BotFather нет токена: " + done.slice(0, 80));
    note("BOT_TOKEN", token);
    note("BOT_NAME", name);
    return "@" + name;
  });

  await t.step(`бот подключён к флоту ${t.fleet}, вебхук поставлен`, async () => JSON.stringify(await t.must("reach.bot", { token: notes().BOT_TOKEN })).slice(0, 120));

  await t.step("личный чат привязан кодом", async () => {
    const { code } = await t.must("reach.telegram", {});
    const reply = await ask(notes().BOT_NAME, "/start " + code, "ответ бота на код привязки");
    return "бот ответил: " + (reply.message ?? "").slice(0, 80);
  });

  await t.step("чат записан устройством человека", async () => {
    // запись появляется вместе с ответом бота; ждём её, а не читаем один раз
    const tg = await t.wait("устройство Telegram у человека", async () => {
      const list = (await t.must("reach.devices", {})).devices.filter((x) => x.kind === "telegram");
      return list.length && list;
    });
    return `устройств Telegram: ${tg.length}`;
  });

  await t.step("сообщение человеку доходит в чат", async () => {
    const bot = notes().BOT_NAME;
    const last = await lastId(c, bot);
    const word = "проба-" + t.tag;
    const me = await t.must("whoami", {});
    const sent = await t.must("reach.send", { to: me.person, title: "Проверка Telegram", text: word, force: true });
    if (!sent.sent) throw new Error("reach.send: " + JSON.stringify(sent));
    const got = await t.wait("сообщение в чате", () => newer(c, bot, (m) => !m.out && (m.message ?? "").includes(word), { after: last }));
    return "пришло: " + (got.message ?? "").replace(/\n/g, " ").slice(0, 80);
  });
}, { title: "Telegram: бот флота", slug: "tgsetup", away: true, lane: ALONE });
