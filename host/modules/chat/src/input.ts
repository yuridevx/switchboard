// Ввод разговора: человек пишет сессии (session.prompt), сессия пишет сессии (message), вопрос другой сессии (кадр question).
// Все три кладут во ввод одной функцией: различаются только текстом для модели, отправителем и словом отказа.
import { randomUUID } from "node:crypto";
import type { Attachment, Frame, Host, Module, Session } from "@switchboard/host";
import { content, refuse } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";

/** Что видит модель адресата: отправитель в тексте, поле origin модель не видит (опыт 12). */
export const wrap = (from: string, body: string) => `<fleet-message from="${from}">\n${body}\n</fleet-message>`;

/** Задача от родителя: подсказка рядом с ней, строку системного промпта модель пропускает (живой прогон 1 нояб.). */
export const task = (from: string, body: string) => `${wrap(from, body)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)`;

type Item = { question?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> };

/** Вопрос другой сессии во ввод: она ответит инструментом fleet.answer. */
function questionText(from: string, id: string, items: Item[]): string {
  const lines = items.flatMap((q) => [`${q.question}${q.multiSelect ? " (можно несколько — через запятую)" : ""}`, ...(q.options ?? []).map((o) => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`)]);
  return [`<fleet-question from="${from}" question="${id}">`, ...lines, `Ответь инструментом fleet.answer: to — ${from}, question — ${id}, answers — { "текст вопроса": "вариант" }.`, "</fleet-question>"].join("\n");
}

/** Сессия не принимает ввод: остановлена намеренно или упала. */
const closed = (s: Session) => s.state === "stopped" || s.state === "failed";

/** Единственный вход во ввод разговора: на границе шага. from — кто теперь дал задачу; нет from — прежний. */
function put(s: Session, body: Parameters<Session["input"]>[0], o: { from?: string; uuid?: string; origin: unknown }): void {
  s.input(body, { priority: "next", ...o });
}

export function makeInput(host: () => Host): Pick<Required<Module>, "requests" | "frames"> {
  return {
    requests: {
      "session.prompt"(req, ctx) {
        const { text = "", attachments = [] } = req as { text?: unknown; attachments?: unknown };
        if (typeof text !== "string" || !Array.isArray(attachments)) throw refuse("bad_frame", "session.prompt: text — строка, attachments — список");
        const s = host().session(req.callsign as string)!;
        if (closed(s)) throw refuse("stopped", `${s.info.callsign}: сессия ${s.state} — поднимает session.start`);
        const body = content(text, attachments as Attachment[]);
        const uuid = typeof req.uuid === "string" ? req.uuid : randomUUID();
        put(s, body, { from: ctx.from, uuid, origin: { kind: "human" } });
        return { uuid };
      },
      message(req, ctx) {
        const { to, text, report } = req as { to?: unknown; text?: unknown; report?: unknown };
        if (typeof to !== "string" || typeof text !== "string") throw refuse("bad_frame", "message: нужны to — callsign и text");
        const s = host().session(to);
        if (!s || closed(s)) throw refuse("offline", `${to}: ${s ? `сессия ${s.state}` : "сессии нет на этой машине"}`);
        const from = ctx.from ?? "";
        // итог хода дочери не новая задача: кто дал задачу родителю, остаётся прежним
        const isReport = report === true;
        const fromParent = !isReport && !!from && s.field("parent") === from;
        put(s, fromParent ? task(from, text) : wrap(from, text), { ...(isReport ? {} : { from }), uuid: randomUUID(), origin: { kind: "peer", from, name: from } });
        return undefined;
      },
    },
    frames: {
      // вопрос дочери не новая задача: кто дал задачу этой сессии, остаётся прежним
      question(f: Frame) {
        const from = f.from as string;
        for (const a of [f.to].flat()) {
          const s = kindOf(a) === "session" ? host().session(a as string) : undefined;
          if (s) put(s, questionText(from, String(f.question), (f.questions ?? []) as Item[]), { origin: { kind: "peer", from, name: from } });
        }
      },
      // сессии закрытый вопрос не нужен: её fleet.answer уже получил ответ
      answered() {},
    },
  };
}
