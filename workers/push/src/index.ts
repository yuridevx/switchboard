// Worker push: кадр по привязке или POST с пропуском → подписка в D1 или пуш службам браузеров. Состояния нет: всё в D1.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { CALL_MS, accepts, fail, kindOf, ok, reaches, within, type Frame } from "@switchboard/protocol";
import { CONTRACT, type Notify } from "../contract.ts";
import type { Env } from "./env.ts";
import { MAX_PLAIN, encrypt, publicKey, unb64u, vapid } from "./webpush.ts";

type Row = Record<string, unknown>;
type Sub = { client: string; endpoint: string; p256dh: string; auth: string; kid: string | null };

/** Журнал — Workers Logs, строка JSON в общем формате журналов. Текста уведомлений и ключей подписок здесь нет. */
const log = (row: Row) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "push", ...row }));

/** Отказ словом. Пустой why — причина уже в журнале строками по устройствам. */
class Refusal extends Error {
  readonly word: string;
  readonly why: string;
  readonly row: Row;

  constructor(word: string, why: string, row: Row = {}) {
    super(`${word}: ${why}`);
    this.word = word;
    this.why = why;
    this.row = row;
  }
}
const refuse = (word: string, why: string, row?: Row): never => {
  throw new Refusal(word, why, row);
};

/** Подписка браузера по контракту: https-адрес службы, точка P-256 и 16 байт auth. */
function subscription(sub: unknown) {
  if (!sub) return refuse("bad_frame", "нет sub");
  const { endpoint, keys } = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const host = typeof endpoint === "string" && endpoint.startsWith("https://") && URL.canParse(endpoint) ? new URL(endpoint).hostname : "";
  if (!host) refuse("bad_frame", "в подписке нет https-адреса");
  const { p256dh, auth } = keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string") return refuse("bad_frame", "в подписке нет ключей");
  let point: Uint8Array;
  let secret: Uint8Array;
  try {
    point = unb64u(p256dh);
    secret = unb64u(auth);
  } catch {
    return refuse("bad_frame", "ключи подписки — не base64url");
  }
  if (point.length !== 65) refuse("bad_frame", "p256dh — не точка P-256 в 65 Б");
  if (secret.length !== 16) refuse("bad_frame", "auth — не 16 Б");
  return { endpoint: endpoint as string, p256dh, auth, host };
}

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Открытый текст пуша в пределе: длинный notify.body укорачивается с «…»; не влезает и так — null. */
function fit(payload: { type: string; from: unknown; notify: Notify }):{ plain: Uint8Array; cut: boolean } | null {
  const whole = bytes(payload);
  if (whole.length <= MAX_PLAIN) return { plain: whole, cut: false };
  const { body } = payload.notify;
  if (typeof body !== "string") return null;
  const chars = Array.from(body);
  const cut = (n: number) => bytes({ ...payload, notify: { ...payload.notify, body: chars.slice(0, n).join("") + "…" } });
  if (cut(0).length > MAX_PLAIN) return null;
  let [lo, hi] = [0, chars.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= MAX_PLAIN) lo = mid;
    else hi = mid - 1;
  }
  return { plain: cut(lo), cut: true };
}

type Outcome = "sent" | "gone" | "push_failed";

/** Один пуш одной подписке; исход — строкой журнала. */
async function deliver(env: Env, jwk: JsonWebKey, s: Sub, plain: Uint8Array, line: Row): Promise<Outcome> {
  const at = { ...line, client: s.client, host: new URL(s.endpoint).hostname };
  const body = await encrypt(plain, unb64u(s.p256dh), unb64u(s.auth));
  const headers = { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: await vapid(jwk, s.endpoint, env.VAPID_SUB) };
  let status: number;
  try {
    status = (await fetch(s.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(CALL_MS) })).status;
  } catch (e) {
    log({ kind: "refuse", ev: "push.send", word: "push_failed", why: `служба не ответила: ${e}`, ...at });
    return "push_failed";
  }
  if (status >= 200 && status < 300) {
    log({ kind: "note", ev: "sent", status, bytes: body.length, ...at });
    return "sent";
  }
  if (status === 404 || status === 410) {
    // именно эта подписка: устройство могло подписаться заново, пока шёл пуш
    await env.DB.prepare("DELETE FROM subs WHERE client = ? AND endpoint = ?").bind(s.client, s.endpoint).run();
    log({ kind: "refuse", ev: "push.send", word: "gone", why: `служба ответила ${status}: подписки нет, строка удалена`, status, ...at });
    return "gone";
  }
  log({ kind: "refuse", ev: "push.send", word: "push_failed", why: `служба ответила ${status}`, status, ...at });
  return "push_failed";
}

