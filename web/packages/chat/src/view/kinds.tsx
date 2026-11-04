// Как инструмент называется в шапке карточки: значок, подпись, суть одной строкой; раскрыт ли сразу.
import type { ReactNode } from "react";
import { Bell, Bot, CalendarClock, ClipboardList, FilePen, FilePlus, FileText, FolderSearch, GitBranch, Globe, ListChecks, MessageCircleQuestion, NotebookPen, Radar, Search, Sparkles, Square, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { Msg } from "../state/fold.ts";
import { firstLine } from "../state/words.ts";

export type Kind = { icon: ReactNode; label: string; summary: string; open?: boolean };

const I = 15;
const str = (x: unknown) => (x === undefined || x === null ? "" : String(x));
const also = (x: unknown, pre = "") => (x ? ` · ${pre}${String(x)}` : "");
const todosLine = (t: unknown) => (Array.isArray(t) ? `${(t as Msg[]).filter((x) => x.status === "completed").length} из ${t.length} готово` : "");
/** Первое из полей входа — первой непустой строкой. */
const first = (i: Msg, ...keys: string[]) => firstLine(str(keys.map((k) => i[k]).find((v) => v !== undefined && v !== null)));

const KINDS: Record<string, { icon: LucideIcon; label: string; summary(i: Msg): string; open?: boolean }> = {
  Bash: { icon: Terminal, label: "Команда", summary: (i) => first(i, "command") },
  PowerShell: { icon: Terminal, label: "PowerShell", summary: (i) => first(i, "command") },
  Edit: { icon: FilePen, label: "Правка", summary: (i) => str(i.file_path), open: true },
  MultiEdit: { icon: FilePen, label: "Правки", summary: (i) => str(i.file_path), open: true },
  Write: { icon: FilePlus, label: "Запись файла", summary: (i) => str(i.file_path) },
  NotebookEdit: { icon: NotebookPen, label: "Ячейка блокнота", summary: (i) => str(i.notebook_path) },
  Read: { icon: FileText, label: "Чтение", summary: (i) => `${str(i.file_path)}${also(i.offset, "с ")}${i.limit ? ` · ${String(i.limit)} строк` : ""}` },
  Grep: { icon: Search, label: "Поиск", summary: (i) => `${str(i.pattern)}${also(i.path)}${also(i.glob)}` },
  Glob: { icon: FolderSearch, label: "Файлы по маске", summary: (i) => `${str(i.pattern)}${also(i.path)}` },
  WebFetch: { icon: Globe, label: "Страница", summary: (i) => str(i.url) },
  WebSearch: { icon: Search, label: "Поиск в сети", summary: (i) => str(i.query) },
  TodoWrite: { icon: ListChecks, label: "Задачи", summary: (i) => todosLine(i.todos), open: true },
  Task: { icon: Bot, label: "Субагент", summary: (i) => (i.description !== undefined ? str(i.description) : first(i, "prompt")) },
  Agent: { icon: Bot, label: "Субагент", summary: (i) => (i.description !== undefined ? str(i.description) : first(i, "prompt")) },
  Skill: { icon: Sparkles, label: "Скил", summary: (i) => str(i.skill ?? i.command) },
  AskUserQuestion: { icon: MessageCircleQuestion, label: "Вопрос", summary: (i) => firstLine(str((i.questions as Msg[] | undefined)?.[0]?.question)), open: true },
  ExitPlanMode: { icon: ClipboardList, label: "План", summary: () => "", open: true },
  EnterPlanMode: { icon: ClipboardList, label: "Режим плана", summary: () => "" },
  TaskStop: { icon: Square, label: "Остановка задачи", summary: (i) => first(i, "task_id", "shell_id") },
  KillShell: { icon: Square, label: "Остановка задачи", summary: (i) => first(i, "task_id", "shell_id") },
  TaskOutput: { icon: Terminal, label: "Вывод задачи", summary: (i) => first(i, "task_id", "bash_id") },
  BashOutput: { icon: Terminal, label: "Вывод задачи", summary: (i) => first(i, "task_id", "bash_id") },
  TaskCreate: { icon: ListChecks, label: "Задачи", summary: (i) => first(i, "subject", "taskId") },
  TaskUpdate: { icon: ListChecks, label: "Задачи", summary: (i) => first(i, "subject", "taskId") },
  TaskGet: { icon: ListChecks, label: "Задачи", summary: (i) => first(i, "subject", "taskId") },
  TaskList: { icon: ListChecks, label: "Задачи", summary: (i) => first(i, "subject", "taskId") },
  Monitor: { icon: Radar, label: "Наблюдение", summary: (i) => (i.description !== undefined ? str(i.description) : first(i, "command")) },
  CronCreate: { icon: CalendarClock, label: "Расписание", summary: (i) => first(i, "prompt", "reason", "cron") },
  CronDelete: { icon: CalendarClock, label: "Расписание", summary: (i) => first(i, "prompt", "reason", "cron") },
  CronList: { icon: CalendarClock, label: "Расписание", summary: (i) => first(i, "prompt", "reason", "cron") },
  ScheduleWakeup: { icon: CalendarClock, label: "Расписание", summary: (i) => first(i, "prompt", "reason", "cron") },
  PushNotification: { icon: Bell, label: "Уведомление", summary: (i) => first(i, "message") },
  EnterWorktree: { icon: GitBranch, label: "Ворктри", summary: (i) => first(i, "name", "path", "action") },
  ExitWorktree: { icon: GitBranch, label: "Ворктри", summary: (i) => first(i, "name", "path", "action") },
};

export const isAgent = (name: string) => name === "Task" || name === "Agent";
export const isShell = (name: string) => name === "Bash" || name === "PowerShell";

/** Подпись инструмента: mcp__сервер__инструмент — «сервер · инструмент». */
export function toolWord(name: string): string {
  const k = KINDS[name];
  if (k) return k.label;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

export function kindOf(name: string, input: Msg, done: boolean): Kind {
  const k = KINDS[name];
  if (k) {
    const Icon = k.icon;
    return { icon: <Icon size={I} />, label: k.label, summary: k.summary(input), open: k.open || (isAgent(name) && !done) };
  }
  // суть незнакомого инструмента — первое строковое поле входа
  const v = Object.values(input).find((x) => typeof x === "string") as string | undefined;
  return { icon: <Wrench size={I} />, label: toolWord(name), summary: firstLine(v) };
}
