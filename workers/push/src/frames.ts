// Кадры push: ключ, подписка устройства, пуш адресату. Отказ — исключение со словом и полями строки журнала; ответ и строка строятся в одном месте.
import { accepts, fail, isReply, kindOf, ok, reaches, within, type Frame } from "@switchboard/protocol";
import { CONTRACT, type Notify } from "../contract.ts";
import type { Env } from "./env.ts";
import { MAX_PLAIN, publicKey, pushRequest, unb64u, type Target } from "./webpush.ts";

type Fields = Record<string, unknown>;
type Row = Target & { client: string; kid: string | null };
type Outcome = "ok" | "gone" | "failed";

class Refusal extends Error {
  readonly word: string;
  readonly fields: Fields;
  constructor(word: string, why: string, fields: Fields = {}) {
    super(why);
    this.word = word;
    this.fields = fields;
  }
}

const log = (kind: "note" | "refuse", ev: string, fields: Fields) => console.log(JSON.stringify({ part: "push", kind, ev, ...fields }));
const hostOf = (endpoint: string) => new URL(endpoint).host;
/** Удалить именно эту подписку: устройство могло подписаться заново, пока шёл ответ. */
const drop = (env: Env, r: Row, by: "endpoint" | "kid") => env.DB.prepare(`DELETE FROM subs WHERE client = ? AND ${by} = ?`).bind(r.client, r[by]).run();

function parseSubscription(sub: unknown): Target {
  const bad = (why: string) => new Refusal("bad_frame", why);
  if (!sub || typeof sub !== "object") throw bad("нет sub");
  const { endpoint, keys } = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || !URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:" || !new URL(endpoint).host) throw bad("в подписке нет https-адреса");
  const { p256dh, auth } = keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string") throw bad("в подписке нет ключей");
  let point: Uint8Array;
  let secret: Uint8Array;
  try {
    point = unb64u(p256dh);
    secret = unb64u(auth);
  } catch {
    throw bad("ключи подписки — не base64url");
  }
  if (point.length !== 65) throw bad("p256dh — не точка P-256 в 65 Б");
  if (secret.length !== 16) throw bad("auth — не 16 Б");
  return { endpoint, p256dh, auth };
}

