// Живая проверка «переписка с человеком»: node tools/fleet/live-rooms.mjs [флот] [устройство] [машина]
// Личный чат человека с ботом флота: чат привязывается кодом; вопрос сессии приходит кнопками; нажатие отвечает и ход продолжается;
// итог хода приходит в чат; ответ текстом на него уходит сессии. Человека играет двойник Telegram коробки (SB2_TG_HUMAN — его адрес).
// Идёт одна: бот — общий для флота. Человек проверки не должен быть на связи страницей — иначе вопрос в чат не уходит:
// список запускает её с SB2_AWAY=1 — обвязка не открывает соединение картины и читает строки запросом.
// Группа с темами, посторонний и второй человек — в ручной проверке с живыми аккаунтами: tools/telegram/live.mjs.
import { check } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

await check(async (t) => {
  const HUMAN = process.env.SB2_TG_HUMAN;
  if (!HUMAN) throw new Error("нужен SB2_TG_HUMAN — адрес двойника Telegram: его ставит флот в коробке");
  /** Личный чат: номер чата — номер человека, положительный; свой у каждого прогона — от метки проверки. */
  const CHAT = 700_000 + (parseInt(t.tag, 16) % 99_999);
  const human = async (path, body) => {
    const r = await t.fetch(HUMAN + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json();
    if (!r.ok) throw new Error(`двойник Telegram: ${j.error ?? r.status}`);
    return j;
  };
  /** Сколько вызовов бот уже сделал: отметка «после этого». */
  const mark = async () => (await human("/human/calls")).calls.length;
  /** Что бот сделал в чате проверки после n-го вызова. */
  const botDid = async (after = 0) => (await human("/human/calls")).calls.filter((c) => c.n > after && (c.body.chat_id === CHAT || c.method === "answerCallbackQuery"));

  await t.step("чат привязан кодом: бот подтвердил, чат — устройство человека", async () => {
    const { code, bot } = await t.must("reach.telegram", {});
    // привязанный чат — устройство человека на флоте: убрать при любом исходе
    t.defer(`чат tg${CHAT}`, (go) => go("reach.remove", { device: `tg${CHAT}` }));
    await human("/human/message", { chat: CHAT, from: CHAT, text: `/start ${code}` });
    const said = await t.wait("ответ бота «Привязано»", async () => (await botDid()).find((c) => c.method === "sendMessage" && String(c.body.text).startsWith("Привязано")));
    await t.wait("чат среди устройств человека", async () => (await t.must("reach.devices", {})).devices.some((d) => d.id === `tg${CHAT}`));
    return `@${bot}: ${said.body.text}`;
  });

  let s, asked, uuid;
  await t.step("вопрос сессии приходит в чат кнопками", async () => {
    s = await t.session({ name: "tg" });
    const before = await mark();
    // ход встаёт на вопросе: его итог придёт после ответа человека — здесь ждём не итог, а сообщение бота
    uuid = await s.send(turn(tool("AskUserQuestion", { questions: [{ question: "Какой цвет?", header: "Цвет", multiSelect: false, options: [{ label: "Красный", description: "красный цвет" }, { label: "Синий", description: "синий цвет" }] }] }), say("выбрано: {итог 1}")));
    asked = await t.wait("сообщение бота с кнопками", async () => (await botDid(before)).find((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.length));
    const labels = asked.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    if (labels.join() !== "Красный,Синий") throw new Error("кнопки: " + labels.join());
    return `${s.callsign}: «${String(asked.body.text).split("\n")[0]}», кнопки ${labels.join(" · ")}`;
  });

  await t.step("нажатие кнопки отвечает на вопрос: ход продолжается, кнопки сняты", async () => {
    const before = await mark();
    await human("/human/press", { chat: CHAT, from: CHAT, message: asked.message, label: "Синий" });
    // итог именно того хода, который стоял на вопросе
    const reply = await s.ended(uuid);
    if (!reply.text.includes("Синий")) throw new Error(`ход кончился без выбранного варианта: ${reply.text.slice(0, 80)}`);
    let did = [];
    await t.wait("бот подтвердил нажатие и снял кнопки", async () => {
      did = (await botDid(before)).map((c) => c.method);
      return did.includes("answerCallbackQuery") && did.includes("editMessageReplyMarkup");
    }, () => `бот сделал: ${did.join(", ") || "ничего"}`);
    return `итог хода: ${reply.text.slice(0, 40)}`;
  });

  await t.step("итог хода приходит в чат; ответ текстом на него уходит сессии", async () => {
    const done = await t.wait("сообщение бота об итоге", async () => (await botDid()).find((c) => c.method === "sendMessage" && String(c.body.text).includes("закончила") && String(c.body.text).includes(s.callsign)));
    const before = await mark();
    await human("/human/message", { chat: CHAT, from: CHAT, text: turn(say("получено из чата")), reply_to: done.message });
    // сообщение ушло сессии из чата, мимо обвязки: итог хода — за записью человека с этим текстом
    const reply = await s.after("получено из чата");
    if (!reply.text.includes("получено из чата")) throw new Error(`сессия ответила не тем: ${reply.text.slice(0, 80)}`);
    // отметку «дошло до машины» бот ставит реакцией на сообщение человека
    const seen = await t.wait("реакция бота на сообщение человека", async () => (await botDid(before)).find((c) => c.method === "setMessageReaction"));
    return `реакция ${seen.body.reaction?.[0]?.emoji}; итог: ${reply.text.slice(0, 40)}`;
  });
});
