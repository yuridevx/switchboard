// Слова и числа ленты: одно место на подпись.
import { linkText, plural } from "@switchboard/web-ui";

/** claude-opus-5-5[1m] → «Opus 5.5»; незнакомое — как есть. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Токены целыми тысячами: 182 К, 950; неизвестно — знак вопроса. */
export const kTokens = (n?: number) => (typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)} К` : String(n)) : "?");

export const costText = (usd: number) => `$${usd.toFixed(2).replace(".", ",")}`;

export const steps = (n: number) => `${n} ${plural(n, "шаг", "шага", "шагов")}`;

/** Имя файла пути: Windows и Unix. */
export const baseName = (p?: string) => String(p ?? "").replace(/\\/g, "/").split("/").pop() ?? "";

/** Первая непустая строка, не длиннее n. */
export function firstLine(s?: string, n = 140): string {
  const l = String(s ?? "").split("\n").find((x) => x.trim()) ?? "";
  return l.length > n ? `${l.slice(0, n)}…` : l;
}

/** Отказ запроса словом для человека. */
export function refusalText(word: string, machine: string): string {
  if (word === "stopped") return "сессия остановлена";
  if (word === "sdk_error") return "Claude отказал, причина в журнале машины";
  return linkText(word, machine);
}