async function subscribe(env: Env, f: Frame): Promise<undefined> {
  if (!f.from) throw new Refusal("bad_frame", "нет from — имя клиента ставит relay");
  const { endpoint, p256dh, auth } = parseSubscription(f.sub);
  await env.DB.prepare("INSERT OR REPLACE INTO subs (client, endpoint, p256dh, auth, at, kid) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(f.from, endpoint, p256dh, auth, Date.now(), typeof f.fromKid === "string" ? f.fromKid : null)
    .run();
  log("note", "subscribe", { client: f.from, host: hostOf(endpoint) });
  return undefined;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** Текст уведомления в предел службы: длинный notify.body укорочен, начало и «…». Не влезает и без него — null. */
function fit(message: { notify: Notify }): { text: string; cut: boolean } | null {
  const whole = JSON.stringify(message);
  if (bytesOf(whole) <= MAX_PLAIN) return { text: whole, cut: false };
  const body = message.notify.body;
  if (typeof body !== "string") return null;
  const withLength = (n: number) => JSON.stringify({ ...message, notify: { ...message.notify, body: `${body.slice(0, n)}…` } });
  if (bytesOf(withLength(0)) > MAX_PLAIN) return null;
  let fits = 0;
  let over = body.length;
  while (over - fits > 1) {
    const middle = (fits + over) >> 1;
    if (bytesOf(withLength(middle)) <= MAX_PLAIN) fits = middle;
    else over = middle;
  }
  return { text: withLength(fits), cut: true };
}

/** Подписки, до которых доходит адрес. Отозванные пропуска — строка удалена, журнал. */
async function targets(env: Env, to: string, skip: string[], type: string): Promise<Row[]> {
  const { results } = await env.DB.prepare("SELECT client, endpoint, p256dh, auth, kid FROM subs").all<Row>();
  const rows = results.filter((r) => reaches(to, r.client) && !skip.includes(r.client));
  const kids = rows.flatMap((r) => r.kid ?? []);
  const revoked = new Set(kids.length ? await within(env.GATE.revoked(kids), "gate не ответил на revoked") : []);
  const live: Row[] = [];
  for (const r of rows) {
    if (!r.kid || !revoked.has(r.kid)) {
      live.push(r);
      continue;
    }
    await drop(env, r, "kid");
    log("refuse", "push.send", { word: "gone", why: `пропуск ${r.kid} отозван: подписка удалена`, client: r.client, type });
  }
  return live;
}

/** Один POST службе; исход и строка журнала по устройству. */
async function deliver(env: Env, row: Row, text: string, line: Fields, cut: boolean): Promise<Outcome> {
  const fields = { ...line, client: row.client, host: hostOf(row.endpoint) };
  const refused = (word: string, why: string, extra: Fields = {}) => log("refuse", "push.send", { word, why, ...fields, ...extra });
  const { init, bytes } = await pushRequest(row, text, JSON.parse(env.VAPID_PRIVATE) as JsonWebKey, env.VAPID_SUB);
  let status: number;
  try {
    status = (await fetch(row.endpoint, init)).status;
  } catch (e) {
    refused("push_failed", `служба не ответила: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
  if (status === 410 || status === 404) {
    await drop(env, row, "endpoint");
    refused("gone", `служба ответила ${status}: подписки нет, строка удалена`, { status });
    return "gone";
  }
  if (status < 200 || status >= 300) {
    refused("push_failed", `служба ответила ${status}`, { status });
    return "failed";
  }
  log("note", "sent", { ...fields, status, bytes, cut });
  return "ok";
}

async function send(env: Env, f: Frame): Promise<undefined> {
  const { to, skip, type, from, notify } = (f.push ?? {}) as { to?: unknown; skip?: unknown; type?: unknown; from?: unknown; notify?: Notify };
  if (typeof to !== "string" || typeof type !== "string" || !notify) throw new Refusal("bad_frame", "в push нужны to, type и notify");
  if (skip !== undefined && !Array.isArray(skip)) throw new Refusal("bad_frame", "skip — список адресов устройств");
  const line = { client: to, type };
  const rows = await targets(env, to, (skip ?? []) as string[], type);
  if (!rows.length) throw new Refusal("gone", kindOf(to) === "user" ? "пушить некому: подписок нет или все на связи" : "подписки нет", line);
  const text = fit({ type, from, notify } as { notify: Notify });
  if (!text) throw new Refusal("bad_frame", "уведомление не влезает в 4 096 Б и без notify.body", line);
  const outcomes = await Promise.all(rows.map((r) => deliver(env, r, text.text, { type, from: f.from }, text.cut)));
  if (outcomes.includes("ok")) return undefined;
  // причины уже в строках по устройствам
  throw new Refusal(outcomes.includes("failed") ? "push_failed" : "gone", "");
}

const HANDLERS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown> | unknown> = {
  "push.key": (env) => ({ key: publicKey(JSON.parse(env.VAPID_PRIVATE) as JsonWebKey) }),
  "push.subscribe": subscribe,
  "push.send": send,
};

export async function answer(env: Env, f: Frame): Promise<Frame[]> {
  if (isReply(f)) {
    log("note", "reply", { why: "push ответов не ждёт", from: f.from });
    return [];
  }
  if (!f.id) {
    log("note", f.type, { why: "кадр без id — ответа нет", from: f.from });
    return [];
  }
  const to = f.from;
  const no = accepts(f, CONTRACT);
  if (no) {
    log("refuse", f.type, { word: no.word, why: no.why, from: to });
    return [{ ...fail(f.id, no.word), to }];
  }
  try {
    return [{ ...ok(f.id, await HANDLERS[f.type as keyof typeof CONTRACT](env, f)), to }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    if (e.message) log("refuse", f.type, { word: e.word, why: e.message, from: to, ...e.fields });
    return [{ ...fail(f.id, e.word), to }];
  }
}
