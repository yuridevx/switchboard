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
  // на Windows папка приходит и с «/», и с «\» (C:/Users/admin/projects) — сравнение по одному виду, регистр диска — любой
  const norm = (x: string) => x.split(sep).join("/").replace(/\/+$/, "");
  const a = norm(p), h = norm(home);
  const same = (x: string, y: string) => (sep === "\\" ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (same(a, h)) return "~";
  return same(a.slice(0, h.length + 1), h + "/") ? "~/" + a.slice(h.length + 1) : p;
}

/** Папка Claude Code машины: CLAUDE_CONFIG_DIR или ~/.claude. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
