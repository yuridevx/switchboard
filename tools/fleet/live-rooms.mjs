// Живая проверка «переписка с человеком»: node tools/fleet/live-rooms.mjs [флот] [устройство] [машина]
// Личный чат человека с ботом флота: чат привязывается кодом; вопрос сессии приходит кнопками; нажатие отвечает и ход продолжается;
// итог хода приходит в чат; ответ текстом на него уходит сессии. Человека играет двойник Telegram коробки (SB2_TG_HUMAN — его адрес).
// Идёт одна: человек проверки не должен быть на связи страницей — иначе вопрос в чат не уходит; бот — общий для флота.
// Группа с темами, посторонний и второй человек — в ручной проверке с живыми аккаунтами: tools/telegram/live.mjs.
import { fleetCall, machineTmp, newTag } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const HUMAN = process.env.SB2_TG_HUMAN;
if (!HUMAN) throw new Error("нужен SB2_TG_HUMAN — адрес двойника Telegram: его ставит флот в коробке");
const { call, must } = fleetCall(fleet, device);
const tag = newTag();
const SEAT = process.env.SB2_KEY ?? "muse";
const MODEL = process.env.SB2_MODEL ?? must("keys.models", { name: SEAT }).models[0].id;
/** Личный чат: номер чата — номер человека, положительный. */
const CHAT = 700_000 + Math.floor(Math.random() * 99_999);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, total = 0;
async function step(label, fn) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
}
const human = async (path, body) => {
  const r = await fetch(HUMAN + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`двойник Telegram: ${j.error ?? r.status}`);
  return j;
};
/** Что бот сделал в чате проверки после n-го вызова. */
const botDid = async (after = 0) => (await human("/human/calls")).calls.filter((c) => c.n > after && (c.body.chat_id === CHAT || c.method === "answerCallbackQuery"));
async function until(what, fn, ms = 60_000) {
  for (const end = Date.now() + ms; ; await sleep(700)) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
  }
}
const rowOf = (cs) => must("fleet.list", { machine, full: true }).sessions.find((s) => s.callsign === cs);

await step("чат привязан кодом: бот подтвердил, чат — устройство человека", async () => {
  const { code, bot } = must("reach.telegram", {});
  await human("/human/message", { chat: CHAT, from: CHAT, text: `/start ${code}` });
  const said = await until("ответ бота «Привязано»", async () => (await botDid()).find((c) => c.method === "sendMessage" && String(c.body.text).startsWith("Привязано")));
  if (!must("reach.devices", {}).devices.some((d) => d.id === `tg${CHAT}`)) throw new Error("чата нет среди устройств человека");
  return `@${bot}: ${said.body.text}`;
});

let cs = "", asked;
await step("вопрос сессии приходит в чат кнопками", async () => {
  const before = (await human("/human/calls")).calls.length;
  cs = must("session.open", { to: "@" + machine, spec: { name: "tg-" + tag, cwd: `${machineTmp(fleet, device, machine)}/sb2-rooms-${tag}`, key: SEAT, model: MODEL }, mkdir: true,
    prompt: turn(tool("AskUserQuestion", { questions: [{ question: "Какой цвет?", header: "Цвет", multiSelect: false, options: [{ label: "Красный", description: "красный цвет" }, { label: "Синий", description: "синий цвет" }] }] }), say("выбрано: {итог 1}")) }).callsign;
  asked = await until("сообщение бота с кнопками", async () => (await botDid(before)).find((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.length));
  const labels = asked.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
  if (labels.join() !== "Красный,Синий") throw new Error("кнопки: " + labels.join());
  return `${cs}: «${String(asked.body.text).split("\n")[0]}», кнопки ${labels.join(" · ")}`;
});

await step("нажатие кнопки отвечает на вопрос: ход продолжается, кнопки сняты", async () => {
  const before = (await human("/human/calls")).calls.length;
  await human("/human/press", { chat: CHAT, from: CHAT, message: asked.message, label: "Синий" });
  await until("сессия закончила ход с выбранным вариантом", () => { const r = rowOf(cs); return r?.state === "idle" && String(r.result ?? "").includes("Синий"); });
  const did = (await botDid(before)).map((c) => c.method);
  if (!did.includes("answerCallbackQuery") || !did.includes("editMessageReplyMarkup")) throw new Error("бот не подтвердил нажатие и не снял кнопки: " + did.join(", "));
  return `итог хода: ${String(rowOf(cs).result).slice(0, 40)}`;
});

await step("итог хода приходит в чат; ответ текстом на него уходит сессии", async () => {
  const done = await until("сообщение бота об итоге", async () => (await botDid()).find((c) => c.method === "sendMessage" && String(c.body.text).includes("закончила") && String(c.body.text).includes(cs)));
  const before = (await human("/human/calls")).calls.length;
  await human("/human/message", { chat: CHAT, from: CHAT, text: turn(say("получено из чата")), reply_to: done.message });
  await until("сессия ответила на сообщение из чата", () => { const r = rowOf(cs); return r?.state === "idle" && String(r.result ?? "").includes("получено из чата"); });
  // отметка «дошло до машины» ставится реакцией через секунду
  const seen = await until("реакция бота на сообщение человека", async () => (await botDid(before)).find((c) => c.method === "setMessageReaction"), 15_000);
  return `реакция ${seen.body.reaction?.[0]?.emoji}; итог: ${String(rowOf(cs).result).slice(0, 40)}`;
});

if (cs) call("session.remove", { to: cs });
call("reach.remove", { device: `tg${CHAT}` });
console.log(bad ? `сбоев: ${bad} из ${total}` : `переписка: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
