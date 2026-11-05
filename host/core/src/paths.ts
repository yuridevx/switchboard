// Папки глазами клиента: «~» и «~/…» от домашней папки машины. Одно правило и туда, и обратно.
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

/** Папка от клиента → полный путь; относительная — null. */
export function clientPath(path: string, home: string = homedir()): string | null {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : null;
}

/** Полный путь → папка для клиента. На Windows разделитель и регистр не важны. */
export function tildePath(path: string, home: string = homedir()): string {
  const full = normalize(path).replace(/[\\/]+$/, "");
  const base = normalize(home).replace(/[\\/]+$/, "");
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  if (fold(full) === fold(base)) return "~";
  return fold(full).startsWith(fold(base) + sep) ? "~/" + full.slice(base.length + 1).split(sep).join("/") : path;
}

/** Папка claude этого процесса: CLAUDE_CONFIG_DIR или ~/.claude. */
export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
