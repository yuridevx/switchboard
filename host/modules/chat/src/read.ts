// Чтение разговора: страницы истории из SDK и пути папки для «@». Ввод не трогают, процесс не поднимают.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Host, Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { READ_MS } from "@switchboard/protocol";

const late = () => refuse("timeout", `список файлов не собран за ${READ_MS / 1000} с`);

/** Папка не в git: обход всех файлов, кроме .git. Предел — READ_MS, сигнал Host останавливает обход. */
async function walk(cwd: string, signal: AbortSignal): Promise<string[]> {
  const deadline = Date.now() + READ_MS;
  const found: string[] = [];
  const dirs = [""];
  while (dirs.length) {
    if (signal.aborted) throw refuse("shutting_down", "обход папки остановлен");
    if (Date.now() > deadline) throw late();
    const rel = dirs.pop()!;
    for (const e of await readdir(join(cwd, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (path !== ".git") dirs.push(path);
      } else if (e.isFile()) found.push(path);
    }
  }
  return found;
}

/** Файлы без скрытого .gitignore: git ls-files; папка не в git — обход. */
function listFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: READ_MS, signal }, (err, out) => {
      if (!err) return resolve(out.split("\0").filter(Boolean));
      if (signal.aborted) return reject(refuse("shutting_down", "чтение файлов остановлено"));
      if ((err as { killed?: boolean }).killed) return reject(late());
      // git отвечает 128, если папка не репозиторий; прочее — сбой, он идёт к ловушке ядра
      if ((err as { code?: unknown }).code !== 128) return reject(err);
      walk(cwd, signal).then(resolve, reject);
    });
  });
}

export function makeRead(host: () => Host): Required<Module>["requests"] {
  return {
    async "session.history"(req) {
      const { limit, before = null } = req as { limit?: unknown; before?: unknown };
      if (typeof limit !== "number" || limit < 1 || (before !== null && typeof before !== "string")) throw refuse("bad_frame", "session.history: нужны limit ≥ 1 и before — uuid или null");
      const all = (await host().session(req.callsign as string)!.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid: string }>;
      const end = before === null ? all.length : all.findIndex((m) => m.uuid === before);
      if (end < 0) throw refuse("bad_frame", `session.history: записи ${before} в разговоре нет`);
      const start = Math.max(0, end - limit);
      return { messages: all.slice(start, end), more: start > 0 };
    },
    async "session.files"(req, ctx) {
      const { query = "", limit } = req as { query?: unknown; limit?: unknown };
      if (typeof query !== "string" || typeof limit !== "number" || limit < 1) throw refuse("bad_frame", "session.files: нужны query — строка и limit ≥ 1");
      const q = query.toLowerCase();
      const files = await listFiles(host().session(req.callsign as string)!.info.cwd, ctx.signal);
      return files.filter((p) => p.toLowerCase().includes(q)).slice(0, limit);
    },
  };
}
