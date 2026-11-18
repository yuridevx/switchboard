// Поддельная модель коробки: сервер с API сообщений Anthropic. Не понимает просьб — исполняет сценарий хода (tools/fleet/turn.mjs):
// на каждый запрос — один шаг сценария: вызов инструмента с названными полями или ответ текстом. Сценария нет — отвечает «ок».
// Состояния нет: сценарий — в последнем сообщении человека с ним, сделанные шаги — ответы модели после него в том же разговоре.
// Языков три: Anthropic (/v1/messages), OpenAI Responses (/v1/responses) и Meta — тот же Responses и канал версии Muse. Сценарий хода один:
// запрос чужого языка приводится к виду Anthropic, ответ — обратно, как его ждёт перевод Host.
// Тот же сервер играет Claude по аккаунту: запрос с токеном в Authorization без x-api-key — так его шлёт Host. Тогда каталог — модели Claude,
// у ответа — заголовки недельного лимита и срок кэша, а отказ заказывает сам токен аккаунта (см. refusal).
import http from "node:http";
import { parse } from "../fleet/turn.mjs";

/** Каталог ключа коробки: две модели с окном — проверкам смены модели и кольца контекста. */
export const MODELS = [{ id: "box-1", display_name: "Box 1", max_input_tokens: 200_000 }, { id: "box-2", display_name: "Box 2", max_input_tokens: 200_000 }];
/** Каталог Claude: по модели на семейство, с окном. */
export const CLAUDE_MODELS = [
  { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 200_000 },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 500_000 },
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1_000_000 },
];
const SEARCH = "ToolSearch";
const U = "anthropic-ratelimit-unified";
const HOUR = 3_600_000;

/** Токен аккаунта Claude из запроса; запрос по ключу провайдера (с x-api-key) — не аккаунт. */
const accountOf = (req) => (req.headers["x-api-key"] ? null : /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null);
/** Заголовки окна недели, как их шлёт Claude: сколько потрачено и когда сброс. */
const week = (used, rejected) => ({
  [`${U}-status`]: rejected ? "rejected" : "allowed", [`${U}-7d-utilization`]: String(used), [`${U}-7d-reset`]: String(Math.floor((Date.now() + 100 * HOUR) / 1000)),
  ...(rejected ? { [`${U}-representative-claim`]: "seven_day", [`${U}-7d-status`]: "rejected", [`${U}-reset`]: String(Math.floor((Date.now() + 100 * HOUR) / 1000)) } : {}),
});
/** Отказ Claude аккаунту вместо ответа модели. Заказ — в самом токене аккаунта, состояния у двойника нет:
 *    …not-a-token    — 401: токен не принят;
 *    …full-after-N   — 429 «лимит недели», когда в разговоре уже есть N ответов модели: лимит кончился посреди хода.
 *  И без заказа, как сам Claude: документ PDF без таблицы ссылок (startxref) — 400 со словами. */
function refusal(token, body) {
  if (token.includes("not-a-token")) return { status: 401, headers: {}, type: "authentication_error", message: "OAuth token is not valid" };
  if (documents(body?.messages ?? []).some((d) => d.source?.media_type === "application/pdf" && !Buffer.from(String(d.source.data ?? ""), "base64").includes("startxref"))) return { status: 400, headers: {}, type: "invalid_request_error", message: "Could not process PDF: the document is not a valid PDF file" };
  const after = /full-after-(\d+)/.exec(token);
  if (after && (body?.messages ?? []).filter((m) => m.role === "assistant").length >= Number(after[1])) return { status: 429, headers: week(1, true), type: "rate_limit_error", message: "This request would exceed your account's rate limit" };
  return null;
}
/** Блоки-документы запроса: в сообщениях и в итогах инструментов. */
const documents = (v) => (Array.isArray(v) ? v.flatMap(documents) : v && typeof v === "object" ? (v.type === "document" ? [v] : documents(v.content)) : []);
/** Просит ли запрос часовой кэш: Claude называет срок записи кэша по просьбе. */
const hourCache = (body) => JSON.stringify([body.system ?? "", body.tools ?? "", body.messages ?? ""]).includes('"ttl":"1h"');

