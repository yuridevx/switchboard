// Поддельная модель: сервер с API сообщений Anthropic. Отвечает не «умом», а по просьбе: просьба сама называет, что сделать.
//   «Ответь одним словом: X»                         → текст X
//   «Выполни инструментом T … команду: C»            → вызов инструмента T {command: C}
//   «… и после неё ответь одним словом: W»           → после итога инструмента — текст W
// Состояния нет: план хода строится из последней просьбы человека, шаг — число итогов инструментов после неё.
import http from "node:http";

export const MODELS = [{ id: "box-1", display_name: "Box 1", max_input_tokens: 200_000 }, { id: "box-2", display_name: "Box 2", max_input_tokens: 200_000 }];

/** Текст блока или сообщения. */
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "");
const isResult = (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");

/** План хода по просьбе: шаги — вызовы инструментов, потом слово. */
export function plan(ask) {
  const steps = [];
  const tool = /Выполни инструментом (\w+)[^:]*команду: (.+?)(?: — и после неё|$)/s.exec(ask);
  if (tool) steps.push({ tool: tool[1], input: { command: tool[2].trim() } });
  const word = /[Оо]тветь одним словом: (\S+?)[.!]?\s*$/.exec(ask);
  return { steps, word: word ? word[1] : "ок" };
}

/** Что отвечает модель на запрос: блоки ответа и причина остановки. */
export function answer(body) {
  const msgs = body.messages ?? [];
  let last = msgs.length - 1;
  while (last >= 0 && (msgs[last].role !== "user" || isResult(msgs[last]) || !textOf(msgs[last].content).trim())) last--;
  const ask = last >= 0 ? textOf(msgs[last].content) : "";
  const done = msgs.slice(last + 1).filter(isResult).length;
  const p = plan(ask);
  const step = p.steps[done];
  if (step && (body.tools ?? []).some((t) => t.name === step.tool)) return { content: [{ type: "tool_use", id: `toolu_box_${Date.now().toString(36)}${done}`, name: step.tool, input: step.input }], stop: "tool_use" };
  return { content: [{ type: "text", text: p.word }], stop: "end_turn" };
}

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
function reply(res, body) {
  const a = answer(body);
  const message = { id: "msg_box_" + Date.now().toString(36), type: "message", role: "assistant", model: body.model, content: a.content, stop_reason: a.stop, stop_sequence: null, usage };
  if (!body.stream) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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
  ev("message_delta", { delta: { stop_reason: a.stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}

/** Сервер модели: адрес — http://127.0.0.1:<порт>. log — строка на запрос. */
export function serve(port, log = () => {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: MODELS }));
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const body = JSON.parse(raw);
        log(`${body.model} · сообщений ${body.messages?.length} · инструментов ${body.tools?.length ?? 0} · ${textOf(body.messages?.at(-1)?.content).slice(0, 80).replace(/\s+/g, " ")}`);
        return reply(res, body);
      }
      log(`нет такого: ${req.method} ${url.pathname}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `${req.method} ${url.pathname}` } }));
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}
