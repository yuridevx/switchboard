// Всё, что зависит от ОС: где шелл, как его запустить и спросить версию, как убить дерево.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { READ_MS } from "@switchboard/protocol";

export type ShellName = "bash" | "pwsh" | "powershell";
export const SHELLS: ShellName[] = ["bash", "pwsh", "powershell"];

const WIN = process.platform === "win32";
const POWERSHELL = ["-NoProfile", "-NonInteractive"];
/** PowerShell 5.1 читает файл без BOM в кодировке системы и пишет вывод в ней же. */
const PS_UTF8 = "\ufeff[Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, WIN ? `${name}.exe` : name));

/** bash рядом с git: git.exe лежит в <Git>\\cmd, <Git>\\bin или <Git>\\mingw64\\bin. */
function besideGit(git: string): string[] {
  const up = dirname(git);
  return dirname(up) === up ? [] : [join(up, "bin", "bash.exe"), ...besideGit(up)];
}

function candidates(name: ShellName): string[] {
  if (!WIN) return name === "powershell" ? [] : onPath(name);
  if (name === "pwsh") return onPath(name);
  if (name === "powershell") return [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
  // bash из PATH на Windows бывает входом в WSL: Git Bash ищем как Claude Code
  const git = onPath("git").find((path) => existsSync(path));
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH ?? "", ...(git ? besideGit(git) : [])];
}

export const findShell = (name: ShellName): string | undefined => candidates(name).find((path) => path && existsSync(path));

/** Версия шелла; не ответил за предел чтения — null: шелл всё равно есть. */
export function shellVersion(name: ShellName, path: string): Promise<string | null> {
  const args = name === "powershell" ? [...POWERSHELL, "-Command", "$PSVersionTable.PSVersion.ToString()"] : ["--version"];
  return new Promise((resolve) => execFile(path, args, { windowsHide: true, timeout: READ_MS }, (_e, out) => resolve(/\d+(\.\d+)+/.exec(String(out ?? ""))?.[0] ?? null)));
}

/** Запустить скрипт из файлов папки запуска: вывод — в файлы, поэтому фоновый ребёнок не держит конец запуска. */
export function startShell(name: ShellName, path: string, dir: string, script: string, stdin: string | undefined, out: string) {
  const file = join(dir, name === "bash" ? "script.sh" : "script.ps1");
  writeFileSync(file, name === "bash" ? script : PS_UTF8 + script);
  const args = name === "bash" ? [file] : [...POWERSHELL, ...(WIN ? ["-ExecutionPolicy", "Bypass"] : []), "-File", file];
  if (stdin !== undefined) writeFileSync(join(dir, "stdin"), stdin);
  const fds = [stdin === undefined ? null : openSync(join(dir, "stdin"), "r"), openSync(join(dir, "stdout"), "w"), openSync(join(dir, "stderr"), "w")];
  try {
    return spawn(path, args, {
      cwd: homedir(),
      env: { ...process.env, SB_OUT: out },
      stdio: [fds[0] ?? "ignore", fds[1]!, fds[2]!],
      // своя группа: kill дерева на Linux идёт по ней
      detached: !WIN,
      windowsHide: true,
    });
  } finally {
    for (const fd of fds) if (fd !== null) closeSync(fd);
  }
}

export function killTree(pid: number): void {
  if (WIN) {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группы уже нет: запуск кончился
  }
}
