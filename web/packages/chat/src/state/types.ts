// Состояние ленты: записи, инструменты и задачи. Неизменяемые снимки; правит только feed.ts.
import type { ToolInput } from "./wire.ts";

export type ToolResult = { text: string; isError: boolean; images: string[] };
export type Part = { kind: "text"; text: string; live?: boolean } | { kind: "think"; text: string; live?: boolean } | { kind: "tool"; id: string };
export type Tool = { id: string; name: string; input: ToolInput; result?: ToolResult; parts: Part[]; parent: string | null; secs?: number; summary?: string };

export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "killed" | "pending" | "paused";
export const isEnded = (s: TaskStatus) => s === "completed" || s === "failed" || s === "stopped" || s === "killed";
export type Task = {
  id: string;
  toolUseId?: string;
  type: string;
  description: string;
  subagent?: string;
  status: TaskStatus;
  background: boolean;
  summary?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  startedAt: number;
  endedAt?: number;
};

/** Служебная строка ленты. */
export type Sys =
  | { type: "compact"; pre?: number; post?: number; auto?: boolean; summary?: string }
  | { type: "interrupted" }
  | { type: "result"; ok: boolean; subtype?: string; cost?: number; ms?: number; turns?: number; tokens?: number; error?: string }
  | { type: "retry"; attempt?: number; max?: number; error?: string; delayMs?: number }
  | { type: "limits"; status: string; window?: string; resets?: number }
  | { type: "command"; name: string; args?: string; output?: string }
  | { type: "error"; text: string }
  | { type: "model"; from?: string; to: string }
  /** задача: running — строка с кнопкой «Стоп» (задача без вызова инструмента), иначе — конец фоновой */
  | { type: "task"; id?: string; status: TaskStatus; description: string; kind?: string }
  | { type: "info"; text: string; warn?: boolean }
  | { type: "denied"; tool: string; message?: string }
  | { type: "reset" }
  | { type: "refusal"; from?: string; to?: string; text?: string; category?: string; local?: boolean; ask?: string }
  | { type: "fallback"; from?: string; to?: string; trigger?: string }
  | { type: "memory"; paths: string[] }
  | { type: "hook"; event: string; name: string; code?: number; text?: string }
  | { type: "files"; saved: string[]; failed: string[] }
  | { type: "swap"; from: string; to: string };

/** Кто прислал сообщение не от человека: другая сессия или субагент; mode — его режим разрешений. */
export type Peer = { kind: "session" | "agent"; name?: string; mode?: string };
/** Доставка своего сообщения: ждём reply → ✓ (reply ok) → ✓✓ (uuid в ленте); lost — связь оборвалась до reply. */
export type Delivery = "sending" | "ok" | "echo" | "lost";

export type UserItem = { kind: "user"; id: string; text: string; images: string[]; files: string[]; at?: number; state?: Delivery; queued?: boolean; from?: Peer };
export type InItem = { kind: "in"; id: string; text: string; at: number; push: boolean };
export type AsstItem = { kind: "assistant"; id: string; parts: Part[]; model?: string; at?: number; uuids: string[] };
export type SysItem = { kind: "sys"; id: string; sys: Sys; at?: number };
export type Item = UserItem | InItem | AsstItem | SysItem;

export type Feed = {
  items: Item[];
  tools: Record<string, Tool>;
  tasks: Record<string, Task>;
  /** уже свёрнутые uuid: повтор истории и потока */
  seen: Record<string, true>;
  /** сообщение claude → его запись: блоки одного сообщения приходят порознь */
  byMsg: Record<string, string>;
  /** итоги инструментов, чьего вызова в ленте ещё нет: вызов — на более ранней странице истории */
  orphans: Record<string, ToolResult>;
  /** сообщение, которое пишется кусочками */
  live: { msg: string; parent: string | null } | null;
  /** задачи, чей конец уже строка ленты */
  ended: Record<string, true>;
  /** ход прерван: его итог с ошибкой — не ошибка */
  cut: boolean;
  /** стоимость в result накопительная за процесс: строка хода показывает разницу */
  cost: number;
  suggestion: string;
  compacting: boolean;
  model?: string;
  /** режим разрешений сессии */
  mode?: string;
  /** оценка токенов размышления идущего хода */
  thinking?: number;
  n: number;
};
