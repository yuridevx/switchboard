// Карточки ленты: сообщение SDK → элементы. Общие для живой ленты, истории и галереи (#gallery).
// Рисуется по type и subtype; незнакомое пропускается. Состояние вызовов и задач — в View, его ведёт модуль.
import { duration, h } from "@switchboard/web-core";

export type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };
/** Сообщение SDK в ленте и истории. */
export type SdkMsg = {
  type: string;
  uuid?: string;
  subtype?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  tool_use_id?: string;
  elapsed_time_seconds?: number;
  task_id?: string;
  description?: string;
  status?: string;
  summary?: string;
  attempt?: number;
  max_retries?: number;
  error_status?: number | null;
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  /** сводка сжатия: в истории SDK стоит на месте границы — реплика не человека */
  isCompactSummary?: boolean;
  suggestion?: string;
  message?: { content?: string | Block[] };
};

export type Tool = { done: boolean; error: boolean; secs?: number; name?: string };
export type Task = { desc: string; done: boolean; last?: string; steps: number };

/** Что нужно карточкам: состояние вызовов и задач, широкий ли вид и живые кнопки. */
export type View = {
  tools: Map<string, Tool>;
  tasks: Map<string, Task>;
  wide: boolean;
  /** «В фон» у идущей команды Bash; нет — кнопки нет */
  background?(toolUseId: string): void;
  /** «■ Стоп» у идущей задачи */
  stopTask?(taskId: string): void;
};

/** Тег сообщения другой сессии во вводе: <fleet-message from="poe-bot@pc">…</fleet-message>. */
const FLEET = /^<fleet-message from="([^"]+)">\n?([\s\S]*?)\n?<\/fleet-message>$/;

export const blocks = (m: SdkMsg): Block[] => (Array.isArray(m.message?.content) ? (m.message!.content as Block[]) : []);

export function textOf(m: SdkMsg): string {
  const ct = m.message?.content;
  if (typeof ct === "string") return ct;
  return blocks(m)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** Сообщение другой сессии: { from, text } или null. */
export function fleetOf(m: SdkMsg): { from: string; text: string } | null {
  const x = FLEET.exec(textOf(m).trim());
  return x ? { from: x[1], text: x[2] } : null;
}

/** Одна строка вызова инструмента: команда, файл, шаблон или адрес. */
export function toolLine(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof input[k] === "string") return input[k] as string;
  }
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s;
}

const kTokens = (n?: number) => (typeof n === "number" ? `${Math.round(n / 1000)} К` : "?");
const money = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;

/** Итог хода: время, шаги, стоимость — что прислал SDK. */
export function resultLine(m: SdkMsg): string {
  if (m.subtype !== "success") return `ход оборвался: ${m.subtype ?? "ошибка"}`;
  return [
    "ход закончен",
    m.duration_ms ? duration(m.duration_ms) : null,
    typeof m.num_turns === "number" ? `${m.num_turns} шагов` : null,
    typeof m.total_cost_usd === "number" ? money(m.total_cost_usd) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Карточки одного сообщения SDK. */
export function drawSdk(m: SdkMsg, v: View): HTMLElement[] {
  if (m.isCompactSummary) return [h("div", { class: "chat-sys" }, "контекст сжат")];
  if (m.type === "result") return [h("div", { class: "chat-res" + (m.subtype === "success" ? "" : " err") }, resultLine(m))];
  if (m.type === "system") {
    if (m.subtype === "compact_boundary") {
      const cm = m.compact_metadata ?? {};
      return [h("div", { class: "chat-sys" }, `контекст сжат · ${kTokens(cm.pre_tokens)}${cm.post_tokens ? ` → ${kTokens(cm.post_tokens)}` : ""}`)];
    }
    if (m.subtype === "api_retry") {
      return [h("div", { class: "chat-sys wait" }, `повтор запроса к API · ${m.attempt ?? "?"} из ${m.max_retries ?? "?"}${m.error_status ? ` · ${m.error_status}` : ""}`)];
    }
    if (m.subtype === "task_started" && m.task_id) {
      const t = v.tasks.get(m.task_id);
      return [
        h(
          "div",
          { class: "chat-tool task" + (t?.done ? "" : " run") },
          h("b", null, "Task"),
          h("span", null, [t?.desc ?? m.description ?? "", t?.last].filter(Boolean).join(" · ")),
          h("em", null, t?.done ? "✓" : `${t?.steps ?? 0} шага`),
          !t?.done && v.wide && v.stopTask ? h("button", { class: "chat-mini", onclick: () => v.stopTask!(m.task_id!) }, "■ Стоп") : null,
        ),
      ];
    }
    return [];
  }
  if (m.type === "user") {
    const fl = fleetOf(m);
    if (fl) return [h("div", { class: "chat-in fleet" }, h("div", { class: "chat-from" }, `сессия Claude · ${fl.from}`), fl.text)];
    return [h("div", { class: "chat-me" }, textOf(m))];
  }
  const out: HTMLElement[] = [];
  for (const b of blocks(m)) {
    if (b.type === "text" && b.text) out.push(h("div", { class: "chat-txt" }, b.text));
    if (b.type !== "tool_use") continue;
    const t = v.tools.get(String(b.id));
    const st = t?.done ? (t.error ? "✗" : "✓") : t?.secs !== undefined ? `${Math.round(t.secs)} с` : "…";
    const bg = v.wide && v.background && !t?.done && b.name === "Bash" ? h("button", { class: "chat-mini", onclick: () => v.background!(String(b.id)) }, "В фон") : null;
    out.push(h("div", { class: "chat-tool" + (t?.done ? "" : " run") + (t?.error ? " err" : "") }, h("b", null, b.name ?? "?"), h("span", null, toolLine(b.input)), h("em", null, st), bg));
    const inp = b.input ?? {};
    if (b.name === "Edit" && typeof inp.old_string === "string" && typeof inp.new_string === "string") {
      out.push(h("div", { class: "chat-diff" }, h("div", { class: "del" }, `− ${inp.old_string}`), h("div", { class: "add" }, `+ ${inp.new_string}`)));
    }
  }
  return out;
}
