// Вопрос сессии человеку — чистая часть: какие вопросы внутри, как называются кнопки и что уходит ответом. Формы ответа — те, что читает Host.
import type { Ask } from "@sb/protocol";

export type Q = { question: string; header?: string; multi: boolean; options: Array<{ label: string; about?: string }> };

/** Вопросы внутри: у AskUserQuestion их может быть несколько — они лежат во вводе инструмента; иначе один, из самой строки. */
export function questionsOf(ask: Ask): Q[] {
  const raw = (ask.input as { questions?: Array<{ question?: string; header?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }> } | undefined)?.questions;
  if (ask.kind === "question" && Array.isArray(raw) && raw.length) {
    return raw.map((q) => ({ question: q.question ?? "", ...(q.header ? { header: q.header } : {}), multi: !!q.multiSelect, options: (q.options ?? []).map((o) => ({ label: o.label ?? "", ...(o.description ? { about: o.description } : {}) })) }));
  }
  return [{ question: ask.text, ...(ask.title ? { header: ask.title } : {}), multi: !!ask.multi, options: ask.options ?? [] }];
}

/** Ответ на вопросы: каждому вопросу — его текст ответа; несколько выбранных — через запятую. */
export function questionAnswer(qs: Q[], picked: string[][]): { answers: Record<string, string> } {
  return { answers: Object.fromEntries(qs.map((q, i) => [q.question, (picked[i] ?? []).join(", ")])) };
}
/** Что показать человеку как «отвечено». */
export const questionSaid = (picked: string[][]): string => picked.map((p) => p.join(", ")).filter(Boolean).join("; ");
/** Отвечены ли все вопросы. */
export const answeredAll = (qs: Q[], picked: string[][]): boolean => qs.every((_, i) => (picked[i] ?? []).some((x) => x.trim()));

export type Action = "allow" | "allow_always" | "deny";
/** Слова кнопок: у разрешения и у плана — свои. */
export const ACTION_WORD: Record<"permission" | "plan", Record<Action, string>> = {
  permission: { allow: "Разрешить", allow_always: "Разрешать всегда", deny: "Отклонить" },
  plan: { allow: "Одобрить", allow_always: "Одобрить и разрешать правки", deny: "Доработать" },
};
/** Ответ на разрешение и план: действие и причина отказа. */
export const actionAnswer = (action: Action, message?: string): { action: Action; message?: string } => ({ action, ...(action === "deny" && message?.trim() ? { message: message.trim() } : {}) });

export type Field = { key: string; title: string; type: "string" | "number" | "boolean" | "enum"; required: boolean; options?: Array<{ value: string; label: string }>; about?: string; initial: unknown };

/** Поля формы сервера MCP по её схеме: строка, число, флажок, выбор. */
export function formFields(schema: unknown): Field[] {
  const s = (schema ?? {}) as { properties?: Record<string, Record<string, any>>; required?: string[] };
  return Object.entries(s.properties ?? {}).map(([key, p]) => {
    const choices: string[] | undefined = p.enum ?? p.oneOf?.map((o: { const: string }) => o.const);
    const names: string[] | undefined = p.enumNames ?? p.oneOf?.map((o: { title?: string; const: string }) => o.title ?? o.const);
    const type = choices ? "enum" : p.type === "boolean" ? "boolean" : p.type === "number" || p.type === "integer" ? "number" : "string";
    return {
      key, title: p.title ?? key, type, required: (s.required ?? []).includes(key), ...(p.description ? { about: p.description } : {}),
      ...(choices ? { options: choices.map((value, i) => ({ value, label: names?.[i] ?? value })) } : {}),
      initial: p.default ?? (type === "boolean" ? false : ""),
    } as Field;
  });
}
/** Заполнена ли форма: обязательные поля не пусты. */
export const formReady = (fields: Field[], values: Record<string, unknown>): boolean => fields.every((f) => !f.required || f.type === "boolean" || (values[f.key] !== "" && values[f.key] != null));
/** Ответ формы: пустые необязательные поля не уходят. */
export function formAnswer(fields: Field[], values: Record<string, unknown>): { action: "accept"; content: Record<string, unknown> } {
  return { action: "accept", content: Object.fromEntries(fields.filter((f) => f.type === "boolean" || (values[f.key] !== "" && values[f.key] != null)).map((f) => [f.key, values[f.key]])) };
}

/** Как назвать того, кто видит вопрос или ответил: своё устройство — «вы», чужое — его имя, сессия — позывной. */
const whoWord = (addr: string, me?: string): string => {
  const tilde = addr.indexOf("~");
  if (tilde < 0) return addr;
  const device = addr.slice(0, tilde), person = addr.slice(tilde);
  if (me && person === me) return device ? `вы (${device})` : "вы";
  return device ? `${device} ${person.slice(1).split("@")[0]}` : person.slice(1).split("@")[0]!;
};

/** «Вопрос видят: …» — адресат вопроса и те, кто смотрел сессию, когда он задан; никого — пусто. */
export function seenWord(ask: Pick<Ask, "to" | "seen">, me?: string): string {
  const all = [...new Set([...(ask.to ? [ask.to] : []), ...(ask.seen ?? [])])];
  // «вы» — первым и один раз, даже если устройств несколько
  const mine = all.filter((a) => me && a.endsWith(me));
  const others = all.filter((a) => !mine.includes(a)).map((a) => whoWord(a, me));
  const names = [...(mine.length ? [mine.length > 1 ? `вы (${mine.map((a) => a.slice(0, a.indexOf("~"))).filter(Boolean).join(", ")})` : whoWord(mine[0]!, me)] : []), ...others];
  return names.length ? `Вопрос видят: ${names.join(", ")}` : "";
}

/** Итог вопроса словами: кто ответил и чем. Событие ленты ask.answered. */
export function askOutcome(e: { kind?: string; by?: string; answer?: unknown; via?: string }, me?: string): { text: string; dim: string } {
  const a = e.answer as { answers?: Record<string, string>; action?: string; message?: string } | string | undefined;
  if (a === "cancelled") return { text: "вопрос снят", dim: "" };
  const words = ACTION_WORD[e.kind === "plan" ? "plan" : "permission"];
  const said = typeof a === "string" ? a
    : a?.answers ? Object.values(a.answers).filter(Boolean).join("; ")
    : a?.action === "allow" || a?.action === "allow_always" || a?.action === "deny" ? (e.kind === "permission" || e.kind === "plan" ? words[a.action].toLowerCase() : a.action) + (a.message ? `: ${a.message}` : "")
    : a?.action === "accept" ? (e.kind === "form" ? "форма заполнена" : "готово")
    : a?.action === "decline" ? "отказ" : a?.action === "cancel" ? "закрыто" : "";
  const who = e.by ? whoWord(e.by, me) : "";
  return { text: `отвечено${said ? `: ${said}` : ""}`, dim: [who, e.via === "push" ? "из уведомления" : ""].filter(Boolean).map((x) => ` · ${x}`).join("") };
}
