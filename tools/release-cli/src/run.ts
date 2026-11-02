// Запуск node и npm дочерним процессом. npm — через node и npm-cli.js рядом с node: на Windows npm.cmd без оболочки не запускается.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type RunResult = { code: number | null; out: string };

/** Путь к npm-cli.js: из npm_execpath или рядом с node. Нет — исключение. */
export function npmCli(): string {
  const env = process.env.npm_execpath;
  const nodeDir = dirname(process.execPath);
  const cands = [
    ...(env && env.endsWith("npm-cli.js") ? [env] : []),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const f = cands.find((p) => existsSync(p));
  if (!f) throw new Error(`npm-cli.js не найден рядом с ${process.execPath}`);
  return f;
}

/** node с аргументами в папке cwd: код выхода и весь вывод. */
export function runNode(args: string[], cwd: string, o: { signal?: AbortSignal; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  return new Promise((res) => {
    const p = spawn(process.execPath, args, { cwd, env: o.env ?? process.env, windowsHide: true, ...(o.signal ? { signal: o.signal } : {}) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => res({ code: null, out: out + e.message }));
    p.on("close", (code) => res({ code, out }));
    p.stdin.end();
  });
}

/** npm с аргументами в папке cwd. */
export function runNpm(args: string[], cwd: string, o: { signal?: AbortSignal } = {}): Promise<RunResult> {
  return runNode([npmCli(), ...args], cwd, o);
}
