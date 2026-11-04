// Запуск процесса сборки: код выхода и весь вывод. npm — через node и npm-cli.js рядом с node: на Windows npm.cmd без оболочки не запускается.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Ran = { code: number | null; out: string };

export function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<Ran> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => done({ code: null, out: out + e.message }));
    p.on("close", (code) => done({ code, out }));
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
