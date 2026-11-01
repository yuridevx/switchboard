// Модуль chat: человек пишет сессии. session.prompt — текст и вложения одним сообщением во ввод SDK,
// без обёртки флота; session.history — разговор страницами из файла сессии; session.files — пути для «@».
// Ленту не шлёт (это watch), таймеров и хранилища нет.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Attachment, Frame, Host, Module, Session } from "@switchboard/host";
import { content, refuse } from "@switchboard/host";

/** Файлы папки без того, что скрывает .gitignore: git ls-files; папка не в git — все файлы, кроме .git. */
function listFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (!err) return resolve(out.split("\0").filter(Boolean));
      if ((err as { code?: unknown }).code !== 128) return reject(err);
      // не репозиторий git: .gitignore тут ничего не скрывает; сбой обхода — в отказ промиса, к ловушке ядра
      try {
        const all = readdirSync(cwd, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => relative(cwd, join(e.parentPath, e.name)).split("\\").join("/"))
          .filter((p) => p !== ".git" && !p.startsWith(".git/"));
        resolve(all);
      } catch (e) {
        reject(e);
      }
    });
  });
}

const STOPPED = new Set(["stopped", "failed"]);

export function make(): Module {
  let host: Host;
  const session = (req: Frame): Session => host.session(req.callsign as string)!;

  return {
    // предложение следующего ввода после хода: ленту с ним везёт watch
    session: () => ({ promptSuggestions: true }),
    requests: {
      "session.prompt"(req, ctx) {
        const s = session(req);
        const text = req.text ?? "";
        const attachments = (req.attachments ?? []) as Attachment[];
        if (typeof text !== "string" || !Array.isArray(attachments)) throw refuse("bad_frame", "session.prompt: text — строка, attachments — список");
        if (STOPPED.has(s.state)) throw refuse("stopped", `${s.info.callsign}: сессия ${s.state} — поднимает session.start`);
        const c = content(text, attachments);
        const uuid = typeof req.uuid === "string" ? req.uuid : randomUUID();
        const from = ctx.from;
        s.input(c, { from, priority: "next", uuid, origin: { kind: "human" } });
        return { uuid };
      },
      async "session.history"(req) {
        const s = session(req);
        const limit = req.limit;
        const before = req.before ?? null;
        if (typeof limit !== "number" || limit < 1 || (before !== null && typeof before !== "string")) throw refuse("bad_frame", "session.history: нужны limit ≥ 1 и before — uuid или null");
        const all = (await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid: string }>;
        let end = all.length;
        if (before !== null) {
          end = all.findIndex((m) => m.uuid === before);
          if (end < 0) throw refuse("bad_frame", `session.history: записи ${before} в разговоре нет`);
        }
        const start = Math.max(0, end - limit);
        return { messages: all.slice(start, end), more: start > 0 };
      },
      async "session.files"(req) {
        const s = session(req);
        const query = req.query ?? "";
        const limit = req.limit;
        if (typeof query !== "string" || typeof limit !== "number" || limit < 1) throw refuse("bad_frame", "session.files: нужны query — строка и limit ≥ 1");
        const q = query.toLowerCase();
        const files = await listFiles(s.info.cwd);
        return files.filter((p) => p.toLowerCase().includes(q)).slice(0, limit);
      },
    },
    start(h) {
      host = h;
    },
    // снимать и дописывать нечего
    stop() {},
  };
}
