// Пути машины — одно правило для ядра и модулей: папка клиента и папка Claude Code.
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

/** Папка от клиента: «~» и «~/…» — от домашней папки машины, полный путь — как есть; иначе null (отказ — словом модуля). */
export function clientPath(p: string, home: string = homedir()): string | null {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, ...p.slice(2).split("/"));
  return isAbsolute(p) ? p : null;
}

/** Папка для клиента: домашняя — «~», внутри неё — «~/…» через «/»; вне её — как есть. Обратное к clientPath. */
export function tildePath(p: string, home: string = homedir()): string {
  if (p === home) return "~";
  return p.startsWith(home + sep) ? "~/" + p.slice(home.length + 1).split(sep).join("/") : p;
}

/** Папка Claude Code машины: CLAUDE_CONFIG_DIR или ~/.claude. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
