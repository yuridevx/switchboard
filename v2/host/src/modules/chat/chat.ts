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
/** Сколько последних событий ленты помнит Host: зритель после обрыва связи получает пропущенное, а не перечитывает разговор. */
const RECENT_MAX = 2000;
/** Строка «чем занят ход» меняется не чаще: шаги идут десятками в минуту, картина флота — не лента. */
export const DOING_GAP_MS = 3000;
const DOING_MAX = 120;
/** Типы файлов, которые модель видит картинкой. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type FileIn = { name: string; mime: string; base64: string };
/** Итог хода для истории: файл разговора его не хранит. after — запись разговора, за которой он встаёт. */
type TurnEnd = { after: string; event: Record<string, unknown> };
/** Раздел сессии: люди разговора, у кого непрочитанное, начало последнего ответа, итоги последних ходов. */
type Part = { people?: string[]; unread?: string[]; result?: string; title?: string; asker?: string; ends?: TurnEnd[] };
/** Сколько итогов ходов хранит сессия. */
const ENDS_MAX = 200;
/** Поля итога хода, которые идут в историю: время, шаги, цена, токены; текст ответа — уже в записи модели. */
const END_FIELDS = ["type", "subtype", "uuid", "is_error", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd", "usage", "modelUsage", "session_id"];

type Queued = { uuid: string; from: string; text: string; at: number };
type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; input?: Record<string, unknown>; text?: string };

const down = (s: SessionApi) => s.state === "stopped" || s.state === "failed" || s.state === "stopping";
const isHuman = (a: string) => kindOf(a) === "device" || kindOf(a) === "person";

/** Чем занят ход — одной строкой: инструмент и его главный довод. */
function doingOf(b: Block): string {
  const i = b.input ?? {};
  const arg = i.file_path ?? i.path ?? i.command ?? i.description ?? i.pattern ?? i.url ?? i.query ?? "";
  return `${b.name ?? ""}${typeof arg === "string" && arg ? ` ${arg.split(/\r?\n/)[0]}` : ""}`.slice(0, DOING_MAX);
}

const blocksOf = (m: { message?: { content?: unknown } }): Block[] => (Array.isArray(m.message?.content) ? (m.message!.content as Block[]) : []);

/** Что видит модель адресата: сообщение другой сессии или службы. */
export const wrap = (from: string, text: string): string => `<fleet-message from="${from}">\n${text}\n</fleet-message>`;
const WRAPPED = /^<fleet-message from="([^"]+)">\n([\s\S]*)\n<\/fleet-message>/;
/** Задача от родителя: итог хода уйдёт ему сам. */
export const task = (from: string, text: string): string => `${wrap(from, text)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — писать ему отдельно не нужно.)`;