const HANDLERS: Record<keyof typeof CONTRACT, (f: Frame, env: Env) => Promise<unknown>> = {
  async "push.key"(_f, env) {
    return { key: publicKey(JSON.parse(env.VAPID_PRIVATE)) };
  },

  async "push.subscribe"({ sub, from, fromKid }, env) {
    const s = subscription(sub);
    await env.DB.prepare("INSERT OR REPLACE INTO subs (client, endpoint, p256dh, auth, at, kid) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(from, s.endpoint, s.p256dh, s.auth, Date.now(), fromKid ?? null)
      .run();
    log({ kind: "note", ev: "subscribe", client: from, host: s.host });
    return undefined;
  },

  async "push.subscribed"({ endpoint, from, fromKid }, env) {
    if (typeof endpoint !== "string") refuse("bad_frame", "endpoint — адрес подписки строкой");
    const row = await env.DB.prepare("SELECT 1 FROM subs WHERE client = ? AND endpoint = ? AND kid IS ?").bind(from, endpoint, fromKid ?? null).first();
    return { subscribed: row !== null };
  },

  async "push.send"({ push, from }, env) {
    const { to, skip = [], type, from: asker, notify } = (push ?? {}) as { to?: unknown; skip?: unknown; type?: unknown; from?: unknown; notify?: Notify };
    if (typeof to !== "string" || typeof type !== "string" || !notify || typeof notify !== "object") return refuse("bad_frame", "в push нужны to, type и notify");
    if (!Array.isArray(skip)) return refuse("bad_frame", "skip — список адресов устройств");
    const line = { from, type };
    const fitted = fit({ type, from: asker, notify }) ?? refuse("bad_frame", "уведомление не влезает в 4 096 Б и без notify.body", { client: to, type });
    // SQL отбирает по концу адреса, правило «доходит ли» — у протокола
    const { results } = await env.DB.prepare("SELECT client, endpoint, p256dh, auth, kid FROM subs WHERE substr(client, -length(?1)) = ?1").bind(to).all<Sub>();
    const targets = results.filter((s) => reaches(to, s.client) && !skip.includes(s.client));
    if (!targets.length) refuse("gone", kindOf(to) === "user" ? "пушить некому: подписок нет или все на связи" : "подписки нет", { client: to, type });
    const kids = targets.flatMap((s) => (s.kid ? [s.kid] : []));
    const revoked = new Set(kids.length ? await within(env.GATE.revoked(kids), "gate не ответил на revoked") : []);
    for (const s of targets.filter((x) => x.kid && revoked.has(x.kid))) {
      await env.DB.prepare("DELETE FROM subs WHERE client = ? AND kid = ?").bind(s.client, s.kid).run();
      log({ kind: "refuse", ev: "push.send", word: "gone", why: `пропуск ${s.kid} отозван: подписка удалена`, client: s.client, type });
    }
    const live = targets.filter((s) => !(s.kid && revoked.has(s.kid)));
    const jwk = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
    const outcomes = await Promise.all(live.map((s) => deliver(env, jwk, s, fitted.plain, { ...line, cut: fitted.cut })));
    if (outcomes.includes("sent")) return undefined;
    return refuse(outcomes.includes("push_failed") ? "push_failed" : "gone", "");
  },
};

/** Кадр → ответ отправителю. Отказ — строка журнала и reply со словом; прочие ошибки летят дальше: вход отвечает failed. */
async function serve(env: Env, f: Frame): Promise<Frame[]> {
  const { id, from } = f;
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", why: "push ответов не ждёт", from });
    return [];
  }
  try {
    const off = accepts(f, CONTRACT);
    if (off) refuse(off.word, off.why);
    if (!id) return refuse("bad_frame", `${f.type} без id — ответить некому`);
    if (!from) refuse("bad_frame", "нет from — имя клиента ставит relay");
    return [{ ...ok(id, await HANDLERS[f.type as keyof typeof CONTRACT](f, env)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    if (e.why) log({ kind: "refuse", ev: f.type, word: e.word, why: e.why, from, ...e.row });
    return id ? [{ ...fail(id, e.word), to: from }] : [];
  }
}

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => serve(this.env, f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return serve(this.env, f);
  }
}

export default Participant;
