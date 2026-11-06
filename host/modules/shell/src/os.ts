// Что зависит от ОС: где шелл, как ему отдать скрипт, как спросить версию и как погасить дерево процесса.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const SHELLS = ["bash", "pwsh", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

export const WIN = process.platform === "win32";
/** Запас на вопрос о версии: info читается с пределом 10 с. */
const VERSION_MS = 5_000;
export const KILL_MS = 5_000;
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, WIN ? `${name}.exe` : name))
    .find(existsSync);

/** Git Bash: bash.exe из PATH на Windows бывает входом в WSL. */
function gitBash(): string | undefined {
  const set = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && existsSync(set)) return set;
  return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((d) => d !== undefined).map((d) => join(d, "Git", "bin", "bash.exe")).find(existsSync);
}

export function pathOf(shell: Shell): string | undefined {
  if (!WIN || shell === "pwsh") return onPath(shell);
  if (shell === "bash") return gitBash();
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Файл скрипта. PowerShell 5.1 читает файл без BOM в кодировке системы и пишет вывод в ней же. */
export const scriptOf = (shell: Shell, script: string) => (shell === "bash" ? { name: "script.sh", text: script } : { name: "script.ps1", text: `\ufeff[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}` });

export const argsOf = (shell: Shell, file: string) => (shell === "bash" ? [file] : [...PS_ARGS, "-File", file]);

export function versionOf(shell: Shell, path: string, signal: AbortSignal): Promise<string> {
  const args = shell === "bash" ? ["--version"] : [...PS_ARGS, "-Command", "$PSVersionTable.PSVersion.ToString()"];
  return new Promise((done) => {
    execFile(path, args, { timeout: VERSION_MS, signal, windowsHide: true }, (_e, out) => done(/\d+(\.\d+)+/.exec(String(out))?.[0] ?? ""));
  });
}

/** Всё дерево: на Linux запуск — своя группа процессов. */
export function killTree(pid: number): void {
  if (WIN) {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: KILL_MS, windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группа уже вышла
  }
}
