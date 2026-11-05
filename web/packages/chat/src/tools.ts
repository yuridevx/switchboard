// Инструменты claude одной таблицей: подпись, значок, суть одной строкой, что раскрыто сразу и как рисовать тело.
import { DENIED } from "./words.ts";
import type { Msg, Task, Tool } from "./fold.ts";

export type ToolState = "running" | "ok" | "error" | "denied" | "bg" | "stopped" | "wait";
export type Body = "command" | "diff" | "read" | "todos" | "ask" | "plan" | "agent" | "output" | "plain";
/** keys — поля входа для сути; body — вид тела; open — раскрыто сразу. */
type Kind = { word: string; icon: string; keys?: string[]; body?: Body; open?: boolean };

const AGENT: Kind = { word: "Субагент", icon: "bot", keys: ["description"], body: "agent" };
const SEARCH = { icon: "search", body: "output" as const };
const TASKS: Kind = { word: "Задачи", icon: "list-checks", keys: ["subject", "taskId"] };
const CRON: Kind = { word: "Расписание", icon: "calendar-clock", keys: ["reason", "prompt", "cron"] };
const STOP_TASK: Kind = { word: "Остановка задачи", icon: "square", keys: ["task_id", "shell_id"] };
const OUTPUT_OF: Kind = { word: "Вывод задачи", icon: "terminal", keys: ["task_id", "bash_id"] };
const WORKTREE: Kind = { word: "Ворктри", icon: "git-branch", keys: ["name", "action"] };

const KINDS: Record<string, Kind> = {
  Bash: { word: "Команда", icon: "terminal", keys: ["command"], body: "command" },
  PowerShell: { word: "PowerShell", icon: "terminal", keys: ["command"], body: "command" },
  Edit: { word: "Правка", icon: "file-pen", keys: ["file_path"], body: "diff", open: true },
  MultiEdit: { word: "Правки", icon: "file-pen", keys: ["file_path"], body: "diff", open: true },
  Write: { word: "Запись файла", icon: "file-plus", keys: ["file_path"], body: "diff" },
  NotebookEdit: { word: "Ячейка блокнота", icon: "notebook-pen", keys: ["notebook_path"], body: "diff" },
  Read: { word: "Чтение", icon: "file-text", body: "read" },
  Grep: { word: "Поиск", ...SEARCH, keys: ["pattern", "path", "glob"] },
  Glob: { word: "Файлы по маске", icon: "folder-search", keys: ["pattern", "path"], body: "output" },
  WebFetch: { word: "Страница", icon: "globe", keys: ["url"], body: "output" },
  WebSearch: { word: "Поиск в сети", icon: "search", keys: ["query"], body: "output" },
  TodoWrite: { word: "Задачи", icon: "list-checks", body: "todos", open: true },
  Agent: AGENT,
  Task: AGENT,
  Skill: { word: "Скил", icon: "sparkles", keys: ["skill", "command"], body: "output" },
  AskUserQuestion: { word: "Вопрос", icon: "message-circle-question", body: "ask", open: true },
  ExitPlanMode: { word: "План", icon: "clipboard-list", body: "plan", open: true },
  EnterPlanMode: { word: "Режим плана", icon: "clipboard-list" },
  Monitor: { word: "Наблюдение", icon: "radar", keys: ["description", "command"] },
  TaskStop: STOP_TASK,
  KillShell: STOP_TASK,
  TaskOutput: OUTPUT_OF,
  BashOutput: OUTPUT_OF,
  TaskCreate: TASKS,
  TaskUpdate: TASKS,
  TaskGet: TASKS,
  TaskList: TASKS,
  ScheduleWakeup: CRON,
  CronCreate: CRON,
  CronDelete: CRON,
  CronList: CRON,
  PushNotification: { word: "Уведомление", icon: "bell", keys: ["message"] },
  EnterWorktree: WORKTREE,
  ExitWorktree: WORKTREE,
};

const SUM_MAX = 140;

/** Первая непустая строка, обрезанная по пределу. */
function short(text: unknown): string {
  const first = String(text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return first.length > SUM_MAX ? `${first.slice(0, SUM_MAX)}…` : first;
}

function summary(name: string, input: Msg, keys?: string[]): string {
  if (name === "Read") return [input.file_path, input.offset ? `с ${input.offset}` : "", input.limit ? `${input.limit} строк` : ""].filter(Boolean).join(" · ");
  if (name === "TodoWrite") {
    const todos = (input.todos ?? []) as Array<{ status?: string }>;
    return `${todos.filter((t) => t.status === "completed").length} из ${todos.length} готово`;
  }
  if (name === "AskUserQuestion") return short(input.questions?.[0]?.question);
  if (keys) {
    // одно поле — первое из есть; поиск — все
    const present = keys.filter((k) => input[k]).map((k) => short(input[k]));
    return name === "Grep" || name === "Glob" ? present.join(" · ") : (present[0] ?? "");
  }
  return short(Object.values(input).find((v) => typeof v === "string"));
}

/** Подпись, значок и суть инструмента. */
export function toolLook(tool: Tool | undefined) {
  const name = tool?.name ?? "";
  const input = tool?.input ?? {};
  const known = KINDS[name];
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const word = known?.word ?? (mcp ? `${mcp[1]} · ${mcp[2]}` : name);
  return { word, icon: known?.icon ?? "wrench", body: known?.body ?? "plain", open: !!known?.open, sum: summary(name, input, known ? (known.keys ?? []) : undefined) };
}

const SHELLS = new Set(["Bash", "PowerShell"]);
export const isShell = (tool: Tool) => SHELLS.has(String(tool.name));
export const isAgent = (tool: Tool) => toolLook(tool).body === "agent";
export const isDenied = (tool: Tool) => !!tool.result?.error && DENIED.test(tool.result.text);
/** Причина отказа человека: текст после Reason:. */
export const deniedWhy = (tool: Tool) => /Reason:\s*([\s\S]*)$/.exec(tool.result?.text ?? "")?.[1] ?? "";

export function toolState(tool: Tool, task: Task | undefined, waiting: boolean): ToolState {
  if (waiting) return "wait";
  if (task) {
    if (task.end === "stopped" || task.end === "killed") return "stopped";
    if (!task.end) return task.bg ? "bg" : tool.result && !isAgent(tool) ? resultState(tool) : "running";
  }
  return tool.result ? resultState(tool) : "running";
}

const resultState = (tool: Tool): ToolState => (isDenied(tool) ? "denied" : tool.result?.error ? "error" : "ok");

/** Метка «в фоне» без задачи. */
export const startedInBackground = (tool: Tool, task?: Task) => (task ? task.bg && !!task.end : tool.input?.run_in_background === true || /^Command running in background/.test(tool.result?.text ?? ""));