/** Только переписка с людьми: их сообщения, сообщения им, вопросы человеку и ответы на них. */
export function peopleOnly<T extends { type?: string; peer?: { from: string }; message?: { content?: unknown } }>(events: T[]): T[] {
  const asked = new Set<string>();
  return events.filter((m) => {
    if (m.type !== "user" && m.type !== "assistant") return false;
    if (m.peer) return isHuman(m.peer.from);
    if (m.type === "user" && typeof m.message?.content === "string") return true;
    return blocksOf(m).some((b) => {
      if (b.type === "tool_use" && b.name === "AskUserQuestion") return asked.add(b.id ?? ""), true;
      if (b.type === "tool_use" && /reach_send$/.test(b.name ?? "")) return true;
      return b.type === "tool_result" && asked.has(b.tool_use_id ?? "");
    });
  });
}

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
  /** последние события ленты: событие i имеет номер seq − length + i + 1 */
  const recent = new Map<string, unknown[]>();
  /** свои сообщения, которые ход ещё не взял */
  const queued = new Map<string, Queued[]>();
  /** чем занят ход и когда строка об этом уходила в картину */
  const doing = new Map<string, { text: string; at: number }>();
  const compacting = new Set<string>();
  /** последняя запись разговора, пришедшая от процесса: за ней встаёт итог хода */
  const lastUuid = new Map<string, string>();
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
    const kept = [...(recent.get(cs) ?? []), ...b.events];
    recent.set(cs, kept.length > RECENT_MAX ? kept.slice(-RECENT_MAX) : kept);
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

  /** Событие в ленту: пачка уходит зрителям через окно. */
  function push(cs: string, event: unknown): void {
    const b = batches.get(cs) ?? batches.set(cs, { events: [], timer: setTimeout(() => flush(cs), WINDOW_MS) }).get(cs)!;
    b.events.push(event);
  }

  /** Статус своего сообщения — в ленту; из очереди оно уходит, когда ход его взял или его отменили. */
  function status(cs: string, uuid: string, st: "queued" | "taken" | "cancelled"): void {
    if (st !== "queued") {
      const was = queued.get(cs) ?? [];
      const left = was.filter((q) => q.uuid !== uuid);
      if (left.length === was.length) return;
      queued.set(cs, left);
    }
    push(cs, { type: "message.status", uuid, status: st });
  }

  /** Сообщение SDK → строка сессии: чем занят ход и идёт ли сжатие. Строка меняется не на каждое событие. */
  function track(s: SessionApi, msg: any): void {
    const cs = s.callsign;
    if (msg?.type === "system" && msg.subtype === "status") {
      const on = msg.status === "compacting";
      if (on !== compacting.has(cs)) {
        if (on) compacting.add(cs);
        else compacting.delete(cs);
        s.sync();
      }
    }
    if (msg?.type !== "assistant" || msg.parent_tool_use_id) return;
    const tool = blocksOf(msg).find((b) => b.type === "tool_use");
    if (!tool) return;
    const text = doingOf(tool);
    const was = doing.get(cs);
    if (was?.text === text) return;
    const now = Date.now();
    // новое дело запоминается всегда, в картину уходит не чаще предела; между ними его унесёт любая другая смена строки
    const fresh = !was || now - was.at >= DOING_GAP_MS;
    doing.set(cs, { text, at: fresh ? now : was!.at });
    if (fresh) s.sync();
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
      const busy = s.state === "busy" || s.state === "waiting";
      const now = busy ? doing.get(s.callsign)?.text : undefined;
      return { ask: ask.first(s.callsign), unread, ...(result ? { result } : {}), ...(title ? { title } : {}), ...(now ? { doing: now } : {}), ...(compacting.has(s.callsign) ? { compacting: true } : {}) };
    },
    requests: {
      message({ to, text, files: attached, priority = "next" }: { to: string; text: string; files?: FileIn[]; priority?: "now" | "next" | "later" }, ctx: Ctx) {
        const s = session(to);
        if (down(s)) throw new Refusal("stopped", `${to}: сессия ${s.state} — запускает session.start`);
        const from = ctx.from;
        const uuid = randomUUID();
        let body: unknown;
        if (isHuman(from)) {
          const person = personOf(from)!;
          const { people = [], unread = [] } = part(s);
          merge(s, { people: [...new Set([...people, person])], unread: unread.filter((p) => p !== person), asker: from });
          body = content(text, attached);
          s.input(body, { from, priority, uuid });
          s.sync();
        } else {
          // итог хода дочери и сообщения других сессий — с пометкой отправителя; задача от родителя — с припиской
          body = s.spec.parent === from ? task(from, text) : wrap(from, text);
          if (s.spec.parent === from) merge(s, { asker: from });
          s.input(body, { from, priority, uuid });
        }
        // сообщение — в ленту сразу: процесс свой ввод зрителям не повторяет; номер тот же, что будет у записи разговора
        push(to, withPeer({ type: "user", uuid, from, message: { role: "user", content: body } }));
        lastUuid.set(to, uuid);
        // сессия занята — сообщение ждёт в очереди: его видно зрителям и его можно отменить
        const waits = s.state !== "idle";
        if (waits) {
          queued.set(to, [...(queued.get(to) ?? []), { uuid, from, text, at: Date.now() }]);
          status(to, uuid, "queued");
        }
        return { queued: waits, uuid };
      },

      /** Отмена своего сообщения, пока ход его не взял. */
      async "message.cancel"({ to, uuid }: { to: string; uuid: string }) {
        const s = session(to);
        if (!(queued.get(to) ?? []).some((q) => q.uuid === uuid)) return { cancelled: false };
        const r = await s.sdk("cancelAsyncMessage", uuid).catch((e: unknown) => {
          throw new Refusal("sdk_error", `${to}: отмена сообщения — ${(e as Error).message}`);
        });
        if (r === false) return { cancelled: false };
        status(to, uuid, "cancelled");
        return { cancelled: true };
      },

      async "session.history"({ to, before, limit = 50, people }: { to: string; before?: string; limit?: number; people?: boolean }) {
        const s = session(to);
        const said = ((await s.sdk("getSessionMessages", { includeSystemMessages: true })) as Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>).map(withPeer);
        // итоги ходов встают за записью, после которой ход кончился: в файле разговора их нет
        const ends = part(s).ends ?? [];
        const whole = ends.length ? said.flatMap((m) => [m, ...ends.filter((e) => e.after === m.uuid).map((e) => e.event as typeof m)]) : said;
        const all = people ? peopleOnly(whole) : whole;
        const end = before === undefined ? all.length : all.findIndex((m) => m.uuid === before);
        if (end < 0) throw new Refusal("not_found", `session.history: записи ${before} в разговоре нет`);
        const start = Math.max(0, end - limit);
        return { events: all.slice(start, end), more: start > 0, seq: seqs.get(to) ?? 0 };
      },

      async "session.files"({ to, q }: { to: string; q: string }, ctx: Ctx) {
        return { files: await files(session(to).info.cwd, q.toLowerCase(), ctx.signal) };
      },

      /** Смотреть ленту. after — номер последнего события у зрителя: пропущенное — в ответе; его уже нет в памяти — gap. */
      "session.watch"({ to, after }: { to: string; after?: number }, ctx: Ctx) {
        flush(to);
        (viewers.get(to) ?? viewers.set(to, new Set()).get(to)!).add(ctx.from);
        const seq = seqs.get(to) ?? 0;
        const waiting = queued.get(to) ?? [];
        const base = { seq, ...(waiting.length ? { queued: waiting } : {}) };
        if (after === undefined || after >= seq) return base;
        const kept = recent.get(to) ?? [];
        const first = seq - kept.length;
        return after < first ? { ...base, gap: true } : { ...base, events: kept.slice(after - first) };
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
      /** У зрителя не осталось соединений с машиной: снять его со всех сессий. */
      "watcher.gone"(f: Frame) {
        for (const set of viewers.values()) set.delete(String(f.addr ?? f.from));
      },
    },
    decide: (s, input, opts) => ask.decide(s, input, opts),
    elicit: (s, req, opts) => ask.elicit(s, req, opts),
    on: {
      event(s, msg) {
        const cs = s.callsign;
        if (msg?.type === "result" && typeof msg.result === "string") results.set(cs, msg.result);
        if ((msg?.type === "assistant" || msg?.type === "user") && typeof msg.uuid === "string" && !msg.parent_tool_use_id) lastUuid.set(cs, msg.uuid);
        if (msg?.type === "result") {
          // итог хода — и в историю: время, шаги, цена, токены
          const after = lastUuid.get(cs);
          if (!msg.uuid) msg = { ...msg, uuid: randomUUID() };
          if (after) merge(s, { ends: [...(part(s).ends ?? []), { after, event: Object.fromEntries(END_FIELDS.filter((f) => msg[f] !== undefined).map((f) => [f, msg[f]])) }].slice(-ENDS_MAX) });
        }
        push(cs, msg);
        // ход взял сообщения из очереди
        const taken = (msg as { user_message_uuids?: unknown }).user_message_uuids;
        for (const uuid of Array.isArray(taken) ? (taken as string[]) : msg?.type === "user" && typeof msg.uuid === "string" ? [msg.uuid as string] : []) status(cs, uuid, "taken");
        track(s, msg);
      },
      state(s, state: SessionState, was: SessionState) {
        if (state === "starting") ask.reset(s.callsign);
        if (state !== "busy" && state !== "waiting") {
          doing.delete(s.callsign);
          compacting.delete(s.callsign);
        }
        // процесса нет — очереди ввода у него тоже нет
        if (state === "stopped" || state === "failed") queued.delete(s.callsign);
        if (state === "idle" && (was === "busy" || was === "waiting")) turnEnd(s);
        if (state === "failed") reach(s, "failed", "сессия остановилась со сбоем");
      },
      removed(cs) {
        viewers.delete(cs);
        seqs.delete(cs);
        recent.delete(cs);
        queued.delete(cs);
        lastUuid.delete(cs);
        doing.delete(cs);
        compacting.delete(cs);
        results.delete(cs);
        ask.forget(cs);
      },
    },
  };
}
