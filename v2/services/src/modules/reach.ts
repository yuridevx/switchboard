// Связь с людьми: устройства человека вне страницы — подписки веб-пуша и чаты Telegram, записи одного вида.
// Один запрос «позвать человека»: служба сама спрашивает платформу, на связи ли он; на связи — не шлёт.
import { CALL_MS, errFields, type Frame, newId, Refusal, sha256hex } from "@sb/protocol";
import type { Ctx, Deps, Env, Module, Platform } from "../env.ts";
import { log } from "../entrance.ts";
import { type Db, records } from "../records.ts";
import { encrypt, MAX_PLAIN, publicKey, unb64u, vapid } from "./webpush.ts";

const NAME = "reach";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, kind TEXT, person TEXT, label TEXT, at INTEGER, kid TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, chat INTEGER)",
  "CREATE INDEX IF NOT EXISTS devices_person ON devices (person)",
  "CREATE TABLE IF NOT EXISTS threads (chat INTEGER, callsign TEXT, thread INTEGER, PRIMARY KEY (chat, callsign))",
  "CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, person TEXT, kid TEXT, at INTEGER)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);
/** Чей это чат Telegram: вебхук приходит без флота. Единственная запись, общая для флотов, — только адресация. */
const chats = (env: Env) => records(env, "_", "telegram", ["CREATE TABLE IF NOT EXISTS chats (chat INTEGER PRIMARY KEY, fleet TEXT)"]);

type Device = { id: string; kind: "webpush" | "telegram"; person: string; label: string | null; at: number; kid: string | null; endpoint: string | null; p256dh: string | null; auth: string | null; chat: number | null };
type Note = { title: string; text: string; callsign?: string; kind?: string };

const B64U = /^[A-Za-z0-9_-]+$/;
const DAY = 24 * 3600 * 1000;

