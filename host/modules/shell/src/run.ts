// ОС под модулем shell: какие шеллы есть, запуск скрипта файлом с выводом прямо в файлы папки запуска,
// убийство всего дерева процесса, файлы $SB_OUT. Решений о запуске здесь нет — их держит shell.ts.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, relative } from "node:path";
import type { Attachment } from "@switchboard/host";

export const SHELLS = ["bash", "pwsh", "powershell"] as const;
export type ShellName = (typeof SHELLS)[number];

const win = process.platform === "win32";

/** Файл в PATH; на Windows — с расширениями PATHEXT. */
function which(name: string): string | null {
  const exts = win ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = join(dir, win && extname(name) ? name : name + e);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Путь шелла на этой машине или null. bash на Windows — Git Bash, как у Claude Code: CLAUDE_CODE_GIT_BASH_PATH
 * или bin\bash.exe рядом с git из PATH; bash из PATH на Windows бывает входом в WSL — его не берём.
 */
export function shellPath(name: ShellName): string | null {
  if (!win) return name === "powershell" ? null : which(name);
  if (name === "pwsh") return which("pwsh.exe");
  if (name === "powershell") {
    const p = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return existsSync(p) ? p : null;
  }
  const env = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (env && existsSync(env)) return env;
  const git = which("git.exe");
  if (!git) return null;
  // git.exe лежит в <Git>\cmd, <Git>\bin или <Git>\mingw64\bin
  for (let d = dirname(git); dirname(d) !== d; d = dirname(d)) {
    const b = join(d, "bin", "bash.exe");
    if (existsSync(b)) return b;
  }
  return null;
}

const out = (file: string, args: string[]) =>
  new Promise<string>((res) => execFile(file, args, { windowsHide: true }, (_e, stdout) => res(String(stdout ?? ""))));

/** Версия шелла: bash и pwsh — --version, Windows PowerShell 5.1 — $PSVersionTable. */
async function version(name: ShellName, path: string): Promise<string | null> {
  const text = name === "powershell" ? await out(path, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]) : await out(path, ["--version"]);
  return /(\d+\.\d+(?:\.\d+)*)/.exec(text)?.[1] ?? null;
}

/** Шеллы машины: ищутся заново при каждом вызове. */
export async function shells(): Promise<Record<string, { version: string | null; path: string }>> {
  const found: Record<string, { version: string | null; path: string }> = {};
  await Promise.all(
    SHELLS.map(async (n) => {
      const p = shellPath(n);
      if (p) found[n] = { version: await version(n, p), path: p };
    }),
  );
  return Object.fromEntries(SHELLS.filter((n) => found[n]).map((n) => [n, found[n]]));
}

/** Первая строка .ps1: вывод в UTF-8 без BOM, иначе 5.1 пишет кириллицу в кодовой странице консоли. */
const PS_PRELUDE = "[Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";

export type Spawned = { child: ChildProcess; stdout: string; stderr: string; out: string };

/**
 * Папка запуска dir: скрипт файлом, stdout и stderr — прямо в файлы, пустая out/ — её путь в SB_OUT.
 * Старт в домашней папке; stdin записан и закрыт. На Linux и macOS — своя группа процессов: её убивает killTree.
 */
export function start(dir: string, name: ShellName, path: string, script: string, stdin: string): Spawned {
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const ps = name !== "bash";
  const file = join(dir, ps ? "script.ps1" : "script.sh");
  // .ps1 с BOM: иначе Windows PowerShell 5.1 читает кириллицу скрипта как ANSI
  writeFileSync(file, ps ? "\ufeff" + PS_PRELUDE + script : script);
  const stdout = join(dir, "stdout");
  const stderr = join(dir, "stderr");
  const fo = openSync(stdout, "w");
  const fe = openSync(stderr, "w");
  const args = ps ? ["-NoProfile", "-NonInteractive", ...(win ? ["-ExecutionPolicy", "Bypass"] : []), "-File", file] : [file];
  try {
    const child = spawn(path, args, {
      cwd: homedir(),
      env: { ...process.env, SB_OUT: outDir },
      stdio: ["pipe", fo, fe],
      windowsHide: true,
      detached: !win,
    });
    // скрипт вышел, не дочитав ввод: EPIPE — не ошибка запуска
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    return { child, stdout, stderr, out: outDir };
  } finally {
    closeSync(fo);
    closeSync(fe);
  }
}

/** Убить всё дерево процесса: taskkill /T /F на Windows, группу процессов на Linux и macOS. */
export function killTree(pid: number): void {
  if (win) {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // группы нет: все процессы запуска уже кончились
  }
}

const TYPES: Record<string, string> = {
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
export function outFiles(outDir: string): Attachment[] {
  const files: Attachment[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile())
        files.push({ name: relative(outDir, p).split("\\").join("/"), media_type: TYPES[extname(e.name).toLowerCase()] ?? "application/octet-stream", data: readFileSync(p).toString("base64") });
    }
  };
  if (existsSync(outDir)) walk(outDir);
  return files;
}

/** Размер файла или 0. */
export const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);

/** Текст файла вывода или пусто. */
export const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
