// Подписи вопроса: одно место для метки строки, экрана и строки «что разрешим». Без React.
import { PERM_PLACES, permModeName } from "@switchboard/web-ui";
import type { Question } from "./store.ts";

export const PLAN_TOOL = "ExitPlanMode";

/** Поля входа, которые говорят, что инструмент сделает. */
const SUBJECT = ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "prompt"];

export function subjectOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const k = SUBJECT.find((x) => typeof rec[x] === "string");
  return k ? String(rec[k]) : "";
}

/** Текст метки asked: строка списка и карточка «Вам». */
export function markOf(q: Question): string {
  if (q.kind === "perm") {
    if (q.tool === PLAN_TOOL) return "План на одобрение";
    if (q.title) return q.title;
    const subject = subjectOf(q.input);
    return subject ? `${q.tool}: ${subject}` : String(q.tool);
  }
  return q.questions?.[0]?.question ?? q.message ?? "форма";
}

type Suggestion = { type?: string; destination?: string; mode?: string; directories?: string[]; rules?: Array<{ toolName: string; ruleContent?: string }> };

/** Что предложил SDK на «Разрешать всегда»: строка на предложение — что разрешается и куда ляжет. Своих правил страница не строит. */
export function suggestionLines(suggestions: unknown[] | undefined): string[] {
  return ((suggestions ?? []) as Suggestion[]).map((x) => {
    const what = x.type === "setMode" ? (permModeName(x.mode ?? "") ?? x.mode) : x.directories ? x.directories.join(", ") : (x.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(", ");
    return `${what} · ${PERM_PLACES[x.destination ?? ""] ?? x.destination}`;
  });
}