/* ===== Веб-пуш ===== */

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Открытый текст пуша в пределе службы: длинный текст укорачивается с «…». */
function fit(n: Note): Uint8Array | null {
  const whole = bytes(n);
  if (whole.length <= MAX_PLAIN) return whole;
  const chars = Array.from(n.text);
  const cut = (k: number) => bytes({ ...n, text: chars.slice(0, k).join("") + "…" });
  if (cut(0).length > MAX_PLAIN) return null;
  let [lo, hi] = [0, chars.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= MAX_PLAIN) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** Один пуш одной подписке. Служба ответила «подписки нет» — устройство убирается. */
async function push(ctx: Ctx, d: Device, plain: Uint8Array): Promise<boolean> {
  const jwk = JSON.parse(ctx.env.VAPID_PRIVATE!) as JsonWebKey;
  const body = await encrypt(plain, unb64u(d.p256dh!), unb64u(d.auth!));
  const headers = { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: await vapid(jwk, d.endpoint!, ctx.env.VAPID_SUB ?? "mailto:fleet@example.com") };
  let status: number;
  try {
    status = (await ctx.fetch(d.endpoint!, { method: "POST", headers, body, signal: AbortSignal.timeout(CALL_MS) })).status;
  } catch (e) {
    ctx.log.warn("служба пушей не ответила", { device: d.id, ...errFields(e) });
    return false;
  }
  if (status >= 200 && status < 300) return true;
  if (status === 404 || status === 410) await db(ctx.env, ctx.fleet).run("DELETE FROM devices WHERE id = ?", d.id);
  ctx.log.warn("пуш не принят", { device: d.id, status });
  return false;
}

/* ===== Telegram ===== */

type TgAnswer<T = Record<string, unknown>> = { ok: boolean; result?: T; error_code?: number; description?: string };

async function bot<T>(f: typeof fetch, token: string, method: string, body: unknown): Promise<TgAnswer<T>> {
  try {
    const res = await f(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return (await res.json()) as TgAnswer<T>;
  } catch (e) {
    return { ok: false, description: `Telegram не ответил: ${e}` };
  }
}

const threadGone = (a: TgAnswer<unknown>) => /thread not found/i.test(a.description ?? "");

/** Тема сессии в чате: первая запись сессии создаёт её. Тем в чате нет — null: сообщение уйдёт в общий поток с позывным. */
async function topic(f: typeof fetch, token: string, d: Db, chat: number, callsign: string): Promise<number | null> {
  const known = await d.first<{ thread: number }>("SELECT thread FROM threads WHERE chat = ? AND callsign = ?", chat, callsign);
  if (known) return known.thread;
  const made = await bot<{ message_thread_id: number }>(f, token, "createForumTopic", { chat_id: chat, name: callsign });
  if (!made.ok) return null;
  await d.run("INSERT OR IGNORE INTO threads (chat, callsign, thread) VALUES (?, ?, ?)", chat, callsign, made.result!.message_thread_id);
  return (await d.first<{ thread: number }>("SELECT thread FROM threads WHERE chat = ? AND callsign = ?", chat, callsign))!.thread;
}

/** Одно сообщение одному чату: в тему сессии. Человек удалил тему — новая тема и ещё одна попытка. */
async function tell(ctx: Ctx, d: Device, n: Note, again = true): Promise<boolean> {
  const token = ctx.env.TELEGRAM_BOT_TOKEN!;
  const store = db(ctx.env, ctx.fleet);
  const thread = n.callsign ? await topic(ctx.fetch, token, store, d.chat!, n.callsign) : null;
  const text = thread === null && n.callsign ? `${n.callsign} · ${n.title}\n\n${n.text}` : `${n.title}\n\n${n.text}`;
  const a = await bot(ctx.fetch, token, "sendMessage", { chat_id: d.chat, text, ...(thread === null ? {} : { message_thread_id: thread }) });
  if (a.ok) return true;
  if (threadGone(a) && n.callsign) {
    await store.run("DELETE FROM threads WHERE chat = ? AND callsign = ?", d.chat, n.callsign);
    if (again) return tell(ctx, d, n, false);
  }
  if (a.error_code === 403) await store.run("DELETE FROM devices WHERE id = ?", d.id);
  ctx.log.warn("Telegram не принял сообщение", { device: d.id, why: a.description });
  return false;
}

/** Секрет вебхука выводится из токена бота: второго секрета нет. */
const hookSecret = (token: string) => sha256hex(`webhook|${token}`);

const SEEN = "👀"; // дошло до машины
const NOBODY = "🤷"; // машина не на связи или чат не привязан
/** Реакцию сразу после сообщения Telegram принимает, но не показывает: ставится через секунду. */
const REACT_MS = 1000;

type TgMessage = { message_id: number; chat: { id: number }; message_thread_id?: number; from?: { id: number; is_bot?: boolean }; text?: string; caption?: string };

const CODE = /^([a-z0-9][a-z0-9_-]{0,62})-([a-z0-9]{12,})$/i;

/** Вебхук Telegram: код привязки делает чат устройством человека; сообщение в теме сессии уходит сессии кадром message. */
export async function telegram(req: Request, env: Env, exec: ExecutionContext, deps: Deps): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const f = deps.fetch ?? fetch;
  const platform: Platform = deps.platform ?? env.PLATFORM;
  const path = new URL(req.url).pathname;
  if (!token || req.method !== "POST") return new Response(null, { status: 404 });
  if (path === "/telegram/setup") {
    // регистрация вебхука при выкладке: вход — токен бота
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const a = await bot(f, token, "setWebhook", { url: `${new URL(req.url).origin}/telegram`, secret_token: await hookSecret(token), allowed_updates: ["message"] });
    return Response.json({ ok: a.ok, description: a.description }, { status: a.ok ? 200 : 502 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(token))) return new Response(null, { status: 401 });
  const m = ((await req.json()) as { message?: TgMessage }).message;
  // всегда 200: повтор доставки дал бы двойной ввод
  const done = new Response(null, { status: 200 });
  if (!m || m.from?.is_bot) return done;
  const chat = m.chat.id;
  const mark = (emoji: string) => exec.waitUntil(scheduler.wait(REACT_MS).then(() => bot(f, token, "setMessageReaction", { chat_id: chat, message_id: m.message_id, reaction: [{ type: "emoji", emoji }] })));
  try {
    const code = CODE.exec((m.text ?? "").replace(/^\/start(?:@\w+)?\s+/, "").trim());
    if (code) {
      const fleet = code[1]!;
      const d = db(env, fleet);
      const row = await d.first<{ person: string; kid: string; at: number }>("SELECT person, kid, at FROM codes WHERE code = ?", code[0]);
      if (!row || Date.now() - row.at > DAY) {
        mark(NOBODY);
        return done;
      }
      await d.batch([
        ["INSERT OR REPLACE INTO devices (id, kind, person, label, at, kid, chat) VALUES (?, 'telegram', ?, 'Telegram', ?, ?, ?)", `tg${chat}`, row.person, Date.now(), row.kid, chat],
        ["DELETE FROM codes WHERE code = ?", code[0]],
      ]);
      await chats(env).run("INSERT OR REPLACE INTO chats (chat, fleet) VALUES (?, ?)", chat, fleet);
      await bot(f, token, "sendMessage", { chat_id: chat, text: `Привязано: ${row.person}` });
      log.info("чат Telegram привязан", { module: NAME, fleet, person: row.person });
      return done;
    }
    const route = await chats(env).first<{ fleet: string }>("SELECT fleet FROM chats WHERE chat = ?", chat);
    const text = m.text ?? (m.caption ? `${m.caption}\n(вложение не передано)` : undefined);
    if (!route || !text || m.message_thread_id === undefined) {
      mark(NOBODY);
      return done;
    }
    const d = db(env, route.fleet);
    const [dev, th] = await Promise.all([
      d.first<Device>("SELECT * FROM devices WHERE id = ?", `tg${chat}`),
      d.first<{ callsign: string }>("SELECT callsign FROM threads WHERE chat = ? AND thread = ?", chat, m.message_thread_id),
    ]);
    if (!dev || !th) {
      mark(NOBODY);
      return done;
    }
    const frame: Frame = { type: "message", id: newId("r"), trace: newId("t"), to: th.callsign, from: `telegram${dev.person}`, text };
    const r = await platform.deliver(route.fleet, frame);
    mark(r?.ok ? SEEN : NOBODY);
  } catch (e) {
    log.error("вебхук Telegram упал", { module: NAME, ...errFields(e) });
    mark(NOBODY);
  }
  return done;
}

/* ===== Запросы ===== */

export const reach: Module = {
  name: NAME,
  handlers: {
    async "reach.send"(i: { to: string; title: string; text: string; callsign?: string; kind?: string; force?: boolean }, ctx) {
      const online = await ctx.platform.online(ctx.fleet, i.to);
      if (online && !i.force) return { sent: 0, online };
      const d = db(ctx.env, ctx.fleet);
      let devices = await d.all<Device>("SELECT * FROM devices WHERE person = ?", i.to);
      // отозванный пропуск — устройство больше не получает
      const kids = devices.flatMap((x) => (x.kid ? [x.kid] : []));
      if (kids.length && ctx.platform.alive) {
        const alive = new Set(await ctx.platform.alive(ctx.fleet, kids));
        const dead = devices.filter((x) => x.kid && !alive.has(x.kid));
        if (dead.length) await d.batch(dead.map((x) => ["DELETE FROM devices WHERE id = ?", x.id]));
        devices = devices.filter((x) => !x.kid || alive.has(x.kid));
      }
      const n: Note = { title: i.title, text: i.text, ...(i.callsign ? { callsign: i.callsign } : {}), ...(i.kind ? { kind: i.kind } : {}) };
      const plain = ctx.env.VAPID_PRIVATE ? fit(n) : null;
      const sent = await Promise.all(
        devices.map((x) => {
          if (x.kind === "webpush") return plain ? push(ctx, x, plain) : false;
          return ctx.env.TELEGRAM_BOT_TOKEN ? tell(ctx, x, n) : false;
        }),
      );
      return { sent: sent.filter(Boolean).length, online };
    },

    async "reach.key"(_i, ctx) {
      if (!ctx.env.VAPID_PRIVATE) throw new Refusal("no_vapid", "ключ веб-пуша не задан");
      return { key: publicKey(JSON.parse(ctx.env.VAPID_PRIVATE)) };
    },

    async "reach.subscribe"(i: { endpoint: string; p256dh: string; auth: string; label?: string }, ctx) {
      if (!i.endpoint.startsWith("https://") || !URL.canParse(i.endpoint)) throw new Refusal("bad_input", "в подписке нет https-адреса");
      if (!B64U.test(i.p256dh) || !B64U.test(i.auth) || unb64u(i.p256dh).length !== 65 || unb64u(i.auth).length !== 16) throw new Refusal("bad_input", "ключи подписки не того вида");
      const id = "wp" + (await sha256hex(i.endpoint)).slice(0, 20);
      await db(ctx.env, ctx.fleet).run(
        "INSERT OR REPLACE INTO devices (id, kind, person, label, at, kid, endpoint, p256dh, auth) VALUES (?, 'webpush', ?, ?, ?, ?, ?, ?, ?)",
        id, ctx.who.person, i.label ?? null, Date.now(), ctx.who.kid, i.endpoint, i.p256dh, i.auth,
      );
      return { id };
    },

    async "reach.devices"(_i, ctx) {
      const rows = await db(ctx.env, ctx.fleet).all<Device>("SELECT * FROM devices WHERE person = ? ORDER BY at", ctx.who.person);
      return { devices: rows.map((x) => ({ id: x.id, kind: x.kind, person: x.person, at: x.at, ...(x.label ? { label: x.label } : {}), ...(x.kid ? { kid: x.kid } : {}) })) };
    },

    async "reach.remove"(i: { id: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const dev = await d.first<Device>("SELECT * FROM devices WHERE id = ?", i.id);
      if (!dev || (dev.person !== ctx.who.person && !ctx.who.admin)) throw new Refusal("not_found", "такого устройства у вас нет");
      await d.run("DELETE FROM devices WHERE id = ?", i.id);
      if (dev.chat != null) await chats(ctx.env).run("DELETE FROM chats WHERE chat = ?", dev.chat);
      return {};
    },

    /** Код привязки чата: человек шлёт его боту, чат становится его устройством. Код живёт сутки. */
    async "reach.telegram"(_i, ctx) {
      if (!ctx.env.TELEGRAM_BOT_TOKEN || !ctx.env.TELEGRAM_BOT) throw new Refusal("no_telegram", "бот Telegram не подключён");
      const code = `${ctx.fleet}-${newId()}`;
      await db(ctx.env, ctx.fleet).batch([
        ["DELETE FROM codes WHERE at < ?", Date.now() - DAY],
        ["INSERT INTO codes (code, person, kid, at) VALUES (?, ?, ?, ?)", code, ctx.who.person, ctx.who.kid, Date.now()],
      ]);
      return { code, bot: ctx.env.TELEGRAM_BOT };
    },
  },
};
