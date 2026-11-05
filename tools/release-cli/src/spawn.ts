// Процесс сборки с пределом: снят по пределу — вывод и причина в ответе.
import { spawn } from "node:child_process";

export type Ran = { code: number; out: string };

const LIMIT_MS = 10 * 60_000;
/** Вывод держит потомок: после снятия ответ ждём недолго. */
const AFTER_KILL_MS = 2_000;

export function run(cmd: string, args: string[], cwd: string, o: { limitMs?: number; env?: Record<string, string> } = {}): Promise<Ran> {
  const limit = o.limitMs ?? LIMIT_MS;
  return new Promise((done) => {
    const c = spawn(cmd, args, { cwd, env: { ...process.env, ...o.env }, shell: process.platform === "win32" && cmd === "npm", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let why = "";
    const finish = (code: number) => {
      clearTimeout(timer);
      done({ code, out: out + why });
    };
    const timer = setTimeout(() => {
      why = `${cmd}: не завершился за ${limit / 1000} с`;
      c.kill();
      setTimeout(() => finish(1), AFTER_KILL_MS).unref();
    }, limit);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", (e) => {
      why = String(e);
      finish(1);
    });
    c.on("close", (code) => finish(why ? 1 : (code ?? 1)));
  });
}
