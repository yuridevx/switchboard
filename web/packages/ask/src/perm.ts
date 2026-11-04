// Запрос разрешения в кадре question: поля и суть. Форма кадра — у модуля questions на Host.
import type { Rec } from "./store.ts";

export type PermFrame = {
  tool: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  reason?: string;
  blockedPath?: string;
  suggestions?: unknown[];
};

export const permFrame = (r: Rec) => r.frame as unknown as PermFrame;
export const isPlan = (f: PermFrame) => f.tool === "ExitPlanMode";

/** Поля входа, которые говорят, что инструмент сделает. */
const MAIN = ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "prompt"];

export function subjectOf(f: PermFrame): string {
  const k = MAIN.find((x) => typeof f.input[x] === "string");
  return k ? String(f.input[k]) : "";
}

/** Строка списка: заголовок SDK или инструмент и суть. */
export function permLine(f: PermFrame): string {
  if (isPlan(f)) return "План на одобрение";
  if (f.title) return f.title;
  const s = subjectOf(f);
  return s ? `${f.tool}: ${s}` : f.tool;
}
