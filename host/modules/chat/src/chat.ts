// Разговор с сессией на Host: ввод человека и других сессий, история, файлы для «@», живая лента зрителям и вопросы человеку.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { content, refuse, type Attachment, type Frame, type Host, type Module, type Session } from "@switchboard/host";
import { questions } from "./ask.ts";

/** Окно пачки ленты. */
const WINDOW_MS = 100;
/** Предел обхода папки для «@». */
const FILES_MS = 10_000;
const LIVE = new Set(["starting", "idle", "busy", "waiting"]);

/** Что видит модель адресата: сообщение другой сессии. */
export const wrap = (from: string, text: string): string => `<fleet-message from="${from}">\n${text}\n</fleet-message>`;
/** Задача от родителя: итог хода уйдёт ему сам. */
export const task = (from: string, text: string): string => `${wrap(from, text)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)`;

const need = (ok: unknown, why: string) => {
  if (!ok) throw refuse("bad_frame", why);
};

/** Файлы папки: в git — без скрытого .gitignore, иначе все; предел — FILES_MS. */
async function files(cwd: string): Promise<string[]> {
  const listed = await new Promise<string[] | null>((done) =>
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, timeout: FILES_MS, maxBuffer: 1 << 26 }, (e, out) => done(e ? null : out.split("\n").filter(Boolean))),
  );
  if (listed) return listed;
  const until = Date.now() + FILES_MS;
  const all: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (Date.now() > until) throw refuse("timeout", `обход ${cwd} дольше ${FILES_MS} мс`);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else all.push(relative(cwd, path).replaceAll("\\", "/"));
    }
  };
  await walk(cwd);
  return all;
}

export function make(): Module {
  let host: Host;
  const viewers = new Map<string, Set<string>>();
  const batches = new Map<string, { events: unknown[]; timer: ReturnType<typeof setTimeout> }>();
  const seqs = new Map<string, number>();
  const ask = questions(() => host, (cs) => [...(viewers.get(cs) ?? [])]);

  const session = (req: Frame, cs = String(req.callsign)): Session => {
    const s = host.session(cs);
    if (!s) throw refuse("offline", `${cs} нет на машине`);
    return s;
  };
  const viewer = (req: Frame, ctx: { from?: string }) => {
    need(ctx.from, "без from");
    const cs = session(req).info.callsign;
    return viewers.get(cs) ?? viewers.set(cs, new Set()).get(cs)!;
  };

  function flush(cs: string) {
    const b = batches.get(cs);
    batches.delete(cs);
    const to = [...(viewers.get(cs) ?? [])];
    if (!b || !to.length) return;
    clearTimeout(b.timer);
    const seq = (seqs.get(cs) ?? 0) + 1;
    seqs.set(cs, seq);
    host.emit({ type: "session.events", v: 1, from: cs, to, seq, events: b.events });
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
        need(typeof req.text === "string", "text не строка");
        const s = session(req);
        if (!LIVE.has(s.state)) throw refuse("stopped", `${s.info.callsign}: ${s.state}`);
        const uuid = typeof req.uuid === "string" ? req.uuid : crypto.randomUUID();
        s.input(content(req.text as string, (req.attachments ?? []) as Attachment[]), { from: ctx.from, priority: "next", uuid, origin: { kind: "human" } });
        return { uuid };
      },
      message(req, ctx) {
        need(typeof req.text === "string", "text не строка");
        const s = session(req, String(req.to));
        if (!LIVE.has(s.state)) throw refuse("offline", `${s.info.callsign}: ${s.state}`);
        const from = String(ctx.from);
        const text = s.field("parent") === from && !req.report ? task(from, req.text as string) : wrap(from, req.text as string);
        s.input(text, { from: req.report ? undefined : from, priority: "next", origin: { kind: "peer", from, name: from } });
        return undefined;
      },
      async "session.history"(req) {
        need(typeof req.limit === "number", "без limit");
        const s = session(req);
        const all = (await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid?: string }>;
        const end = req.before == null ? all.length : all.findIndex((m) => m.uuid === req.before);
        need(end >= 0, `нет записи ${req.before}`);
        const start = Math.max(0, end - (req.limit as number));
        return { messages: all.slice(start, end), more: start > 0 };
      },
      async "session.files"(req) {
        need(typeof req.limit === "number", "без limit");
        const query = String(req.query ?? "").toLowerCase();
        return (await files(session(req).info.cwd)).filter((f) => f.toLowerCase().includes(query)).slice(0, req.limit as number);
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
        if (!viewers.get(cs)?.size) return;
        const b = batches.get(cs) ?? batches.set(cs, { events: [], timer: setTimeout(() => flush(cs), WINDOW_MS) }).get(cs)!;
        b.events.push(msg);
      },
      frame(f) {
        if (f.type !== "roster") return;
        const here = new Set((f.clients ?? []) as string[]);
        for (const set of viewers.values()) for (const v of set) if (!here.has(v)) set.delete(v);
      },
    },
  };
}
