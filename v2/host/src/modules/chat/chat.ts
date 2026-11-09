// Разговор с сессией: ввод человека и других сессий, история, файлы для «@», лента зрителям, «прочитано» и вопросы человеку.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { kindOf, personOf, reachSend, Refusal, type Frame, type SessionState } from "@sb/protocol";
import type { Ctx, HostApi, Module, SessionApi } from "../../core/contract.ts";
import { questions } from "./ask.ts";

/** Окно пачки ленты. */
const WINDOW_MS = 100;
/** Предел обхода папки для «@». */
const FILES_MS = 5000;
const FILES_MAX = 50;
/** Начало ответа в строке сессии. */
const RESULT_MAX = 240;
/** Типы файлов, которые модель видит картинкой. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type FileIn = { name: string; mime: string; base64: string };
/** Раздел сессии: люди разговора, у кого непрочитанное, начало последнего ответа. */
type Part = { people?: string[]; unread?: string[]; result?: string; title?: string; asker?: string };

const down = (s: SessionApi) => s.state === "stopped" || s.state === "failed" || s.state === "stopping";
const isHuman = (a: string) => kindOf(a) === "device" || kindOf(a) === "person";

/** Что видит модель адресата: сообщение другой сессии или службы. */
export const wrap = (from: string, text: string): string => `<fleet-message from="${from}">\n${text}\n</fleet-message>`;
const WRAPPED = /^<fleet-message from="([^"]+)">\n([\s\S]*)\n<\/fleet-message>/;
/** Задача от родителя: итог хода уйдёт ему сам. */
export const task = (from: string, text: string): string => `${wrap(from, text)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — писать ему отдельно не нужно.)`;

/** Запись разговора с тегом несёт разобранное: адрес отправителя больше нигде не хранится. */
function withPeer<T extends { message?: { content?: unknown } }>(m: T): T {
  const tag = typeof m.message?.content === "string" ? m.message.content.match(WRAPPED) : null;
  return tag ? { ...m, peer: { from: tag[1], text: tag[2] } } : m;
}

function block({ name, mime, base64 }: FileIn) {
  if (IMAGE_TYPES.has(mime)) return { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  if (mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: mime, data: base64 } };
  if (mime.startsWith("text/")) return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(base64, "base64").toString("utf8") }, title: name };
  throw new Refusal("bad_attachment", `${name}: ${mime} — блока для типа нет; во ввод ничего не ушло`);
}

/** Текст и вложения → содержимое сообщения user. */
export function content(text: string, files: FileIn[] = []): unknown {
  if (!files.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...files.map(block)];
}

/** Файлы папки, путь содержит q: в git — без скрытого .gitignore, иначе обход; предел — FILES_MAX, FILES_MS и остановка Host. */
async function files(cwd: string, q: string, signal: AbortSignal): Promise<string[]> {
  const fit = (f: string) => f.toLowerCase().includes(q);
  const listed = await new Promise<string[] | null>((done) =>
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, timeout: FILES_MS, maxBuffer: 1 << 26, signal }, (e, out) => done(e ? null : out.split("\n").filter(Boolean))),
  );
  if (listed) return listed.filter(fit).slice(0, FILES_MAX);
  const until = Date.now() + FILES_MS;
  const found: string[] = [];
  for await (const e of await opendir(cwd, { recursive: true })) {
    if (signal.aborted) throw new Refusal("shutting_down", "обход папки остановлен");
    if (Date.now() > until) throw new Refusal("timeout", `список файлов не собран за ${FILES_MS} мс`);
    if (!e.isFile()) continue;
    const path = relative(cwd, join(e.parentPath, e.name)).split(sep).join("/");
    if (fit(path) && found.push(path) >= FILES_MAX) break;
  }
  return found;
}

