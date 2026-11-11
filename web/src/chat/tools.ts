// Инструменты claude: таблица подписей — одна на Host и страницу, в протоколе; здесь — только то, что нужно карточке ленты.
import { toolLook, type ToolBody } from "@sb/protocol";
import type { Msg, Task, Tool } from "./fold.ts";

export { toolLook };
export type Body = ToolBody;

const DENIED = /^(The user doesn't want to proceed with this tool use\.|User rejected|The user rejected)/;
export const isShell = (tool: Tool) => tool.name === "Bash" || tool.name === "PowerShell";
export const isAgent = (tool: Tool) => toolLook(tool).body === "agent";
export const isDenied = (tool: Tool) => !!tool.result?.error && DENIED.test(tool.result.text);
/** Причина отказа человека: текст после Reason:. */
export const deniedWhy = (tool: Tool) => /Reason:\s*([\s\S]*)$/.exec(tool.result?.text ?? "")?.[1] ?? "";

const resultState = (tool: Tool) => (isDenied(tool) ? "denied" : tool.result?.error ? "error" : "ok");

export function toolState(tool: Tool, task: Task | undefined, waiting: boolean): string {
  if (waiting) return "wait";
  if (task) {
    if (task.end === "stopped" || task.end === "killed") return "stopped";
    if (!task.end) return task.bg ? "bg" : tool.result && !isAgent(tool) ? resultState(tool) : "running";
  }
  return tool.result ? resultState(tool) : "running";
}

/** Сколько строк добавила и убрала правка: по вводу Edit, MultiEdit и Write. */
export function editStat(tool: Tool): { plus: number; minus: number } | null {
  const i = tool.input ?? {};
  const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);
  if (tool.name === "Edit") return { plus: lines(i.new_string), minus: lines(i.old_string) };
  if (tool.name === "MultiEdit") return ((i.edits ?? []) as Msg[]).reduce<{ plus: number; minus: number }>((a, e) => ({ plus: a.plus + lines(e.new_string), minus: a.minus + lines(e.old_string) }), { plus: 0, minus: 0 });
  if (tool.name === "Write") return { plus: lines(i.content), minus: 0 };
  return null;
}

/** Сколько шагов сделал субагент: вызовы инструментов в его карточке. */
export const agentSteps = (tool: Tool, task?: Task): number => task?.steps ?? tool.steps.reduce((n, r) => n + (r.k === "reply" ? r.parts.filter((p) => p.k === "tool").length : 0), 0);

/** Метка «в фоне» без задачи или у кончившейся. */
export const startedInBackground = (tool: Tool, task?: Task) => (task ? task.bg && !!task.end : tool.input?.run_in_background === true || /^Command running in background/.test(tool.result?.text ?? ""));
