// Процесс сборки с пределом: вывод и причина — в ответе.
import { spawn } from "node:child_process";

export type Done = { code: number | null; out: string };

const LIMIT_MS = 10 * 60_000;
/** Снятый процесс оставляет потомка с тем же выводом: close может не прийти, ответ ждём недолго. */
const GRACE_MS = 2_000;

export function run(cmd: string, args: string[], cwd: string, o: { limitMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Done> {
  const { limitMs = LIMIT_MS, env } = o;
  return new Promise((done) => {
    // npm на Windows — файл .cmd: без оболочки он не запускается
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: cmd === "npm" && process.platform === "win32", windowsHide: true });
    let out = "";
    const add = (chunk: Buffer) => void (out += chunk);
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const limit = setTimeout(() => {
      out += `\n${cmd} не завершился за ${limitMs / 1000} с`;
      child.kill();
      setTimeout(() => end(null), GRACE_MS).unref();
    }, limitMs);
    const end = (code: number | null) => {
      clearTimeout(limit);
      done({ code, out });
    };
    child.on("error", (e) => {
      out += String(e);
      end(null);
    });
    child.on("close", end);
  });
}
