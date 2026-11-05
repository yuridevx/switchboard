// Слова ленты: коды SDK и имена инструментов на языке человека. Незнакомое — как есть.
import { linkText, plural } from "@switchboard/web-ui";

const word = (table: Record<string, string>, key: unknown, other = String(key ?? "")) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : other);

const API_ERRORS: Record<string, string> = {
  authentication_failed: "Вход в claude не действует",
  billing_error: "Проблема с оплатой подписки",
  rate_limit: "Лимит подписки исчерпан",
  overloaded: "Серверы Anthropic перегружены",
  server_error: "Ошибка сервера Anthropic",
  invalid_request: "Запрос отклонён API",
  model_not_found: "Модель не найдена",
  max_output_tokens: "Ответ упёрся в предел длины",
  account_on_hold: "Аккаунт приостановлен",
  unknown: "Неизвестная ошибка API",
};
export const apiError = (code: unknown) => word(API_ERRORS, code);

const AREAS: Record<string, string> = { bio: "биология и химия", weapons: "оружие", self_harm: "самоповреждение", chem: "химия", cyber: "кибербезопасность" };
export const area = (code: unknown) => (code ? word(AREAS, code) : "");

const FALLBACKS: Record<string, string> = {
  model_not_found: "недоступна",
  permission_denied: "недоступна организации",
  overloaded: "перегружена",
  server_error: "не ответила (сбой сервера)",
  last_resort: "не ответила (ошибка)",
  model_blocked: "временно отключена",
};
export const fallbackWhy = (trigger: unknown) => word(FALLBACKS, trigger, "не ответила");

const ENDS: Record<string, string> = {
  error_during_execution: "сбой при выполнении",
  error_max_turns: "предел шагов",
  error_max_budget_usd: "предел бюджета",
  error_max_structured_output_retries: "предел повторов ответа",
};
export const endWhy = (subtype: unknown) => (subtype ? word(ENDS, subtype) : "ошибка");

/** claude-opus-5-5[1m] → Opus 5.5; незнакомое — без приставки claude-. */
export function modelName(id: unknown): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(String(id ?? ""));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : String(id ?? "").replace(/^claude-/, "");
}
/** Модель без пометки окна: одна и та же модель в разных записях. */
export const sameModel = (id: unknown) => String(id ?? "").replace(/\[.*\]$/, "");

/** Слово отказа действия: слова связи, слово SDK, остальное как есть. */
export function refusal(word: string, machine?: string): string {
  if (word === "sdk_error") return "Claude отказал, причина в журнале машины";
  if (word === "stopped") return "сессия остановлена";
  return linkText(word, machine);
}

/** Тысячи токенов: 84 200 → «84 К». */
export const kilo = (n: number) => `${Math.round(n / 1000)} К`;
export const steps = (n: number) => `${n} ${plural(n, "шаг", "шага", "шагов")}`;
export const money = (usd: number) => `$${usd.toFixed(2).replace(".", ",")}`;

const TASK_ENDS: Record<string, [string, string]> = { completed: ["Задача завершена", "ok"], failed: ["Задача упала", "bad"], stopped: ["Задача остановлена", "wait"], killed: ["Задача оборвана", "wait"] };
export const taskEnd = (status: unknown): [string, string] => TASK_ENDS[String(status)] ?? [`Задача: ${String(status)}`, ""];

