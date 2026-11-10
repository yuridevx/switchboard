// Живая проверка Telegram на тестовом флоте v2 двумя тестовыми аккаунтами: node tools/telegram/live.mjs
// Аккаунт 1 — админ флота (его личный чат уже привязан setup.mjs). Аккаунт 2 — сначала посторонний в группе, затем второй человек флота.
// Проверяет: группу с темами (тема на сессию, ответ в теме, отказ постороннему), вопрос сессии кнопками в личном чате, ответ текстом на сообщение бота.
import fs from "node:fs";
import path from "node:path";
import { account, Api, call, dev, note, notes, reporter, sleep, waitMessage } from "./tg.mjs";

const r = reporter();
const c1 = await account(1), c2 = await account(2);
const bot = notes().BOT_NAME;
const word = () => Math.random().toString(36).slice(2, 8);
const owner = (await call("whoami")).result.person;
const TESTER = "~tester@fleet.test";
const must = (a, what) => {
  if (!a.ok) throw new Error(`${what}: ${a.error} ${a.why ?? ""}`);
  return a.result;
};
const reactionOf = async (c, peer, id) => {
  await sleep(4000);
  const [m] = await c.getMessages(peer, { ids: [id] });
  return m?.reactions?.results?.map((x) => x.reaction?.emoticon).join("") ?? "";
};
const rowOf = async (callsign) => must(await call("fleet.list"), "fleet.list").sessions.find((s) => s.callsign === callsign);
const waitRow = async (callsign, test, ms = 90_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const row = await rowOf(callsign);
    if (row && test(row)) return row;
    await sleep(2000);
  }
  throw new Error(`строка ${callsign} не дождалась нужного состояния`);
};

/* ===== Группа с темами ===== */
let group = null, topicId = 0;
const target = "pen@wsl";
await r.step("группа с темами создана, бот — админ", async () => {
  if (notes().GROUP_ID) {
    group = await c1.getEntity(new Api.PeerChannel({ channelId: BigInt(notes().GROUP_ID) }));
    return "уже есть";
  }
  const made = await c1.invoke(new Api.channels.CreateChannel({ title: "Switchboard v2 тест", about: "Живые проверки тестового флота", megagroup: true, forum: true }));
  group = made.chats[0];
  await c1.invoke(new Api.channels.InviteToChannel({ channel: group, users: [bot] }));
  await c1.invoke(new Api.channels.EditAdmin({ channel: group, userId: bot, adminRights: new Api.ChatAdminRights({ manageTopics: true, deleteMessages: true, pinMessages: true, inviteUsers: true, other: true }), rank: "bot" }));
  note("GROUP_ID", String(group.id));
  return "создана";
});

await r.step("группа привязана кодом", async () => {
  const d = must(await call("reach.devices"), "reach.devices").devices.filter((x) => x.kind === "telegram");
  if (d.length >= 2) return "уже привязана";
  const code = must(await call("reach.telegram"), "reach.telegram").code;
  const last = (await c1.getMessages(group, { limit: 1 }))[0]?.id ?? 0;
  await c1.sendMessage(group, { message: code });
  const reply = await waitMessage(c1, group, (m) => !m.out && /Привязано/i.test(m.message ?? ""), { after: last, ms: 25_000 });
  if (!reply) throw new Error("бот не подтвердил привязку группы");
  return (reply.message ?? "").slice(0, 60);
});

await r.step("сообщение о сессии приходит в её тему", async () => {
  const w = "тема-" + word();
  const last = (await c1.getMessages(group, { limit: 1 }))[0]?.id ?? 0;
  const sent = must(await call("reach.send", { to: owner, title: "Проверка темы", text: w, callsign: target, force: true }), "reach.send");
  const got = await waitMessage(c1, group, (m) => !m.out && (m.message ?? "").includes(w), { after: last, ms: 25_000 });
  if (!got) throw new Error(`в группу не пришло; отправлено: ${sent.sent}`);
  topicId = got.replyTo?.replyToTopId ?? got.replyTo?.replyToMsgId ?? 0;
  if (!topicId) throw new Error("сообщение пришло не в тему");
  return `тема ${topicId}, отправлено устройствам: ${sent.sent}`;
});

let invited = null;
await r.step("посторонний в группе: его сообщение отклонено и до сессии не дошло", async () => {
  // после прошлого прогона второй аккаунт — человек флота: на время шага его чат отвязывается, ниже привязывается снова
  if (fs.existsSync(path.join(dev, "v2-test-tester.pass"))) {
    const mine = must(await call("reach.devices", {}, { device: "tester" }), "reach.devices").devices.filter((x) => x.kind === "telegram");
    for (const d of mine) must(await call("reach.remove", { device: d.id }, { device: "tester" }), "reach.remove");
  }
  const link = (await c1.invoke(new Api.messages.ExportChatInvite({ peer: group, expireDate: Math.floor(Date.now() / 1000) + 3600, usageLimit: 5 }))).link;
  const hash = /(?:\+|joinchat\/)([A-Za-z0-9_-]+)$/.exec(link)?.[1] ?? "";
  if (!hash) throw new Error("ссылка-приглашение не того вида");
  try {
    const res = await c2.invoke(new Api.messages.ImportChatInvite({ hash }));
    invited = res.chats[0];
  } catch (e) {
    if (!/USER_ALREADY_PARTICIPANT/.test(e.message)) throw e;
    invited = await c2.getEntity(new Api.PeerChannel({ channelId: group.id }));
  }
  const w = "чужой-" + word();
  const m = await c2.sendMessage(invited, { message: w, replyTo: topicId });
  const reaction = await reactionOf(c2, invited, m.id);
  const hist = must(await call("session.history", { to: target, limit: 10 }), "session.history").events;
  if (JSON.stringify(hist).includes(w)) throw new Error("сообщение постороннего дошло до сессии");
  if (!reaction.includes("👎")) throw new Error(`реакции отказа нет (реакция: «${reaction}»)`);
  return "реакция 👎";
});

