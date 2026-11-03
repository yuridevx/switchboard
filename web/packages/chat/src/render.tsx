// Карточки ленты: сообщение SDK → компоненты. Общие для живой ленты, истории и галереи (#gallery).
// Рисуется по type и subtype; незнакомое пропускается. Состояние вызовов и задач — в View, его ведёт модуль;
// строка вызова или задачи выбирает своё сама и перерисовывается одна.
import type { ReactNode } from "react";
import { duration } from "@switchboard/web-ui";

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

/** Что нужно карточкам: состояние вызовов и задач, широкий ли вид, выборка и живые кнопки. */
export type View = {
  tools: Map<string, Tool>;
  tasks: Map<string, Task>;
  wide: boolean;
  /** выборка app.use: карточка перерисуется, когда изменился ответ */
  use<T>(select: () => T): T;
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

/** Строка задачи субагента: ход приходит кадрами, перерисовывается только она. */
function TaskCard({ id, description, v }: { id: string; description?: string; v: View }) {
  const t = v.use(() => {
    const x = v.tasks.get(id);
    return x ? { ...x } : undefined;
  });
  return (
    <div className={"chat-tool task" + (t?.done ? "" : " run")}>
      <b>Task</b>
      <span>{[t?.desc ?? description ?? "", t?.last].filter(Boolean).join(" · ")}</span>
      <em>{t?.done ? "✓" : `${t?.steps ?? 0} шага`}</em>
      {!t?.done && v.wide && v.stopTask ? (
        <button className="chat-mini" onClick={() => v.stopTask!(id)}>
          ■ Стоп
        </button>
      ) : null}
    </div>
  );
}

/** Строка вызова инструмента и его diff: секунды и итог меняют только её. */
function ToolCard({ b, v }: { b: Block; v: View }) {
  const id = String(b.id);
  const t = v.use(() => {
    const x = v.tools.get(id);
    return x ? { ...x } : undefined;
  });
  const st = t?.done ? (t.error ? "✗" : "✓") : t?.secs !== undefined ? `${Math.round(t.secs)} с` : "…";
  const inp = b.input ?? {};
  return (
    <>
      <div className={"chat-tool" + (t?.done ? "" : " run") + (t?.error ? " err" : "")}>
        <b>{b.name ?? "?"}</b>
        <span>{toolLine(b.input)}</span>
        <em>{st}</em>
        {v.wide && v.background && !t?.done && b.name === "Bash" ? (
          <button className="chat-mini" onClick={() => v.background!(id)}>
            В фон
          </button>
        ) : null}
      </div>
      {b.name === "Edit" && typeof inp.old_string === "string" && typeof inp.new_string === "string" ? (
        <div className="chat-diff">
          <div className="del">{`− ${inp.old_string}`}</div>
          <div className="add">{`+ ${inp.new_string}`}</div>
        </div>
      ) : null}
    </>
  );
}

/** Карточки одного сообщения SDK. after — дополнение к реплике человека (ссылка отката). */
export function SdkCards({ m, v, after }: { m: SdkMsg; v: View; after?: ReactNode }) {
  if (m.isCompactSummary) {
    return (
      <div className="chat-sys">
        контекст сжат
        {after}
      </div>
    );
  }
  if (m.type === "result") return <div className={"chat-res" + (m.subtype === "success" ? "" : " err")}>{resultLine(m)}</div>;
  if (m.type === "system") {
    if (m.subtype === "compact_boundary") {
      const cm = m.compact_metadata ?? {};
      return <div className="chat-sys">{`контекст сжат · ${kTokens(cm.pre_tokens)}${cm.post_tokens ? ` → ${kTokens(cm.post_tokens)}` : ""}`}</div>;
    }
    if (m.subtype === "api_retry") {
      return <div className="chat-sys wait">{`повтор запроса к API · ${m.attempt ?? "?"} из ${m.max_retries ?? "?"}${m.error_status ? ` · ${m.error_status}` : ""}`}</div>;
    }
    if (m.subtype === "task_started" && m.task_id) return <TaskCard id={m.task_id} description={m.description} v={v} />;
    return null;
  }
  if (m.type === "user") {
    const fl = fleetOf(m);
    if (fl) {
      return (
        <div className="chat-in fleet">
          <div className="chat-from">{`сессия Claude · ${fl.from}`}</div>
          {fl.text}
        </div>
      );
    }
    return (
      <div className="chat-me">
        {textOf(m)}
        {after}
      </div>
    );
  }
  return (
    <>
      {blocks(m).map((b, i) =>
        b.type === "text" && b.text ? (
          <div key={i} className="chat-txt">
            {b.text}
          </div>
        ) : b.type === "tool_use" ? (
          <ToolCard key={i} b={b} v={v} />
        ) : null,
      )}
    </>
  );
}
