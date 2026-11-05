// Всё, что зависит от ОС: где шелл, как его запустить и спросить версию, как убить дерево.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type ShellName = "bash" | "pwsh" | "powershell";
export const SHELLS: ShellName[] = ["bash", "pwsh", "powershell"];

const WIN = process.platform === "win32";
/** Предел ответа шелла на вопрос о версии: меньше предела чтения инструмента info (10 с). */
const VERSION_MS = 8_000;
const POWERSHELL = ["-NoProfile", "-NonInteractive"];
/** PowerShell 5.1 читает файл без BOM в кодировке системы и пишет вывод в ней же. */
const PS_UTF8 = "\ufeff[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)\n";

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, WIN ? `${name}.exe` : name));

function candidates(name: ShellName): string[] {
  if (!WIN) return onPath(name);
  if (name === "pwsh") return onPath(name);
  if (name === "powershell") return [...onPath(name), join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
  // bash из System32 — запуск WSL, а не Git Bash: путь как у Claude Code, переменная и папка Git
  const fromGit = onPath("git").map((git) => join(dirname(dirname(git)), "bin", "bash.exe"));
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH ?? "", ...fromGit, join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")];
}

export const findShell = (name: ShellName): string | undefined => candidates(name).find((path) => path && existsSync(path));

/** Версия шелла; не ответил за предел — «?»: шелл всё равно есть. */
export function shellVersion(name: ShellName, path: string, signal: AbortSignal): Promise<string> {
  const args = name === "bash" ? ["--version"] : [...POWERSHELL, "-Command", "$PSVersionTable.PSVersion.ToString()"];
  return new Promise((resolve) => {
    const child = spawn(path, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal });
    let out = "";
    const answer = () => {
      clearTimeout(limit);
      child.stdout.destroy();
      child.kill();
      resolve(/\d+(\.\d+)+/.exec(out)?.[0] ?? "?");
    };
    const limit = setTimeout(answer, VERSION_MS);
    child.stdout.on("data", (d) => {
      out += d;
      if (/\d+(\.\d+)+/.test(out)) answer();
    });
    child.on("close", answer);
    child.on("error", answer);
  });
}

/** Запустить скрипт из файлов папки запуска: вывод — в файлы, поэтому фоновый ребёнок не держит конец запуска. */
export function startShell(name: ShellName, path: string, dir: string, script: string, stdin: string | undefined, out: string) {
  const file = join(dir, name === "bash" ? "script.sh" : "script.ps1");
  writeFileSync(file, name === "bash" ? script : PS_UTF8 + script);
  const args = name === "bash" ? [file] : [...POWERSHELL, "-ExecutionPolicy", "Bypass", "-File", file];
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
    spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группы уже нет: запуск кончился
  }
}