await r.step("ответ привязанного человека в теме доходит сессии", async () => {
  const w = "изгруппы" + word();
  const m = await c1.sendMessage(group, { message: `Ответь одним словом: ${w}`, replyTo: topicId });
  const reaction = await reactionOf(c1, group, m.id);
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const hist = must(await call("session.history", { to: target, limit: 12 }), "session.history").events;
    if (JSON.stringify(hist).includes(w)) return `дошло, реакция «${reaction}»`;
    await sleep(2500);
  }
  throw new Error(`до сессии не дошло (реакция «${reaction}»)`);
});

/* ===== Второй человек флота: вопрос кнопками и ответ текстом в личном чате ===== */
const passFile = path.join(dev, "v2-test-tester.pass");
const asTester = { device: "tester" };
await r.step("второй человек флота: приглашён, в общем проекте, чат привязан", async () => {
  if (!fs.existsSync(passFile)) {
    const inv = must(await call("invite", { addr: "cli" + TESTER }), "invite");
    const red = must(await call("redeem", { invite: inv.invite }), "redeem");
    fs.writeFileSync(passFile, red.key + "\n", { mode: 0o600 });
  }
  must(await call("project.set", { project: "tg", name: "Telegram", members: [owner, TESTER] }), "project.set");
  const have = must(await call("reach.devices", {}, asTester), "reach.devices").devices.some((x) => x.kind === "telegram");
  if (!have) {
    const code = must(await call("reach.telegram", {}, asTester), "reach.telegram").code;
    const last = (await c2.getMessages(bot, { limit: 1 }))[0]?.id ?? 0;
    await c2.sendMessage(bot, { message: "/start " + code });
    const reply = await waitMessage(c2, bot, (m) => !m.out, { after: last, ms: 25_000 });
    if (!reply || !/Привязано/i.test(reply.message ?? "")) throw new Error("бот не подтвердил привязку: " + (reply?.message ?? "нет ответа"));
  }
  const me = must(await call("whoami", {}, asTester), "whoami");
  if (!me.machines.includes("wsl")) throw new Error("второй человек не достаёт до машины wsl: " + me.machines.join(","));
  return `достаёт до машин: ${me.machines.join(", ")}`;
});

const name = "tgask" + word();
const callsign = name + "@wsl";
let askMsg = null;
await r.step("вопрос сессии приходит в личный чат кнопками", async () => {
  const last = (await c2.getMessages(bot, { limit: 1 }))[0]?.id ?? 0;
  must(await call("session.open", { to: "@wsl", spec: { name, cwd: "/tmp", account: "deepseek", mode: "ask" }, prompt: `Создай файл /tmp/${name}.txt со словом ok. Больше ничего не делай.` }, asTester), "session.open");
  await waitRow(callsign, (s) => s.state === "waiting" && s.ask);
  askMsg = await waitMessage(c2, bot, (m) => !m.out && m.replyMarkup?.rows?.length, { after: last, ms: 40_000 });
  if (!askMsg) throw new Error("сообщения с кнопками нет");
  return "кнопки: " + askMsg.replyMarkup.rows.map((row) => row.buttons[0].text).join(" / ");
});

await r.step("нажатие кнопки отвечает на вопрос, ход продолжается", async () => {
  const button = askMsg.replyMarkup.rows[0].buttons[0];
  await c2.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: askMsg.id, data: button.data })).catch((e) => {
    if (!/BOT_RESPONSE_TIMEOUT/.test(e.message)) throw e;
  });
  const row = await waitRow(callsign, (s) => !s.ask && (s.state === "idle" || s.state === "busy"), 60_000);
  await waitRow(callsign, (s) => s.state === "idle", 90_000);
  const check = must(await call("shell.run", { to: "@wsl", script: `cat /tmp/${name}.txt`, wait: 20 }), "shell.run");
  if (!/ok/.test(check.stdout ?? check.out ?? "")) throw new Error("файл не создан: " + JSON.stringify(check).slice(0, 120));
  return `ответ «${button.text}», состояние ${row.state}, файл создан`;
});

await r.step("итог хода приходит в чат; ответ текстом на него доходит сессии", async () => {
  const done = await waitMessage(c2, bot, (m) => !m.out && (m.message ?? "").includes(callsign) && m.id > askMsg.id, { after: askMsg.id, ms: 40_000 });
  if (!done) throw new Error("сообщения об итоге хода нет");
  const w = "изчата" + word();
  await c2.sendMessage(bot, { message: `Ответь одним словом: ${w}`, replyTo: done.id });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const hist = must(await call("session.history", { to: callsign, limit: 12 }, asTester), "session.history").events;
    if (JSON.stringify(hist).includes(w)) return "дошло";
    await sleep(2500);
  }
  throw new Error("ответ из чата до сессии не дошёл");
});

await call("session.remove", { to: callsign }, asTester);
await c1.disconnect();
await c2.disconnect();
console.log(r.bad ? `сбоев: ${r.bad} из ${r.total}` : `Telegram: ${r.total} из ${r.total}`);
process.exit(r.bad ? 1 : 0);
