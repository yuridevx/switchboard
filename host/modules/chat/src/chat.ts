// Разговор с сессией: ввод, чтение, лента и вопросы человеку. Состояния на диске нет: зрители и вопросы живут в памяти Host.
import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import { content, refuse, type Attachment, type Frame, type Host, type Module, type Roster, type Session } from "@switchboard/host";
import { questions } from "./ask.ts";
import { feeds } from "./feed.ts";

/** Что видит модель адресата: сообщение другой сессии. */
export const wrap = (from: string, body: string) => `<fleet-message from="${from}">\n${body}\n</fleet-message>`;
/** То же от родителя: итог этого хода уходит ему сам. */
export const task = (from: string, body: string) => `${wrap(from, body)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)`;

/** Предел поиска файлов для «@». */
const FILES_MS = 5000;

const down = (s: Session) => s.state === "stopped" || s.state === "failed" || s.state === "stopping";

function gitFiles(cwd: string, signal: AbortSignal): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, signal, timeout: FILES_MS, maxBuffer: 64 * 1024 * 1024 }, (e, out) => resolve(e ? null : out.split("\n").filter(Boolean)));
  });
}

/** Файлы папки сессии, путь содержит query: в git — без скрытого .gitignore; иначе обход папки. Предел — limit и время. */
async function findFiles(cwd: string, query: string, limit: number, signal: AbortSignal): Promise<string[]> {
  const q = query.toLowerCase();
  const fit = (path: string) => path.toLowerCase().includes(q);
  const git = await gitFiles(cwd, signal);
  if (git) return git.filter(fit).slice(0, limit);
  const found: string[] = [];
  const until = Date.now() + FILES_MS;
  for await (const e of await opendir(cwd, { recursive: true })) {
    if (signal.aborted) throw refuse("shutting_down", "обход папки остановлен");
    if (Date.now() > until) throw refuse("timeout", `список файлов не собран за ${FILES_MS} мс`);
    if (!e.isFile()) continue;
    const path = relative(cwd, join(e.parentPath, e.name)).split(sep).join("/");
    if (fit(path) && found.push(path) >= limit) break;
  }
  return found;
}

function session(host: Host, req: Frame): Session {
  const s = host.session(String(req.callsign));
  if (!s) throw refuse("offline", `${String(req.callsign)}: сессии нет на этой машине`);
  return s;
}

/** Страница записей перед before: стык в стык, начиная с конца разговора. */
function page(all: Array<{ uuid?: string }>, before: unknown, limit: number) {
  const end = before === null ? all.length : all.findIndex((m) => m.uuid === before);
  if (end < 0) throw refuse("bad_frame", `session.history: записи ${String(before)} в разговоре нет`);
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), more: start > 0 };
}

export function make(): Module {
  let host!: Host;
  const feed = feeds(() => host);
  const ask = questions(() => host, feed.viewers);

  /** Запись этой сессии и зрителя; без отправителя кадр не по контракту. */
  const viewerOf = (req: Frame, from?: string) => {
    if (!from) throw refuse("bad_frame", `${req.type}: нет from`);
    session(host, req);
    return from;
  };

  return {
    start(h) {
      host = h;
    },
    stop: feed.flushAll,
    session: () => ({ promptSuggestions: true, includePartialMessages: true }),
    requests: {
      "session.prompt"(req, { from }) {
        const s = session(host, req);
        const { text, attachments = [], uuid = randomUUID() } = req;
        if (typeof text !== "string" || !Array.isArray(attachments)) throw refuse("bad_frame", "session.prompt: text — строка, attachments — список");
        if (down(s)) throw refuse("stopped", `${s.info.callsign}: сессия ${s.state} — поднимает session.start`);
        s.input(content(text, attachments as Attachment[]), { from, priority: "next", uuid: uuid as string, origin: { kind: "human" } });
        return { uuid };
      },

      message(req, { from = "" }) {
        if (typeof req.text !== "string") throw refuse("bad_frame", "message: нужны to — callsign и text");
        const s = host.session(String(req.to));
        if (!s || down(s)) throw refuse("offline", `${String(req.to)}: ${s ? `сессия ${s.state}` : "сессии нет на этой машине"}`);
        const body = !req.report && s.field("parent") === from ? task(from, req.text) : wrap(from, req.text);
        s.input(body, { ...(req.report ? {} : { from }), priority: "next", uuid: randomUUID(), origin: { kind: "peer", from, name: from } });
      },

      async "session.history"(req) {
        const s = session(host, req);
        const { before, limit } = req;
        if (typeof limit !== "number" || limit < 1 || (before !== null && typeof before !== "string")) throw refuse("bad_frame", "session.history: нужны limit ≥ 1 и before — uuid или null");
        const all = (await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid?: string }>;
        return page(all, before, limit);
      },

      "session.files"(req, { signal }) {
        const s = session(host, req);
        if (typeof req.limit !== "number" || req.limit < 1) throw refuse("bad_frame", "session.files: нужны query — строка и limit ≥ 1");
        return findFiles(s.info.cwd, String(req.query ?? ""), req.limit, signal);
      },

      "session.watch"(req, { from }) {
        feed.watch(String(req.callsign), viewerOf(req, from));
      },
      "session.unwatch"(req, { from }) {
        feed.unwatch(String(req.callsign), viewerOf(req, from));
      },

      answer(req, { from = "" }) {
        ask.answer(req, from);
      },
      "question.list": (req) => ask.list(String(req.callsign)),
    },
    frames: {
      question: (f) => ask.intoInput(f),
    },
    decide: {
      AskUserQuestion: ask.askUser,
      "*": ask.permission,
    },
    elicit: ask.form,
    on: {
      event: feed.event,
      frame(f) {
        if (f.type === "roster") feed.present((f as unknown as Roster).clients ?? []);
      },
    },
  };
}
