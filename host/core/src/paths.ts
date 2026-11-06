// Папки глазами клиента и папка Claude этого Host.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const win = process.platform === "win32";
const slashed = (p: string) => (win ? p.replaceAll("\\", "/") : p).replace(/\/+$/, "");
const folded = (p: string) => (win ? p.toLowerCase() : p);

/** Папка от клиента: «~» и «~/…» — от домашней, полный путь как есть, иначе null. */
export function clientPath(path: string, home = homedir()): string | null {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : null;
}

/** Обратное к clientPath: папка внутри домашней — от «~» через «/», остальное как есть. На Windows регистр и вид косой черты не важны. */
export function tildePath(path: string, home = homedir()): string {
  const p = slashed(path);
  const h = slashed(home);
  if (folded(p) === folded(h)) return "~";
  return folded(p).startsWith(`${folded(h)}/`) ? `~${p.slice(h.length)}` : path;
}

/** Своя папка Claude: её ставит ядро на старте, стандартной на Host нет. */
export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR!;
