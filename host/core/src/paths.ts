// Пути машины — одно правило для ядра и модулей: папка клиента и папка Claude Code.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Папка от клиента: «~» и «~/…» — от домашней папки машины, полный путь — как есть; иначе null (отказ — словом модуля). */
export function clientPath(p: string, home: string = homedir()): string | null {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, ...p.slice(2).split("/"));
  return isAbsolute(p) ? p : null;
}

/** Папка Claude Code машины: CLAUDE_CONFIG_DIR или ~/.claude. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
