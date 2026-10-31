// Модуль fleet: переписка сессий по позывным. Каждой сессии — сервер MCP fleet с инструментами list, send, answer;
// чужое сообщение — запрос message: текст с отправителем ложится во ввод с priority "next" (простаивающая
// просыпается, занятая читает на границе шага). Адресата нет — отказ сразу, без очереди. Хранить нечего.
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Ctx, Frame, Host, Module, Result } from "@switchboard/host";
import { refuse } from "@switchboard/host";

type Roster = { sessions?: Array<{ callsign: string; state?: string | null }>; clients?: string[] };
type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Что видит модель адресата: отправитель в тексте — поле origin модель не видит (опыт 12). */
export const wrap = (from: string, body: string) => `<fleet-message from="${from}">\n${body}\n</fleet-message>`;

/** Строка в системный промпт: модель знает свой позывной (опыт 13). */
export const prompt = (me: string) =>
  `Ты во флоте как ${me}. Кто на связи — инструмент fleet.list, написать сессии или клиенту — fleet.send ` +
  `(ответа не ждёт: адресат ответит своим fleet.send). Сообщения флота приходят во ввод тегом <fleet-message from="…">; ` +
  `вопрос другой сессии — тегом <fleet-question>, ответ на него — fleet.answer.`;

/** Отказ словом — текстом для модели. */
function failed(to: string, r: Result & { ok: false }): Text {
  if (r.error === "offline") return text(`Не доставлено: ${to} не на связи (offline)`, true);
  if (r.error === "disconnected") return text(`Доставка не подтверждена: нет связи с relay (disconnected)`, true);
  return text(`Не доставлено: ${to} — ${r.error}`, true);
}

type Wait = { callsign: string; ok: (r: { text: string }) => void; no: (e: Error) => void };

export function make() {
  let host: Host;
  /** последний roster: для fleet.list */
  let roster: Roster | null = null;
  /** message с wait: uuid ввода → ждущий ответа отправитель */
  const waits = new Map<string, Wait>();

  /** Инструменты сервера MCP одной сессии: отправитель — сама сессия, в аргументах его нет. */
  function tools(me: string): SdkMcpToolDefinition<any>[] {
    return [
      tool("list", "Кто на связи: сессии флота с состояниями и клиенты (телефон, пульт).", {}, async () => {
        if (!roster) return text("Нет связи с relay (disconnected): список сессий неизвестен", true);
        const sessions = (roster.sessions ?? []).map((s) => ({ callsign: s.callsign, state: s.state ?? null }));
        return text(JSON.stringify({ me, sessions, clients: roster.clients ?? [] }));
      }),
      tool(
        "send",
        "Написать сессии флота (callsign имя@машина) или клиенту (phone, panel-desk). Ответа адресата не ждёт.",
        { to: z.string().describe("callsign сессии или имя клиента"), text: z.string().describe("текст сообщения") },
        async ({ to, text: body }) => {
          if (to.includes("@")) {
            const r = await host.request("message", { v: 1, to, text: body, from: me });
            return r.ok ? text(`доставлено: ${to}`) : failed(to, r);
          }
          // клиенту — кадр без подтверждения; кого нет на связи, достанет пушем модуль push
          const r = host.emit({ type: "message", from: me, to, text: body });
          if (!r.ok) return failed(to, r);
          void host.request("notify", { v: 1, clients: [to], frame: { type: "message", from: me, notify: { title: me, body, tag: randomUUID() } } });
          return text(`отправлено: ${to}`);
        },
      ),
      tool(
        "answer",
        "Ответить на вопрос другой сессии (тег <fleet-question>), которой эта сессия дала задачу.",
        {
          to: z.string().describe("callsign сессии, задавшей вопрос"),
          question: z.string().describe("id вопроса из тега"),
          answers: z.record(z.string(), z.string()).describe("текст вопроса → ответ; несколько вариантов — через запятую"),
        },
        async ({ to, question, answers }) => {
          const r = await host.request("answer", { v: 1, callsign: to, question, answers, from: me });
          return r.ok ? text("принято") : failed(to, r);
        },
      ),
    ];
  }

  /** Сообщение во ввод сессии этой машины. С wait — ответ после конца хода, взявшего сообщение. */
  function message(req: Frame, ctx: Ctx): Promise<{ text: string }> | undefined {
    const to = req.to;
    if (typeof to !== "string" || typeof req.text !== "string") throw refuse("bad_frame", "message: нужны to — callsign и text");
    const s = host.session(to);
    if (!s || s.state === "stopped" || s.state === "failed") throw refuse("offline", `${to}: ${s ? `сессия ${s.state}` : "сессии нет на машине"}`);
    const from = typeof req.from === "string" ? req.from : (ctx.from ?? "");
    const uuid = randomUUID();
    let done: Promise<{ text: string }> | undefined;
    if (req.wait === true) {
      done = new Promise((ok, no) => {
        waits.set(uuid, { callsign: to, ok, no });
        // Host останавливается: отправитель узнаёт сразу, ход идёт дальше у keeper
        ctx.signal.addEventListener("abort", () => settle(uuid, refuse("disconnected", `${to}: Host останавливается — ответа после хода не будет`)), { once: true });
      });
    }
    s.input(wrap(from, req.text), { from, priority: "next", uuid, origin: { kind: "peer", from, name: from } });
    return done;
  }

  function settle(uuid: string, r: { text: string } | Error): void {
    const w = waits.get(uuid);
    if (!w) return;
    waits.delete(uuid);
    if (r instanceof Error) w.no(r);
    else w.ok(r);
  }

  const mod: Module = {
    session: (s) => ({
      mcpServers: { fleet: createSdkMcpServer({ name: "fleet", version: "1.2.0", tools: tools(s.info.callsign) }) },
      append: prompt(s.info.callsign),
    }),
    requests: { message },
    on: {
      // конец хода: ждущим wait — текст result или turn_failed
      event(s, m) {
        if (m.type !== "result" || !waits.size) return;
        const r = m as { subtype: string; is_error?: boolean; result?: string; user_message_uuids?: string[]; user_message_uuid?: string };
        const took = r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : []);
        for (const uuid of took) {
          if (waits.get(uuid)?.callsign !== s.info.callsign) continue;
          if (r.subtype === "success" && !r.is_error) settle(uuid, { text: r.result ?? "" });
          else settle(uuid, refuse("turn_failed", `${s.info.callsign}: ход с сообщением кончился ${r.subtype}`));
        }
      },
      // процесс ушёл: оборванный ход потерян
      close(s) {
        for (const [uuid, w] of waits) if (w.callsign === s.info.callsign) settle(uuid, refuse("turn_failed", `${s.info.callsign}: процесс закрыт посреди хода`));
      },
      frame(f) {
        if (f.type === "roster") roster = f as Roster;
      },
    },
    start(h) {
      host = h;
    },
    // хранить нечего; ждущих wait уже отпустил сигнал остановки Host
    stop() {
      waits.clear();
    },
  };
  return { module: mod, tools };
}
