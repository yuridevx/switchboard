// Запуск процесса сборки: код выхода и весь вывод. npm — через node и npm-cli.js рядом с node: на Windows npm.cmd без оболочки не запускается.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Ran = { code: number | null; out: string };

/** Предел шага сборки — как предел передачи архива: шаг, который висит, не держит CI без конца (слово пользователя 2 нояб.). */
export const STEP_MS = 10 * 60_000;

export function run(cmd: string, args: string[], cwd: string, o: { env?: Record<string, string>; limitMs?: number } = {}): Promise<Ran> {
  const limitMs = o.limitMs ?? STEP_MS;
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, timeout: limitMs, ...(o.env ? { env: { ...process.env, ...o.env } } : {}) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => done({ code: null, out: out + e.message }));
    p.on("close", (code, signal) => done({ code, out: signal ? `${out}не завершился за ${limitMs / 1000} с\n` : out }));
    p.stdin.end();
  });
}

function npmCli(): string {
  const home = dirname(process.execPath);
  const own = process.env.npm_execpath;
  const places = [...(own?.endsWith("npm-cli.js") ? [own] : []), join(home, "node_modules", "npm", "bin", "npm-cli.js"), join(home, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const found = places.find((p) => existsSync(p));
  if (!found) throw new Error(`npm-cli.js не найден рядом с ${process.execPath}`);
  return found;
}

export const runNode = (args: string[], cwd: string) => run(process.execPath, args, cwd);
export const runNpm = (args: string[], cwd: string) => runNode([npmCli(), ...args], cwd);