export function make(): Module {
  let host: HostApi;
  const viewers = new Map<string, Set<string>>();
  const batches = new Map<string, { events: unknown[]; timer: ReturnType<typeof setTimeout> }>();
  const seqs = new Map<string, number>();
  /** текст итога идущего хода */
  const results = new Map<string, string>();
  const part = (s: SessionApi): Part => s.store<Part>().get() ?? {};
  const merge = (s: SessionApi, p: Part) => s.store<Part>().update((cur) => ({ ...cur, ...p }));
  /** Кто дал задачу: последний писавший, иначе открывший. */
  const asker = (s: SessionApi) => part(s).asker ?? s.info.by;
  const ask = questions(() => host, asker);
  const session = (to: string) => host.session(to)!;

  function flush(cs: string) {
    const b = batches.get(cs);
    if (!b) return;
    batches.delete(cs);
    clearTimeout(b.timer);
    const seq = (seqs.get(cs) ?? 0) + b.events.length;
    seqs.set(cs, seq);
    const to = [...(viewers.get(cs) ?? [])];
    if (to.length) host.emit({ type: "session.events", to, callsign: cs, seq, events: b.events });
  }

  /** Позвать человека, давшего задачу: звать ли на самом деле, решает служба. */
  function reach(s: SessionApi, kind: "done" | "failed", text: string): void {
    const who = asker(s);
    if (!who || !isHuman(who)) return;
    void host
      .call(reachSend, { to: personOf(who)!, title: kind === "done" ? `${s.callsign} закончила` : `${s.callsign}: сбой`, text, callsign: s.callsign, kind })
      .catch((e: unknown) => host.log.warn("reach", { callsign: s.callsign, why: (e as Error).message }));
  }

  /** Конец хода: непрочитанное — людям разговора, кроме тех, кто смотрит сейчас. */
  function turnEnd(s: SessionApi): void {
    const cs = s.callsign;
    const watching = new Set([...(viewers.get(cs) ?? [])].map((a) => personOf(a)));
    const { people = [], unread = [] } = part(s);
    const result = (results.get(cs) ?? "").slice(0, RESULT_MAX);
    results.delete(cs);
    merge(s, { unread: [...new Set([...unread, ...people.filter((p) => !watching.has(p))])], ...(result ? { result } : {}) });
    reach(s, "done", result);
    // заголовок разговора: строка меняется, только если он сменился
    void s.sdk("getSessionInfo").then(
      (info) => {
        const title = (info as { customTitle?: string; summary?: string } | undefined)?.customTitle ?? (info as { summary?: string } | undefined)?.summary;
        if (title && title !== part(s).title && host.session(cs)) {
          merge(s, { title });
          s.sync();
        }
      },
      () => {},
    );
  }

  return {
    name: "host-chat",
    start(h) {
      host = h;
    },
    stop() {
      for (const cs of [...batches.keys()]) flush(cs);
    },
    compose: () => ({ promptSuggestions: true }),
    row(s) {
      const { unread = [], result, title } = part(s);
      return { ask: ask.first(s.callsign), unread, ...(result ? { result } : {}), ...(title ? { title } : {}) };
    },
    requests: {
      message({ to, text, files: attached }: { to: string; text: string; files?: FileIn[] }, ctx: Ctx) {
        const s = session(to);
        if (down(s)) throw new Refusal("stopped", `${to}: сессия ${s.state} — запускает session.start`);
        const from = ctx.from;
        const uuid = randomUUID();
        if (isHuman(from)) {
          const person = personOf(from)!;
          const { people = [], unread = [] } = part(s);
          merge(s, { people: [...new Set([...people, person])], unread: unread.filter((p) => p !== person), asker: from });
          s.input(content(text, attached), { from, priority: "next", uuid });
          s.sync();
        } else {
          // итог хода дочери и сообщения других сессий — с пометкой отправителя; задача от родителя — с припиской
          const body = s.spec.parent === from ? task(from, text) : wrap(from, text);
          if (s.spec.parent === from) merge(s, { asker: from });
          s.input(body, { from, priority: "next", uuid });
        }
        return { queued: s.state !== "idle", uuid };
      },

      async "session.history"({ to, before, limit = 50 }: { to: string; before?: string; limit?: number }) {
        const s = session(to);
        const all = (await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid?: string; message?: { content?: unknown } }>;
        const end = before === undefined ? all.length : all.findIndex((m) => m.uuid === before);
        if (end < 0) throw new Refusal("not_found", `session.history: записи ${before} в разговоре нет`);
        const start = Math.max(0, end - limit);
        return { events: all.slice(start, end).map(withPeer), more: start > 0, seq: seqs.get(to) ?? 0 };
      },

      async "session.files"({ to, q }: { to: string; q: string }, ctx: Ctx) {
        return { files: await files(session(to).info.cwd, q.toLowerCase(), ctx.signal) };
      },

      "session.watch"({ to }: { to: string }, ctx: Ctx) {
        (viewers.get(to) ?? viewers.set(to, new Set()).get(to)!).add(ctx.from);
        return { seq: seqs.get(to) ?? 0 };
      },

      "session.unwatch"({ to }: { to: string }, ctx: Ctx) {
        viewers.get(to)?.delete(ctx.from);
        return {};
      },

      /** «Прочитано»: пометка снимается у человека на всех его устройствах. */
      "session.read"({ to }: { to: string }, ctx: Ctx) {
        const s = session(to);
        const person = personOf(ctx.from);
        if (!person) throw new Refusal("not_client", "session.read: читает человек");
        const { unread = [], people = [] } = part(s);
        merge(s, { unread: unread.filter((p) => p !== person), people: [...new Set([...people, person])] });
        s.sync();
        return {};
      },

      answer({ to, ask: id, answer }: { to: string; ask: string; answer: unknown }, ctx: Ctx) {
        ask.answer(to, id, answer, ctx.from);
        return {};
      },
    },
    frames: {
      /** Зритель ушёл: снять его со всех сессий. */
      "watch.closed"(f: Frame) {
        for (const set of viewers.values()) set.delete(String(f.addr));
      },
    },
    decide: (s, input, opts) => ask.decide(s, input, opts),
    elicit: (s, req, opts) => ask.elicit(s, req, opts),
    on: {
      event(s, msg) {
        const cs = s.callsign;
        if (msg?.type === "result" && typeof msg.result === "string") results.set(cs, msg.result);
        const b = batches.get(cs) ?? batches.set(cs, { events: [], timer: setTimeout(() => flush(cs), WINDOW_MS) }).get(cs)!;
        b.events.push(msg);
      },
      state(s, state: SessionState, was: SessionState) {
        if (state === "starting") ask.reset(s.callsign);
        if (state === "idle" && (was === "busy" || was === "waiting")) turnEnd(s);
        if (state === "failed") reach(s, "failed", "сессия остановилась со сбоем");
      },
      removed(cs) {
        viewers.delete(cs);
        seqs.delete(cs);
        results.delete(cs);
        ask.forget(cs);
      },
    },
  };
}
