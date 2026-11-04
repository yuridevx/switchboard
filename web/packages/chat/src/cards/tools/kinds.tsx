// Как инструмент называется в шапке карточки: значок, подпись, суть одной строкой; раскрыт ли сразу.
import type { ReactNode } from "react";
import { Bell, Bot, CalendarClock, ClipboardList, FilePen, FilePlus, FileText, FolderSearch, GitBranch, Globe, ListChecks, MessageCircleQuestion, NotebookPen, Radar, Search, Sparkles, Square, Terminal, Wrench } from "lucide-react";
import type { Tool } from "../../state/types.ts";
import type { ToolInput } from "../../state/wire.ts";
import { firstLine } from "../format.ts";

export type Kind = { icon: ReactNode; label: string; summary: string; open?: boolean };
type Named = { name: string; input: ToolInput; result?: Tool["result"] };

const I = 15;
/** Отказ человека словами claude — не «Permission denied» в выводе команды. */
export const isRefused = (text: string) => /^(The user doesn't want to proceed|User rejected|Permission to use .+ has been denied)/.test(text);
/** Причина человека без обёртки claude; нет причины — пусто: отказ уже назван в шапке карточки. */
export const refusalReason = (text: string) => /Reason: ([\s\S]*)$/.exec(text)?.[1].trim() ?? "";
export const isAgent = (t: Named) => t.name === "Task" || t.name === "Agent";
export const isShell = (t: Named) => t.name === "Bash" || t.name === "PowerShell";
const todosLine = (t?: ToolInput["todos"]) => (Array.isArray(t) ? `${t.filter((x) => x.status === "completed").length} из ${t.length} готово` : "");

export function kindOf(t: Named): Kind {
  const i = t.input ?? {};
  switch (t.name) {
    case "Bash":
      return { icon: <Terminal size={I} />, label: "Команда", summary: firstLine(i.command) };
    case "PowerShell":
      return { icon: <Terminal size={I} />, label: "PowerShell", summary: firstLine(i.command) };
    case "Edit":
      return { icon: <FilePen size={I} />, label: "Правка", summary: i.file_path ?? "", open: true };
    case "MultiEdit":
      return { icon: <FilePen size={I} />, label: "Правки", summary: i.file_path ?? "", open: true };
    case "Write":
      return { icon: <FilePlus size={I} />, label: "Запись файла", summary: i.file_path ?? "" };
    case "NotebookEdit":
      return { icon: <NotebookPen size={I} />, label: "Ячейка блокнота", summary: i.notebook_path ?? "" };
    case "Read":
      return { icon: <FileText size={I} />, label: "Чтение", summary: `${i.file_path ?? ""}${i.offset ? ` · с ${i.offset}` : ""}${i.limit ? ` · ${i.limit} строк` : ""}` };
    case "Grep":
      return { icon: <Search size={I} />, label: "Поиск", summary: `${i.pattern ?? ""}${i.path ? ` · ${i.path}` : ""}${i.glob ? ` · ${i.glob}` : ""}` };
    case "Glob":
      return { icon: <FolderSearch size={I} />, label: "Файлы по маске", summary: `${i.pattern ?? ""}${i.path ? ` · ${i.path}` : ""}` };
    case "WebFetch":
      return { icon: <Globe size={I} />, label: "Страница", summary: i.url ?? "" };
    case "WebSearch":
      return { icon: <Search size={I} />, label: "Поиск в сети", summary: i.query ?? "" };
    case "TodoWrite":
      return { icon: <ListChecks size={I} />, label: "Задачи", summary: todosLine(i.todos), open: true };
    case "Task":
    case "Agent":
      return { icon: <Bot size={I} />, label: "Субагент", summary: i.description ?? firstLine(i.prompt), open: !t.result };
    case "Skill":
      return { icon: <Sparkles size={I} />, label: "Скил", summary: i.skill ?? i.command ?? "" };
    case "AskUserQuestion":
      return { icon: <MessageCircleQuestion size={I} />, label: "Вопрос", summary: firstLine(i.questions?.[0]?.question), open: true };
    case "ExitPlanMode":
      return { icon: <ClipboardList size={I} />, label: "План", summary: "", open: true };
    case "EnterPlanMode":
      return { icon: <ClipboardList size={I} />, label: "Режим плана", summary: "" };
    case "TaskStop":
    case "KillShell":
      return { icon: <Square size={I} />, label: "Остановка задачи", summary: firstLine(String(i.task_id ?? i.shell_id ?? "")) };
    case "TaskOutput":
    case "BashOutput":
      return { icon: <Terminal size={I} />, label: "Вывод задачи", summary: firstLine(String(i.task_id ?? i.bash_id ?? "")) };
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskGet":
    case "TaskList":
      return { icon: <ListChecks size={I} />, label: "Задачи", summary: firstLine(String(i.subject ?? i.taskId ?? "")) };
    case "Monitor":
      return { icon: <Radar size={I} />, label: "Наблюдение", summary: i.description ?? firstLine(i.command) };
    case "CronCreate":
    case "CronDelete":
    case "CronList":
    case "ScheduleWakeup":
      return { icon: <CalendarClock size={I} />, label: "Расписание", summary: firstLine(String(i.prompt ?? i.reason ?? i.cron ?? "")) };
    case "PushNotification":
      return { icon: <Bell size={I} />, label: "Уведомление", summary: firstLine(String(i.message ?? "")) };
    case "EnterWorktree":
    case "ExitWorktree":
      return { icon: <GitBranch size={I} />, label: "Ворктри", summary: firstLine(String(i.name ?? i.path ?? i.action ?? "")) };
    default: {
      // mcp__сервер__инструмент — «сервер · инструмент»; суть — первое строковое поле входа
      const m = /^mcp__(.+?)__(.+)$/.exec(t.name);
      const v = Object.values(i).find((x) => typeof x === "string") as string | undefined;
      return { icon: <Wrench size={I} />, label: m ? `${m[1]} · ${m[2]}` : t.name, summary: firstLine(v) };
    }
  }
}
