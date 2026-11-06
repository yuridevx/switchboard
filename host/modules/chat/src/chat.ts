// Разговор с сессией на Host: ввод человека и других сессий, история, файлы для «@», живая лента зрителям и вопросы человеку.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { content, refuse, type Attachment, type Frame, type Host, type Module, type Session } from "@switchboard/host";
import { questions } from "./ask.ts";

/** Окно пачки ленты. */
const WINDOW_MS = 100;
/** Предел обхода папки для «@». */
const FILES_MS = 5000;
const down = (s: Session) => s.state === "stopped" || s.state === "failed" || s.state === "stopping";

/** Что видит модель адресата: сообщение другой сессии. */
export const wrap = (from: string, text: string): string => `<fleet-message from="${from}">\n${text}\n</fleet-message>`;
/** Задача от родителя: итог хода уйдёт ему сам. */
export const task = (from: string, text: string): string => `${wrap(from, text)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)`;

const need = (ok: unknown, why: string) => {
  if (!ok) throw refuse("bad_frame", why);
};

/** Файлы папки, путь содержит query: в git — без скрытого .gitignore, иначе обход; предел — limit, FILES_MS и остановка Host. */
async function files(cwd: string, query: string, limit: number, signal: AbortSignal): Promise<string[]> {
  const fit = (f: string) => f.toLowerCase().includes(query);
  const listed = await new Promise<string[] | null>((done) =>
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, timeout: FILES_MS, maxBuffer: 1 << 26, signal }, (e, out) => done(e ? null : out.split("\n").filter(Boolean))),
  );
  if (listed) return listed.filter(fit).slice(0, limit);
  const until = Date.now() + FILES_MS;
  const found: string[] = [];
  for await (const e of await opendir(cwd, { recursive: true })) {
    if (signal.aborted) throw refuse("shutting_down", "обход папки остановлен");
    if (Date.now() > until) throw refuse("timeout", `список файлов не собран за ${FILES_MS} мс`);
    if (!e.isFile()) continue;
    const path = relative(cwd, join(e.parentPath, e.name)).split(sep).join("/");
    if (fit(path) && found.push(path) >= limit) break;
  }
  return found;
}

export function make(): Module {
  let host: Host;
  const viewers = new Map<string, Set<string>>();
  const batches = new Map<string, { events: unknown[]; timer: ReturnType<typeof setTimeout> }>();
  const seqs = new Map<string, number>();
  const ask = questions(() => host, (cs) => [...(viewers.get(cs) ?? [])]);

  const session = (req: Frame, cs = String(req.callsign)): Session => {
    const s = host.session(cs);
    if (!s) throw refuse("offline", `${cs}: сессии нет на этой машине`);
    return s;
  };
  /** Чужой текст во ввод: from — кто ответит на вопрос сессии, если он дал задачу. */
  const peer = (s: Session, name: string, text: string, from: string | undefined) => s.input(text, { from, priority: "next", uuid: randomUUID(), origin: { kind: "peer", from: name, name } });
  /** Человек написал в чат Telegram. Кадр без id: остановленная сессия отвечает в тот же чат, пока сессия спрашивает — текст и есть ответ. */
  const human = ({ to, from, text }: Frame) => {
    const s = host.session(String(to));
    if (!s || !from || typeof text !== "string") return host.log({ kind: "refuse", ev: "rooms.message", word: "offline", callsign: String(to), from, why: `${String(to)}: сессии нет` });
    const cs = s.info.callsign;
    if (down(s)) {
      host.log({ kind: "refuse", ev: "rooms.message", word: "offline", callsign: cs, from, why: `${cs}: сессия ${s.state}` });
      return void host.request("notify", { clients: [from], frame: { type: "message", from: cs, notify: { title: cs, body: `Сессия ${s.state}: сообщение не принято, запустите её в пульте.` } } });
    }
    if (!ask.reply(s, from, text)) peer(s, from, wrap(from, text), from);
  };
  const viewer = (req: Frame, ctx: { from?: string }) => {
    need(ctx.from, "без from");
    const cs = session(req).info.callsign;
    return viewers.get(cs) ?? viewers.set(cs, new Set()).get(cs)!;
  };

  function flush(cs: string) {
    const b = batches.get(cs)!;
    batches.delete(cs);
    clearTimeout(b.timer);
    const to = [...(viewers.get(cs) ?? [])];
    if (!to.length) return;
    const seq = (seqs.get(cs) ?? 0) + 1;
    seqs.set(cs, seq);
    host.emit({ type: "session.events", from: cs, to, seq, events: b.events });
  }

  return {
    start(h) {
      host = h;
    },
    stop() {
      for (const cs of [...batches.keys()]) flush(cs);
    },
    session: () => ({ promptSuggestions: true, includePartialMessages: true }),
    requests: {
      "session.prompt"(req, ctx) {
        const s = session(req);
        const { text, attachments = [], uuid = randomUUID() } = req;
        need(typeof text === "string" && Array.isArray(attachments), "session.prompt: text — строка, attachments — список");
        if (down(s)) throw refuse("stopped", `${s.info.callsign}: сессия ${s.state} — поднимает session.start`);
        s.input(content(text as string, attachments as Attachment[]), { from: ctx.from, priority: "next", uuid: uuid as string, origin: { kind: "human" } });
        return { uuid };
      },
      message(req, ctx) {
        need(typeof req.text === "string", "message: нужны to — callsign и text");
        const s = session(req, String(req.to));
        if (down(s)) throw refuse("offline", `${s.info.callsign}: сессия ${s.state}`);
        const from = String(ctx.from);
        const text = s.field("parent") === from && !req.report ? task(from, req.text as string) : wrap(from, req.text as string);
        peer(s, from, text, req.report ? undefined : from);
        return undefined;
      },
      async "session.history"(req) {
        const { before = undefined, limit } = req;
        need(typeof limit === "number" && limit >= 1 && (before === null || typeof before === "string"), "session.history: нужны limit ≥ 1 и before — uuid или null");
        const s = session(req);
        const all = (await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid?: string }>;
        const end = before === null ? all.length : all.findIndex((m) => m.uuid === before);
        need(end >= 0, `session.history: записи ${String(before)} в разговоре нет`);
        const start = Math.max(0, end - (limit as number));
        return { messages: all.slice(start, end), more: start > 0 };
      },
      "session.files"(req, ctx) {
        need(typeof req.limit === "number" && req.limit >= 1, "session.files: нужны query — строка и limit ≥ 1");
        return files(session(req).info.cwd, String(req.query ?? "").toLowerCase(), req.limit as number, ctx.signal);
      },
      "session.watch"(req, ctx) {
        viewer(req, ctx).add(ctx.from!);
        return undefined;
      },
      "session.unwatch"(req, ctx) {
        viewer(req, ctx).delete(ctx.from!);
        return undefined;
      },
      ...ask.requests,
    },
    frames: { question: (f) => ask.frame(f) },
    decide: ask.decide,
    elicit: ask.elicit,
    on: {
      event(s, msg) {
        const cs = s.info.callsign;
        const b = batches.get(cs) ?? batches.set(cs, { events: [], timer: setTimeout(() => flush(cs), WINDOW_MS) }).get(cs)!;
        b.events.push(msg);
      },
      frame(f) {
        if (f.type === "rooms.message") return human(f);
        // ядро зовёт сюда на всё имя из uses, а такой кадр может прислать любой участник: зрителей снимает только roster
        if (f.type !== "roster") return;
        const here = new Set((f.clients ?? []) as string[]);
        for (const set of viewers.values()) for (const v of set) if (!here.has(v)) set.delete(v);
      },
    },
  };
}
