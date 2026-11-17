// Поддельная модель коробки: сервер с API сообщений Anthropic. Не понимает просьб — исполняет сценарий хода (tools/fleet/turn.mjs):
// на каждый запрос — один шаг сценария: вызов инструмента с названными полями или ответ текстом. Сценария нет — отвечает «ок».
// Состояния нет: сценарий — в последнем сообщении человека с ним, сделанные шаги — ответы модели после него в том же разговоре.
import http from "node:http";
import { parse } from "../fleet/turn.mjs";

/** Каталог ключа коробки: две модели с окном — проверкам смены модели и кольца контекста. */
export const MODELS = [{ id: "box-1", display_name: "Box 1", max_input_tokens: 200_000 }, { id: "box-2", display_name: "Box 2", max_input_tokens: 200_000 }];
const SEARCH = "ToolSearch";

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

function reply(res, body) {
  const a = answer(body);
  // расход — по размеру запроса: кольцу контекста страницы нужен процент окна
  const usage = { input_tokens: Math.ceil(JSON.stringify(body.messages ?? []).length / 4), output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg_box_" + Date.now().toString(36), type: "message", role: "assistant", model: body.model, content: a.content, stop_reason: a.stop, stop_sequence: null, usage };
  const head = { "request-id": "req_box_" + Date.now().toString(36) };
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

/** Сервер модели на http://127.0.0.1:<порт>. log — строка на запрос: что спросили и что ответила. */
export function serve(port, log = () => {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://box");
      if (req.method === "GET" && url.pathname === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: MODELS }));
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const body = JSON.parse(raw);
        const a = answer(body).content[0];
        log(`${body.model} · сообщений ${body.messages?.length} · инструментов ${body.tools?.length ?? 0} → ${a.type === "text" ? a.text.slice(0, 60) : `${a.name} ${JSON.stringify(a.input).slice(0, 80)}`}`);
        return reply(res, body);
      }
      log(`нет такого: ${req.method} ${url.pathname}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `${req.method} ${url.pathname}` } }));
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}