const blocks = (m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]);
const textOf = (m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const uses = (m) => (m.role === "assistant" ? blocks(m).filter((b) => b.type === "tool_use") : []);
/** Текст итога инструмента по номеру его вызова. */
function resultOf(msgs, id) {
  for (const m of msgs) for (const b of m.role === "user" ? blocks(m) : []) {
    if (b.type === "tool_result" && b.tool_use_id === id) return (typeof b.content === "string" ? b.content : (b.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n")).trim();
  }
  return "";
}

/** Ответ модели на запрос: блоки и причина остановки. */
export function answer(body) {
  const msgs = body.messages ?? [];
  let at = msgs.length - 1;
  while (at >= 0 && !(msgs[at].role === "user" && parse(textOf(msgs[at])))) at--;
  const text = (t) => ({ content: [{ type: "text", text: t }], stop: "end_turn" });
  if (at < 0) return text("ок");
  const steps = parse(textOf(msgs[at]));
  const before = msgs.slice(0, at), after = msgs.slice(at + 1);
  // сделанный шаг — ответ модели после сценария; подгрузка описания инструмента шагом не считается
  const made = after.filter((m) => m.role === "assistant" && !uses(m).some((u) => u.name === SEARCH));
  const step = steps[made.length];
  if (!step) return text("ок");
  const call = (name, input) => ({ content: [{ type: "tool_use", id: `toolu_box_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, input }], stop: "tool_use" });
  if ("tool" in step) {
    const names = (body.tools ?? []).map((t) => t.name);
    // запрос без инструментов — побочный вопрос claude (заголовок, подсказка): сценарий не для него
    if (!names.length) return text("ок");
    const searched = after.some((m) => uses(m).some((u) => u.name === SEARCH && String(u.input?.query).includes(step.tool)));
    if (!names.includes(step.tool) && names.includes(SEARCH) && !searched) return call(SEARCH, { query: `select:${step.tool}`, max_results: 1 });
    return call(step.tool, step.fields);
  }
  const toolUses = made.flatMap(uses);
  const said = step.say
    .replace(/\{итог (\d+)\}/g, (_, n) => { const k = steps.slice(0, Number(n)).filter((s) => "tool" in s).length - 1; return toolUses[k] ? resultOf(after, toolUses[k].id) : ""; })
    .replace(/\{прошлый итог\}/g, () => { const last = before.flatMap(uses).at(-1); return (last && resultOf(before, last.id)) || "нет"; })
    .replace(/\{вызовов (\w+)\}/g, (_, t) => String(before.flatMap(uses).filter((u) => u.name === t || u.name.endsWith("__" + t)).length));
  return text(said);
}

function reply(res, body, account) {
  const a = answer(body);
  // расход — по размеру запроса: кольцу контекста страницы нужен процент окна
  const size = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const usage = { input_tokens: size, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // аккаунту Claude называет, на какой срок записал кэш: час — если час просили
  if (account) Object.assign(usage, { cache_creation_input_tokens: size, cache_creation: hourCache(body) ? { ephemeral_1h_input_tokens: size, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: size } });
  const message = { id: "msg_box_" + Date.now().toString(36), type: "message", role: "assistant", model: body.model, content: a.content, stop_reason: a.stop, stop_sequence: null, usage };
  const head = { "request-id": "req_box_" + Date.now().toString(36), ...(account ? week(0.2) : {}) };
  if (!body.stream) return void res.writeHead(200, { ...head, "content-type": "application/json" }).end(JSON.stringify(message));
  res.writeHead(200, { ...head, "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { ...message, content: [], stop_reason: null } });
  a.content.forEach((b, index) => {
    if (b.type === "text") {
      ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev("content_block_stop", { index });
  });
  ev("message_delta", { delta: { stop_reason: a.stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev("message_stop", {});
  res.end();
}

/** Запрос OpenAI Responses → вид Anthropic: сообщения, вызовы инструментов и их итоги — по одному на элемент input. */
function fromResponses(body) {
  const said = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join("\n"));
  const messages = (body.input ?? []).flatMap((it) =>
    it.type === "message" && (it.role === "user" || it.role === "assistant") ? [{ role: it.role, content: [{ type: "text", text: said(it.content) }] }]
    : it.type === "function_call" ? [{ role: "assistant", content: [{ type: "tool_use", id: it.call_id, name: it.name, input: JSON.parse(it.arguments || "{}") }] }]
    : it.type === "function_call_output" ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: it.call_id, content: said(it.output) }] }]
    : []);
  return { model: body.model, messages, tools: (body.tools ?? []).filter((t) => t.type === "function").map((t) => ({ name: t.name })) };
}

/** Ответ потоком OpenAI Responses: один элемент — сообщение или вызов инструмента. */
function replyResponses(res, body) {
  const b = answer(fromResponses(body)).content[0];
  const id = "resp_box_" + Date.now().toString(36);
  const size = Math.ceil(JSON.stringify(body.input ?? []).length / 4);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": "req_box_" + Date.now().toString(36) });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("response.created", { response: { id, model: body.model, status: "in_progress" } });
  const item = b.type === "text" ? { type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] } : { type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) };
  ev("response.output_item.added", { output_index: 0, item: b.type === "text" ? { ...item, content: [] } : { ...item, arguments: "" } });
  if (b.type === "text") ev("response.output_text.delta", { output_index: 0, delta: b.text });
  else ev("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
  ev("response.output_item.done", { output_index: 0, item });
  ev("response.completed", { response: { id, model: body.model, status: "completed", output: [item], usage: { input_tokens: size, output_tokens: 5, total_tokens: size + 5 } } });
  res.end();
  return b;
}

/** Сервер модели на http://127.0.0.1:<порт>. log — строка на запрос: что спросили и что ответила. */
export function serve(port, log = () => {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://box");
      const account = accountOf(req);
      const body = req.method === "POST" && raw ? JSON.parse(raw) : null;
      const no = account ? refusal(account, body) : null;
      if (no) {
        log(`аккаунт …${account.slice(-16)} → отказ ${no.status} ${no.type}`);
        return void res.writeHead(no.status, { ...no.headers, "content-type": "application/json", "request-id": "req_box_" + Date.now().toString(36) }).end(JSON.stringify({ type: "error", error: { type: no.type, message: no.message } }));
      }
      if (req.method === "GET" && url.pathname === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: account ? CLAUDE_MODELS : MODELS, has_more: false }));
      // канал версии Muse: его спрашивает Host перед вызовом ключа Meta — у сервера из адреса ключа
      if (req.method === "GET" && url.pathname === "/muse-code/channels/muse-stable") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ channel: "muse-stable", version: "1.4.14-R1.0" }));
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const b = replyResponses(res, body);
        return void log(`${body.model} · язык Responses · элементов ${body.input?.length} → ${b.type === "text" ? b.text.slice(0, 60) : `${b.name} ${JSON.stringify(b.input).slice(0, 80)}`}`);
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const a = answer(body).content[0];
        log(`${body.model} · сообщений ${body.messages?.length} · инструментов ${body.tools?.length ?? 0} → ${a.type === "text" ? a.text.slice(0, 60) : `${a.name} ${JSON.stringify(a.input).slice(0, 80)}`}`);
        return reply(res, body, account);
      }
      log(`нет такого: ${req.method} ${url.pathname}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `${req.method} ${url.pathname}` } }));
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}
