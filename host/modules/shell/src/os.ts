// ОС под модулем shell: какие шеллы есть, запуск скрипта файлом с выводом прямо в файлы папки запуска,
// убийство всего дерева процесса, файлы $SB_OUT. Решений о запуске здесь нет.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, relative } from "node:path";
import type { Attachment } from "@switchboard/host";

export const SHELLS = ["bash", "pwsh", "powershell"] as const;
export type ShellName = (typeof SHELLS)[number];

const WINDOWS = process.platform === "win32";

/** Файл в PATH; на Windows — с расширениями PATHEXT. */
function inPath(name: string): string | null {
  const exts = WINDOWS ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const path = join(dir, WINDOWS && extname(name) ? name : name + ext);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** bash на Windows — Git Bash, как у Claude Code: CLAUDE_CODE_GIT_BASH_PATH или bin\bash.exe рядом с git из PATH; bash из PATH на Windows бывает входом в WSL — его не берём. */
function gitBash(): string | null {
  const env = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (env && existsSync(env)) return env;
  const git = inPath("git.exe");
  if (!git) return null;
  // git.exe лежит в <Git>\cmd, <Git>\bin или <Git>\mingw64\bin
  for (let dir = dirname(git); dirname(dir) !== dir; dir = dirname(dir)) {
    const bash = join(dir, "bin", "bash.exe");
    if (existsSync(bash)) return bash;
  }
  return null;
}

/** Путь шелла на этой машине или null. */
export function shellPath(name: ShellName): string | null {
  if (!WINDOWS) return name === "powershell" ? null : inPath(name);
  if (name === "bash") return gitBash();
  if (name === "pwsh") return inPath("pwsh.exe");
  const path = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(path) ? path : null;
}

const stdoutOf = (file: string, args: string[]) => new Promise<string>((res) => execFile(file, args, { windowsHide: true }, (_e, out) => res(String(out ?? ""))));

/** Версия шелла: bash и pwsh — --version, Windows PowerShell 5.1 — $PSVersionTable. */
async function versionOf(name: ShellName, path: string): Promise<string | null> {
  const out = await stdoutOf(path, name === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"] : ["--version"]);
  return /(\d+\.\d+(?:\.\d+)*)/.exec(out)?.[1] ?? null;
}

/** Шеллы машины: ищутся заново при каждом вызове. */
export async function shells(): Promise<Record<string, { version: string | null; path: string }>> {
  const found = await Promise.all(
    SHELLS.map(async (name) => {
      const path = shellPath(name);
      return path ? ([name, { version: await versionOf(name, path), path }] as const) : null;
    }),
  );
  return Object.fromEntries(found.filter((x) => x !== null));
}

/** Первая строка .ps1: вывод в UTF-8 без BOM, иначе 5.1 пишет кириллицу в кодовой странице консоли. */
const PS_PRELUDE = "[Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";

export type Spawned = { child: ChildProcess; stdout: string; stderr: string; out: string };

/**
 * Папка запуска dir: скрипт файлом, stdout и stderr — прямо в файлы, пустая out/ — её путь в SB_OUT.
 * Старт в домашней папке; stdin записан и закрыт. На Linux и macOS — своя группа процессов: её убивает killTree.
 */
export function launch(dir: string, name: ShellName, path: string, script: string, stdin: string): Spawned {
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  const isPs = name !== "bash";
  const file = join(dir, isPs ? "script.ps1" : "script.sh");
  // .ps1 с BOM: иначе Windows PowerShell 5.1 читает кириллицу скрипта как ANSI
  writeFileSync(file, isPs ? "\ufeff" + PS_PRELUDE + script : script);
  const stdout = join(dir, "stdout");
  const stderr = join(dir, "stderr");
  const fdOut = openSync(stdout, "w");
  const fdErr = openSync(stderr, "w");
  const args = isPs ? ["-NoProfile", "-NonInteractive", ...(WINDOWS ? ["-ExecutionPolicy", "Bypass"] : []), "-File", file] : [file];
  try {
    const child = spawn(path, args, { cwd: homedir(), env: { ...process.env, SB_OUT: out }, stdio: ["pipe", fdOut, fdErr], windowsHide: true, detached: !WINDOWS });
    // скрипт вышел, не дочитав ввод: EPIPE — не ошибка запуска
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    return { child, stdout, stderr, out };
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
  }
}

/** Убить всё дерево процесса: taskkill /T /F на Windows, группу процессов на Linux и macOS. */
export function killTree(pid: number): void {
  if (WINDOWS) {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группы нет: все процессы запуска уже кончились
  }
}

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Файлы $SB_OUT с подпапками: имя — путь от out/ через «/», тип — по расширению, данные — base64. */
export function outFiles(out: string): Attachment[] {
  if (!existsSync(out)) return [];
  const walk = (dir: string): Attachment[] =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return walk(path);
        if (!e.isFile()) return [];
        return [{ name: relative(out, path).split("\\").join("/"), media_type: MEDIA[extname(e.name).toLowerCase()] ?? "application/octet-stream", data: readFileSync(path).toString("base64") }];
      });
  return walk(out);
}

/** Размер файла или 0. */
export const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

/** Текст файла вывода или пусто. */
export const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
