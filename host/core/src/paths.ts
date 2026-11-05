// Папки глазами клиента: «~» и «~/…» от домашней папки машины. Одно правило и туда, и обратно.
import { mkdirSync } from "node:fs";
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

/** Что из окружения машины остаётся: путь к bash на Windows. */
const KEEP = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);

/** Только свои переменные: стереть окружение Claude с машины и назначить свою папку. Ответ — имена стёртых. */
export function ownEnv(env: NodeJS.ProcessEnv, home: string): string[] {
  const dropped = Object.keys(env).filter((k) => /^(CLAUDE|ANTHROPIC)_/i.test(k) && !KEEP.has(k));
  for (const k of dropped) delete env[k];
  env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  return dropped;
}

/** Папка claude этого Host: назначает ownEnv при старте. */
export function claudeDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) throw new Error("CLAUDE_CONFIG_DIR не назначен: Host не стартовал");
  return dir;
}