type Shape = { word: string; icon: string; sum: string[] };
const SHAPES: Record<string, Shape> = {
  Bash: { word: "Команда", icon: "terminal", sum: ["command"] },
  PowerShell: { word: "PowerShell", icon: "terminal", sum: ["command"] },
  Edit: { word: "Правка", icon: "file-pen", sum: ["file_path"] },
  MultiEdit: { word: "Правки", icon: "file-pen", sum: ["file_path"] },
  Write: { word: "Запись файла", icon: "file-plus", sum: ["file_path"] },
  NotebookEdit: { word: "Ячейка блокнота", icon: "file-pen", sum: ["notebook_path"] },
  Read: { word: "Чтение", icon: "file-text", sum: [] },
  Grep: { word: "Поиск", icon: "search", sum: [] },
  Glob: { word: "Файлы по маске", icon: "folder-search", sum: [] },
  WebFetch: { word: "Страница", icon: "globe", sum: ["url"] },
  WebSearch: { word: "Поиск в сети", icon: "search", sum: ["query"] },
  TodoWrite: { word: "Задачи", icon: "list-checks", sum: [] },
  Agent: { word: "Субагент", icon: "bot", sum: ["description"] },
  Task: { word: "Субагент", icon: "bot", sum: ["description"] },
  Skill: { word: "Скил", icon: "sparkles", sum: ["skill", "command"] },
  AskUserQuestion: { word: "Вопрос", icon: "message-circle-question", sum: [] },
  ExitPlanMode: { word: "План", icon: "clipboard-list", sum: [] },
  EnterPlanMode: { word: "Режим плана", icon: "clipboard-list", sum: [] },
  Monitor: { word: "Наблюдение", icon: "eye", sum: ["description", "command"] },
  TaskStop: { word: "Остановка задачи", icon: "square", sum: ["task_id"] },
  KillShell: { word: "Остановка задачи", icon: "square", sum: ["shell_id"] },
  TaskOutput: { word: "Вывод задачи", icon: "terminal", sum: ["task_id"] },
  BashOutput: { word: "Вывод задачи", icon: "terminal", sum: ["bash_id"] },
  ScheduleWakeup: { word: "Расписание", icon: "clock", sum: ["reason"] },
  CronCreate: { word: "Расписание", icon: "clock", sum: ["prompt"] },
  CronDelete: { word: "Расписание", icon: "clock", sum: ["cron", "id"] },
  CronList: { word: "Расписание", icon: "clock", sum: [] },
  PushNotification: { word: "Уведомление", icon: "bell", sum: ["message"] },
  EnterWorktree: { word: "Ворктри", icon: "git-branch", sum: ["name"] },
  ExitWorktree: { word: "Ворктри", icon: "git-branch", sum: ["action"] },
  TaskCreate: { word: "Задачи", icon: "list-checks", sum: ["subject"] },
  TaskUpdate: { word: "Задачи", icon: "list-checks", sum: ["taskId"] },
  TaskGet: { word: "Задачи", icon: "list-checks", sum: ["taskId"] },
  TaskList: { word: "Задачи", icon: "list-checks", sum: [] },
};

type In = Record<string, unknown>;
const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";
const cut = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);
const firstString = (input: In) => String(Object.values(input).find((v) => typeof v === "string") ?? "");

/** Шапка карточки: слово, значок и суть входа. */
export function shapeOf(name: string, input: In = {}): { word: string; icon: string; sum: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const shape = SHAPES[name];
  if (!shape) return { word: mcp ? `${mcp[1]} · ${mcp[2]}` : name, icon: mcp ? "plug" : "wrench", sum: cut(firstLine(firstString(input))) };
  let sum = String(shape.sum.map((k) => input[k]).find((v) => v !== undefined && v !== "") ?? "");
  if (name === "Read") sum = [input.file_path, input.offset ? `с ${input.offset}` : "", input.limit ? `${input.limit} строк` : ""].filter(Boolean).join(" · ");
  if (name === "Grep" || name === "Glob") sum = [input.pattern, input.path, input.glob].filter(Boolean).join(" · ");
  if (name === "TodoWrite") {
    const todos = (input.todos ?? []) as Array<{ status?: string }>;
    sum = `${todos.filter((t) => t.status === "completed").length} из ${todos.length} готово`;
  }
  if (name === "AskUserQuestion") sum = String((input.questions as Array<{ question?: string }> | undefined)?.[0]?.question ?? "");
  return { word: shape.word, icon: shape.icon, sum: cut(firstLine(sum)) };
}

/** Раздел контекста SDK → подпись. */
const PARTS: Record<string, string> = {
  Messages: "Разговор",
  Skills: "Скилы",
  "Custom agents": "Свои агенты",
  "Autocompact buffer": "Запас на сжатие",
  "System prompt": "Системный промпт",
  "System tools": "Инструменты",
  "MCP tools": "Инструменты MCP",
  "Memory files": "Память",
  "Free space": "Свободно",
};
export const contextPart = (name: string) => word(PARTS, name);

const STATUS: Record<string, string> = {
  "Session name": "Имя",
  "Session ID": "Номер",
  "Session kind": "Вид",
  Organization: "Организация",
  Email: "Почта",
  "MCP servers": "MCP",
  "Setting sources": "Настройки",
  Memory: "Память",
};
export const statusLabel = (label: string) => word(STATUS, label);
export const RULE_WORDS: Record<string, string> = { allow: "можно", deny: "нельзя", ask: "спросить" };
