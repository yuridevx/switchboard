// Вопрос сессии в памяти модуля: формы без поведения; их берут и стор, и разбор кадра.
import type { Frame } from "@switchboard/web-core";

/** Вопрос AskUserQuestion: 1–4 на кадр, по 2–4 варианта; «Свой ответ» есть всегда. */
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

export type Status = "waiting" | "sending" | "ok" | "late" | "cancelled" | "gone" | "error";

/** Вопрос сессии в памяти модуля. */
export type Rec = {
  id: string;
  callsign: string;
  kind: string;
  questions: Question[];
  /** форма MCP: message, schema, url, server */
  frame: Frame;
  to: string[];
  at: number;
  status: Status;
  error?: string;
  /** кто ответил и что — из answered или свой ответ */
  by?: string;
  answers?: Record<string, string>;
};
