// Модуль chat: человек пишет сессии. session.prompt — текст и вложения одним сообщением во ввод SDK,
// без обёртки флота; session.history — разговор страницами из файла сессии; session.files — пути для «@».
// Ленту не шлёт (это watch), таймеров и хранилища нет.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Attachment, Frame, Host, Module, SDKUserMessage, Session } from "@switchboard/host";
import { IMAGE_TYPES, refuse } from "@switchboard/host";

type Content = Exclude<SDKUserMessage["message"]["content"], string>;
type Block = Content[number];

/**
 * Вложение → блок сообщения. data — base64 у всех типов (клиент шлёт файл как есть);
 * text/plain раскрывается в текст документа. Блока для типа нет — null.
 */
export function block(a: Attachment): Block | null {
  if (IMAGE_TYPES.has(a.media_type)) return { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } } as Block;
  if (a.media_type === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } } as Block;
  if (a.media_type === "text/plain") return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(a.data, "base64").toString("utf8") } } as Block;
  return null;
}

/** Текст и вложения одного session.prompt — одно сообщение: без вложений — строка, иначе блоки по порядку. */
export function content(text: string, attachments: Attachment[]): SDKUserMessage["message"]["content"] {
  if (!attachments.length) return text;
  const blocks: Block[] = text ? [{ type: "text", text } as Block] : [];
  for (const a of attachments) {
    const b = block(a);
    if (!b) throw refuse("bad_attachment", `${a.name}: ${a.media_type} — блока для типа нет; во ввод ничего не ушло`);
    blocks.push(b);
  }
  return blocks;
}

/** Файлы папки без того, что скрывает .gitignore: git ls-files; папка не в git — все файлы, кроме .git. */
function listFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (!err) return resolve(out.split("\0").filter(Boolean));
      if ((err as { code?: unknown }).code !== 128) return reject(err);
      // не репозиторий git: .gitignore тут ничего не скрывает
      const all = readdirSync(cwd, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(cwd, join(e.parentPath, e.name)).split("\\").join("/"))
        .filter((p) => p !== ".git" && !p.startsWith(".git/"));
      resolve(all);
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
        const from = typeof req.from === "string" ? req.from : ctx.from;
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
