// Живая проверка Telegram на тестовом флоте v2 двумя тестовыми аккаунтами: node tools/telegram/live.mjs [флот] [устройство] [машина]
// Аккаунт 1 — админ флота (его личный чат уже привязан setup.mjs). Аккаунт 2 — сначала посторонний в группе, затем второй человек флота.
// Проверяет: группу с темами (тема на сессию, ответ в теме, отказ постороннему), вопрос сессии кнопками в личном чате, ответ текстом на сообщение бота.
// Запускается руками и одна: меняет состав проекта флота — дорожку «одна» называет себе сама, в списке проверок её нет.
// Человек проверки не на связи страницей (away): иначе вопросы и итоги в чат не уходят.
import fs from "node:fs";
import path from "node:path";
import { httpTransport } from "@sb/protocol";
import { ALONE, check, Refused } from "../fleet/harness.mjs";
import { account, Api, dev, lastId, newer, note, notes, reactions } from "./tg.mjs";

const TESTER = "~tester@fleet.test";

await check(async (t) => {
  const c1 = await account(1), c2 = await account(2);
  t.defer("клиенты Telegram", async () => (await c1.disconnect(), await c2.disconnect()));
  const bot = notes().BOT_NAME;
  let n = 0;
  /** Слово шага: своё у каждого прогона и каждого шага. */
  const word = () => t.tag + ++n;
  const owner = (await t.must("whoami", {})).person;
  const passFile = path.join(dev, `v2-${t.fleet}-tester.pass`);
  /** Запрос флоту от второго человека — его пропуском, тем же входом; предел — бюджет проверки. */
  const tester = async (type, fields = {}) => {
    const key = fs.readFileSync(passFile, "utf8").trim();
    const res = await t.fetch(t.base + "/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ ...fields, type, id: `tg${t.tag}${++n}` }) });
    const r = await res.json();
    if (!r.ok) throw new Refused(type, r.error, r.why);
    return r.result;
  };
  // модель сессий второго человека — SB2_MODEL или первая из каталога провайдера
  const SEAT = { key: process.env.SB2_KEY ?? "muse" };
  SEAT.model = process.env.SB2_MODEL ?? (await t.must("keys.models", { name: SEAT.key })).models[0].id;
  // своя сессия, о которой пишут в группу: у неё своя тема
  const pen = await t.session({ name: "tgtopic" });

  /* ===== Группа с темами ===== */
  let group = null, topicId = 0;
  await t.step("группа с темами создана, бот — админ", async () => {
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

  await t.step("группа привязана кодом", async () => {
    const d = (await t.must("reach.devices", {})).devices.filter((x) => x.kind === "telegram");
    if (d.length >= 2) return "уже привязана";
    const { code } = await t.must("reach.telegram", {});
    const last = await lastId(c1, group);
    await c1.sendMessage(group, { message: code });
    const reply = await t.wait("подтверждение привязки группы от бота", () => newer(c1, group, (m) => !m.out && /Привязано/i.test(m.message ?? ""), { after: last }));
    return (reply.message ?? "").slice(0, 60);
  });

  await t.step("сообщение о сессии приходит в её тему", async () => {
    const w = "тема-" + word();
    const last = await lastId(c1, group);
    const sent = await t.must("reach.send", { to: owner, title: "Проверка темы", text: w, callsign: pen.callsign, force: true });
    const got = await t.wait(`сообщение «${w}» в группе`, () => newer(c1, group, (m) => !m.out && (m.message ?? "").includes(w), { after: last }), () => `в группе его нет; отправлено устройствам: ${sent.sent}`);
    topicId = got.replyTo?.replyToTopId ?? got.replyTo?.replyToMsgId ?? 0;
    if (!topicId) throw new Error("сообщение пришло не в тему");
    return `тема ${topicId}, отправлено устройствам: ${sent.sent}`;
  });

  let invited = null;
  await t.step("посторонний в группе: его сообщение отклонено и до сессии не дошло", async () => {
    // после прошлого прогона второй аккаунт — человек флота: на время шага его чат отвязывается, ниже привязывается снова
    if (fs.existsSync(passFile)) {
      const mine = (await tester("reach.devices")).devices.filter((x) => x.kind === "telegram");
      for (const d of mine) await tester("reach.remove", { device: d.id });
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
    let seen = "";
    // реакция отказа — слово самого бота: сообщение разобрано и отклонено. Она и есть барьер: после неё до сессии уже ничего не пойдёт
    await t.wait("реакция отказа 👎 на сообщение постороннего", async () => (seen = await reactions(c2, invited, m.id)).includes("👎"), () => `реакция: «${seen}»`);
    if (JSON.stringify(await pen.history()).includes(w)) throw new Error("сообщение постороннего дошло до сессии");
    return "реакция 👎";
  });

  await t.step("ответ привязанного человека в теме доходит сессии", async () => {
    const w = "изгруппы" + word();
    const m = await c1.sendMessage(group, { message: `Ответь одним словом: ${w}`, replyTo: topicId });
    await t.wait(`слово «${w}» из группы в разговоре сессии`, async () => JSON.stringify(await pen.history()).includes(w));
    return `дошло, реакция «${await reactions(c1, group, m.id)}»`;
  });

  /* ===== Второй человек флота: вопрос кнопками и ответ текстом в личном чате ===== */
  await t.step("второй человек флота: приглашён, в общем проекте, чат привязан", async () => {
    if (!fs.existsSync(passFile)) {
      const inv = await t.must("invite", { addr: "cli" + TESTER });
      const red = await t.must("redeem", { invite: inv.invite });
      fs.writeFileSync(passFile, red.key + "\n", { mode: 0o600 });
    }
    await t.must("project.set", { project: "tg", name: "Telegram", members: [owner, TESTER] });
    const have = (await tester("reach.devices")).devices.some((x) => x.kind === "telegram");
    if (!have) {
      const { code } = await tester("reach.telegram");
      const last = await lastId(c2, bot);
      await c2.sendMessage(bot, { message: "/start " + code });
      const reply = await t.wait("ответ бота на код привязки", () => newer(c2, bot, (m) => !m.out, { after: last }));
      if (!/Привязано/i.test(reply.message ?? "")) throw new Error("бот не подтвердил привязку: " + (reply.message ?? ""));
    }
    const me = await tester("whoami");
    if (!me.machines.includes(t.machine)) throw new Error(`второй человек не достаёт до машины ${t.machine}: ${me.machines.join(",")}`);
    return `достаёт до машин: ${me.machines.join(", ")}`;
  });

  /** Сессия второго человека в режиме «спрашивать»: задачу дал он — вопрос о разрешении идёт ему. Сессия — своя: уборка обвязки. */
  const asking = async (name) => {
    const full = name + t.tag;
    const { callsign } = await tester("session.open", { to: "@" + t.machine, spec: { name: full, cwd: "/tmp", ...SEAT, mode: "ask" }, prompt: `Создай файл /tmp/${full}.txt со словом ok. Больше ничего не делай.` });
    const s = t.own(callsign, "/tmp");
    const row = await t.wait(`вопрос у ${callsign}`, async () => {
      const x = await s.row();
      return x?.state === "waiting" && x.ask && x;
    });
    return { s, ask: row.ask, file: full + ".txt" };
  };
  /** Сообщение бота с кнопками в личном чате второго человека, новее отметки. */
  const buttons = (after) => t.wait("сообщение бота с кнопками", () => newer(c2, bot, (m) => !m.out && m.replyMarkup?.rows?.length, { after }));

  let first, askMsg = null;
  await t.step("вопрос сессии приходит в личный чат кнопками", async () => {
    const last = await lastId(c2, bot);
    first = await asking("tgask");
    askMsg = await buttons(last);
    return "кнопки: " + askMsg.replyMarkup.rows.map((row) => row.buttons[0].text).join(" / ");
  });

  await t.step("нажатие кнопки отвечает на вопрос, ход продолжается", async () => {
    const button = askMsg.replyMarkup.rows[0].buttons[0];
    await c2.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: askMsg.id, data: button.data })).catch((e) => {
      if (!/BOT_RESPONSE_TIMEOUT/.test(e.message)) throw e;
    });
    // ход, стоявший на вопросе, дошёл до итога — и только тогда читается файл
    await first.s.ended();
    if (!/ok/.test(await first.s.file(first.file))) throw new Error("файл не создан");
    return `ответ «${button.text}», файл создан`;
  });

  await t.step("итог хода приходит в чат; ответ текстом на него доходит сессии", async () => {
    const done = await t.wait("сообщение бота об итоге хода", () => newer(c2, bot, (m) => !m.out && (m.message ?? "").includes(first.s.callsign), { after: askMsg.id }));
    const w = "изчата" + word();
    await c2.sendMessage(bot, { message: `Ответь одним словом: ${w}`, replyTo: done.id });
    await t.wait(`слово «${w}» из чата в разговоре сессии`, async () => JSON.stringify(await first.s.history()).includes(w));
    return "дошло";
  });

  await t.step("на вопрос уже ответили со страницы — кнопка в чате говорит это, ход идёт с первым ответом", async () => {
    const last = await lastId(c2, bot);
    const won = await asking("tgwon");
    const msg = await buttons(last);
    // первый ответ — как со страницы: запросом answer от устройства человека
    await tester("answer", { to: won.s.callsign, ask: won.ask.id, answer: { action: "allow" } });
    const said = await c2.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: msg.id, data: msg.replyMarkup.rows.at(-1).buttons[0].data }));
    if (!/уже ответили/.test(said.message ?? "")) throw new Error("ответ кнопки: " + JSON.stringify(said.message));
    await won.s.ended();
    if (!/ok/.test(await won.s.file(won.file))) throw new Error("ход не пошёл с первым ответом: файла нет");
    return `кнопка «${msg.replyMarkup.rows.at(-1).buttons[0].text}» → «${said.message}», файл создан`;
  });

  await t.step("страница человека открыта — вопрос в чат не уходит", async () => {
    const key = fs.readFileSync(passFile, "utf8").trim();
    let accepted = false;
    // соединение страницы второго человека: флот принял его, когда прислал снимок картины, — с этого кадра человек на связи
    const link = httpTransport({ base: t.base, key }).open("page", { onFrame: (f) => f.type === "roster" && (accepted = true) });
    let last;
    try {
      await t.wait("флот принял соединение страницы второго человека", () => accepted);
      last = await lastId(c2, bot);
      const paged = await asking("tgpage");
      await tester("answer", { to: paged.s.callsign, ask: paged.ask.id, answer: { action: "deny" } });
    } finally {
      link.close();
    }
    // барьер вместо паузы: следом человеку идёт сообщение, которое доходит всегда (force), — тот же бот, тот же чат.
    // Служба отвечает на запрос после отправки, а вопрос, уйди он в чат, был бы отправлен раньше: он стоял бы между отметкой и барьером
    const w = "барьер-" + word();
    await t.must("reach.send", { to: TESTER, title: "Проверка", text: w, force: true });
    const mark = await t.wait(`сообщение «${w}» в чате`, () => newer(c2, bot, (m) => !m.out && (m.message ?? "").includes(w), { after: last }));
    const between = (await c2.getMessages(bot, { limit: 15 })).filter((m) => !m.out && m.id > last && m.id < mark.id && m.replyMarkup?.rows?.length);
    if (between.length) throw new Error("вопрос ушёл в чат при открытой странице");
    return "до сообщения-барьера сообщений с кнопками в чате нет";
  });
}, { title: "Telegram", slug: "tg", away: true, lane: ALONE, machine: process.argv[4] ?? "wsl" });
