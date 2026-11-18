// Telegram для флота в коробке: двойник играет обе стороны. Настоящего Telegram на раннере не получить — нужны аккаунты людей.
//   сторона бота: POST /bot<токен>/<метод> — то, чем пользуются службы: getMe, setWebhook, deleteWebhook, sendMessage, createForumTopic,
//     answerCallbackQuery, editMessageReplyMarkup, setMessageReaction. Каждый вызов записан.
//   сторона человека — для проверки: POST /human/message {chat, from, text, reply_to?} — человек написал; POST /human/press {chat, from, message, label} —
//     нажал кнопку под сообщением бота; GET /human/calls — что бот сделал, по порядку. Написанное и нажатое уходит службам вебхуком,
//     как от Telegram: с секретом, который службы назвали в setWebhook.
import http from "node:http";

/** Токен бота коробки: его принимает двойник. */
export const TOKEN = "100200300:box-bot-token";
const NAME = "switchboard_box_bot";

export function serve(port, log = () => {}) {
  let hook = null; // { url, secret }
  let ids = 100; // номера сообщений и тем — общий счётчик
  const calls = []; // вызовы бота по порядку
  const sent = new Map(); // сообщения бота: "<чат>:<номер>" → сообщение
  const update = async (body) => {
    if (!hook) throw new Error("вебхук не поставлен");
    const r = await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return r.status;
  };
  const chatOf = (id) => ({ id, type: id > 0 ? "private" : "supergroup" });
  const methods = {
    getMe: () => ({ id: 100200300, is_bot: true, first_name: "Switchboard", username: NAME }),
    setWebhook: (b) => ((hook = { url: b.url, secret: b.secret_token }), true),
    deleteWebhook: () => ((hook = null), true),
    sendMessage: (b) => {
      const message = { message_id: ++ids, chat: chatOf(b.chat_id), from: { id: 100200300, is_bot: true }, text: b.text, ...(b.message_thread_id ? { message_thread_id: b.message_thread_id } : {}), ...(b.reply_markup ? { reply_markup: b.reply_markup } : {}) };
      sent.set(`${b.chat_id}:${message.message_id}`, message);
      return message;
    },
    createForumTopic: (b) => ({ message_thread_id: ++ids, name: b.name }),
    answerCallbackQuery: () => true,
    editMessageReplyMarkup: (b) => {
      const m = sent.get(`${b.chat_id}:${b.message_id}`);
      if (m) m.reply_markup = b.reply_markup;
      return true;
    },
    setMessageReaction: () => true,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const url = new URL(req.url, "http://telegram.box");
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const called = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      if (called) {
        const [, token, method] = called;
        if (token !== TOKEN) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
        if (!methods[method]) return send(404, { ok: false, error_code: 404, description: `Not Found: method ${method}` });
        const result = methods[method](body);
        calls.push({ n: calls.length + 1, method, body, ...(result?.message_id ? { message: result.message_id } : {}) });
        log(`бот: ${method} ${JSON.stringify(body).slice(0, 120)}`);
        return send(200, { ok: true, result });
      }
      try {
        if (req.method === "GET" && url.pathname === "/human/calls") return send(200, { calls });
        if (req.method === "POST" && url.pathname === "/human/message") {
          const message = { message_id: ++ids, chat: chatOf(body.chat), from: { id: body.from, first_name: body.name ?? "Человек" }, text: body.text, ...(body.reply_to ? { reply_to_message: { message_id: body.reply_to } } : {}) };
          log(`человек ${body.from}: ${String(body.text).slice(0, 80)}`);
          return send(200, { message: message.message_id, status: await update({ update_id: ++ids, message }) });
        }
        if (req.method === "POST" && url.pathname === "/human/press") {
          const message = sent.get(`${body.chat}:${body.message}`);
          const data = message?.reply_markup?.inline_keyboard?.flat().find((b) => b.text === body.label)?.callback_data;
          if (!data) return send(404, { error: `кнопки «${body.label}» под сообщением ${body.message} нет` });
          log(`человек ${body.from} нажал «${body.label}»`);
          return send(200, { status: await update({ update_id: ++ids, callback_query: { id: String(++ids), from: { id: body.from }, message, data } }) });
        }
      } catch (e) {
        return send(502, { error: String(e.message ?? e) });
      }
      send(404, { error: `${req.method} ${url.pathname}` });
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}
