// Что зависит от ОС: где шелл, как ему отдать скрипт, как спросить версию и как погасить дерево процесса.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const SHELLS = ["bash", "pwsh", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

export const WIN = process.platform === "win32";
/** Шелл молчит на вопрос о версии: он всё равно есть; info читается с пределом 10 с. */
const VERSION_MS = 5_000;
/** taskkill ходит через WMI: под нагрузкой до 20 с (опыт 6 нояб.), снятый раньше оставляет дерево живым. Меньше предела остановки Host. */
const KILL_MS = 25_000;
const PS_ARGS = ["-NoProfile", "-NonInteractive"];
/** PowerShell 5.1 читает файл без BOM в кодировке системы и пишет вывод в ней же. */
const PS_UTF8 = "\ufeff[Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, WIN ? `${name}.exe` : name))
    .find(existsSync);

/** bash рядом с git: git.exe лежит в <Git>\\cmd, <Git>\\bin или <Git>\\mingw64\\bin. */
function besideGit(git: string): string[] {
  const up = dirname(git);
  return dirname(up) === up ? [] : [join(up, "bin", "bash.exe"), ...besideGit(up)];
}

/** bash из PATH на Windows бывает входом в WSL: Git Bash ищем как Claude Code. */
function gitBash(): string | undefined {
  const git = onPath("git");
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH ?? "", ...(git ? besideGit(git) : [])].find(existsSync);
}

export function pathOf(shell: Shell): string | undefined {
  if (!WIN || shell === "pwsh") return onPath(shell);
  if (shell === "bash") return gitBash();
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export const scriptOf = (shell: Shell, script: string) => (shell === "bash" ? { name: "script.sh", text: script } : { name: "script.ps1", text: PS_UTF8 + script });

export const argsOf = (shell: Shell, file: string) => (shell === "bash" ? [file] : [...PS_ARGS, ...(WIN ? ["-ExecutionPolicy", "Bypass"] : []), "-File", file]);

export function versionOf(shell: Shell, path: string): Promise<string | null> {
  const args = shell === "powershell" ? [...PS_ARGS, "-Command", "$PSVersionTable.PSVersion.ToString()"] : ["--version"];
  return new Promise((done) => {
    execFile(path, args, { timeout: VERSION_MS, windowsHide: true }, (_e, out) => done(/\d+(\.\d+)+/.exec(String(out))?.[0] ?? null));
  });
}

/** Всё дерево: на Linux запуск — своя группа процессов. Ответ — когда снятие кончено; строка — дерево могло остаться. */
export function killTree(pid: number): Promise<string | undefined> {
  if (WIN) {
    // код не важен: 128 и 255 — часть дерева вышла сама, живых после них нет (опыт 6 нояб.)
    return new Promise((done) => {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: KILL_MS, windowsHide: true }, (e) => done(e?.killed ? `taskkill не успел за ${KILL_MS / 1000} с` : undefined));
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группа уже вышла
  }
  return Promise.resolve(undefined);
}
