// Инструменты claude одной таблицей — общей для страницы и Host: подпись по-русски, значок, суть одной строкой, как рисовать тело.
// Страница берёт отсюда вид карточки инструмента, Host — строку «чем занят ход» в картине флота.

export type ToolBody = "command" | "diff" | "read" | "todos" | "ask" | "plan" | "agent" | "output" | "plain";
export type ToolKind = { word: string; icon: string; keys?: string[]; body?: ToolBody; open?: boolean };
type Input = Record<string, any>;

const AGENT: ToolKind = { word: "Субагент", icon: "bot", keys: ["description"], body: "agent" };
const TASKS: ToolKind = { word: "Задачи", icon: "list-checks", keys: ["subject", "taskId"] };
const CRON: ToolKind = { word: "Расписание", icon: "calendar-clock", keys: ["reason", "prompt", "cron"] };
const STOP_TASK: ToolKind = { word: "Остановка задачи", icon: "square", keys: ["task_id", "shell_id"] };
const OUTPUT_OF: ToolKind = { word: "Вывод задачи", icon: "terminal", keys: ["task_id", "bash_id"] };
const WORKTREE: ToolKind = { word: "Ворктри", icon: "git-branch", keys: ["name", "action"] };

export const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: { word: "Команда", icon: "terminal", keys: ["command"], body: "command" },
  PowerShell: { word: "PowerShell", icon: "terminal", keys: ["command"], body: "command" },
  Edit: { word: "Правка", icon: "file-pen", keys: ["file_path"], body: "diff", open: true },
  MultiEdit: { word: "Правки", icon: "file-pen", keys: ["file_path"], body: "diff", open: true },
  Write: { word: "Запись файла", icon: "file-plus", keys: ["file_path"], body: "diff" },
  NotebookEdit: { word: "Ячейка блокнота", icon: "notebook-pen", keys: ["notebook_path"], body: "diff" },
  Read: { word: "Чтение", icon: "file-text", body: "read" },
  Grep: { word: "Поиск", icon: "search", body: "output", keys: ["pattern", "path", "glob"] },
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
  ToolSearch: { word: "Поиск инструмента", icon: "search", keys: ["query"] },
};

const SUM_MAX = 140;
/** Первая непустая строка, обрезанная по пределу. */
function short(text: unknown): string {
  const first = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.length > SUM_MAX ? `${first.slice(0, SUM_MAX)}…` : first;
}

/** Суть вызова одной строкой: главный довод инструмента. */
export function toolSummary(name: string, input: Input = {}, keys: string[] | undefined = TOOL_KINDS[name]?.keys ?? (TOOL_KINDS[name] ? [] : undefined)): string {
  if (name === "Read") return [input.file_path, input.offset ? `с ${input.offset}` : "", input.limit ? `${input.limit} строк` : ""].filter(Boolean).join(" · ");
  if (name === "TodoWrite") {
    const todos = (input.todos ?? []) as Input[];
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

/** Подпись инструмента по-русски; инструмент сервера MCP — «сервер · инструмент»; незнакомый — как назван. */
export function toolWord(name: string): string {
  const known = TOOL_KINDS[name];
  if (known) return known.word;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** Подпись, значок, суть и вид тела — всё, что нужно карточке инструмента. */
export function toolLook(tool: { name?: string; input?: Input } | undefined) {
  const name = tool?.name ?? "";
  const known = TOOL_KINDS[name];
  return { word: toolWord(name), icon: known?.icon ?? "wrench", body: (known?.body ?? "plain") as ToolBody, open: !!known?.open, sum: toolSummary(name, tool?.input ?? {}) };
}

/** «Чем занят ход» одной строкой для картины флота: подпись и суть. */
export function toolLine(name: string, input: Input = {}, max = 120): string {
  const sum = toolSummary(name, input);
  const line = sum ? `${toolWord(name)} ${sum}` : toolWord(name);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
