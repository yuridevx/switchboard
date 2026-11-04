// Кадр с to: ".push" → кадры в ответ. push.key, push.subscribe, push.send; чужие имена и версии отсекает протокол.
import { accepts, CALL_MS, fail, kindOf, ok, within, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";
import { log, type Line } from "./log.ts";
import { dropByEndpoint, dropByKid, reach, save, type Sub } from "./subs.ts";
import { authorization, encrypt, fit, fromB64u, publicKey } from "./webpush.ts";

/** Срок хранения пуша у службы: сутки, с. */
const TTL = 86400;

/** Один разговор: кто спросил, ответ ему и отказ со строкой журнала. */
type Turn = {
  env: Env;
  f: Frame;
  from: string;
  answer(reply: Frame): Frame[];
  refuse(word: string, why: string, extra?: Partial<Line>): Frame[];
};

const HANDLERS: Record<keyof typeof CONTRACT, (t: Turn) => Frame[] | Promise<Frame[]>> = {
  "push.key": ({ env, f, answer }) => answer(ok(f.id ?? "", { key: publicKey(JSON.parse(env.VAPID_PRIVATE)) })),
  "push.subscribe": subscribe,
  "push.send": send,
};

export async function handle(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  // ответов push не ждёт; отказ на ответ породил бы ответ на отказ
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "push ответов не ждёт" });
    return [];
  }
  const answer: Turn["answer"] = (reply) => (f.id ? [{ ...reply, to: from }] : []);
  const refuse: Turn["refuse"] = (word, why, extra = {}) => {
    log({ kind: "refuse", ev: f.type, word, why, from, ...extra });
    return answer(fail(f.id ?? "", word));
  };
  const bad = accepts(f, CONTRACT);
  if (bad) return refuse(bad.word, bad.why);
  return HANDLERS[f.type as keyof typeof CONTRACT]({ env, f, from, answer, refuse });
}

/** Что не так с подпиской браузера; всё верно — null. */
function subscriptionFault(sub: unknown): string | null {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  if (!s || typeof s !== "object") return "нет sub";
  // отправка зовёт new URL: адрес, который он не разберёт, провалил бы весь пуш
  if (typeof s.endpoint !== "string" || !URL.canParse(s.endpoint) || new URL(s.endpoint).protocol !== "https:") return "в подписке нет https-адреса";
  if (typeof s.keys?.p256dh !== "string" || typeof s.keys.auth !== "string") return "в подписке нет ключей";
  try {
    if (fromB64u(s.keys.p256dh).length !== 65) return "p256dh — не точка P-256 в 65 Б";
    if (fromB64u(s.keys.auth).length !== 16) return "auth — не 16 Б";
  } catch {
    return "ключи подписки — не base64url";
  }
  return null;
}

async function subscribe({ env, f, from, answer, refuse }: Turn): Promise<Frame[]> {
  const fault = subscriptionFault(f.sub);
  if (fault) return refuse("bad_frame", fault);
  if (!from) return refuse("bad_frame", "нет from — имя клиента ставит relay");
  const { endpoint, keys } = f.sub as { endpoint: string; keys: { p256dh: string; auth: string } };
  await save(env.DB, { client: from, endpoint, ...keys, kid: typeof f.fromKid === "string" ? f.fromKid : null });
  log({ kind: "note", ev: "subscribe", client: from, host: new URL(endpoint).host });
  return answer(ok(f.id ?? ""));
}

/** Живые подписки: строки с отозванным пропуском удаляются, номера сверяются одним вызовом gate. */
async function alive({ env, f, from }: Turn, found: Sub[], type: string): Promise<Sub[]> {
  const kids = found.flatMap((s) => (s.kid ? [s.kid] : []));
  if (!kids.length) return found;
  const revoked = new Set(await within(env.GATE.revoked(kids), "gate не ответил на revoked"));
  const live: Sub[] = [];
  for (const s of found) {
    if (!s.kid || !revoked.has(s.kid)) {
      live.push(s);
      continue;
    }
    await dropByKid(env.DB, s.client, s.kid);
    log({ kind: "refuse", ev: f.type, word: "gone", why: `пропуск ${s.kid} отозван: подписка удалена`, from, client: s.client, type });
  }
  return live;
}

/** Один POST службе пушей: исход словом и строка журнала. */
async function deliver({ env, f, from }: Turn, s: Sub, plain: { bytes: Uint8Array; cut: boolean }, type: string): Promise<"sent" | "gone" | "push_failed"> {
  const vapid = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
  const body = await encrypt(plain.bytes, s.p256dh, s.auth);
  const authz = await authorization(vapid, s.endpoint, env.VAPID_SUB);
  const host = new URL(s.endpoint).host;
  const headers = { authorization: authz, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(TTL), urgency: "high" };
  const where = { client: s.client, type, host };
  let status: number;
  try {
    const res = await fetch(s.endpoint, { method: "POST", signal: AbortSignal.timeout(CALL_MS), headers, body });
    status = res.status;
    await res.body?.cancel();
  } catch (e) {
    log({ kind: "refuse", ev: f.type, word: "push_failed", why: `служба не ответила: ${String(e)}`, from, ...where });
    return "push_failed";
  }
  if (status === 201) {
    log({ kind: "note", ev: "sent", from, ...where, status, bytes: body.length, cut: plain.cut });
    return "sent";
  }
  if (status === 404 || status === 410) {
    await dropByEndpoint(env.DB, s.client, s.endpoint);
    log({ kind: "refuse", ev: f.type, word: "gone", why: `служба ответила ${status}: подписки нет, строка удалена`, from, ...where, status });
    return "gone";
  }
  log({ kind: "refuse", ev: f.type, word: "push_failed", why: `служба ответила ${status}`, from, ...where, status });
  return "push_failed";
}

async function send(t: Turn): Promise<Frame[]> {
  const { env, f, answer, refuse } = t;
  const p = f.push as { to?: unknown; skip?: unknown; type?: unknown; from?: unknown; notify?: unknown } | undefined;
  if (typeof p?.to !== "string" || typeof p.type !== "string" || !p.notify || typeof p.notify !== "object") return refuse("bad_frame", "в push нужны to, type и notify");
  const skip = p.skip ?? [];
  if (!Array.isArray(skip) || !skip.every((a) => typeof a === "string")) return refuse("bad_frame", "skip — список адресов устройств");
  const { to, type } = p as { to: string; type: string };
  const subs = await alive(t, await reach(env.DB, to, skip), type);
  if (!subs.length) return refuse("gone", kindOf(to) === "user" ? "пушить некому: подписок нет или все на связи" : "подписки нет", { client: to, type });
  const plain = fit({ type, from: typeof p.from === "string" ? p.from : undefined, notify: p.notify as Record<string, unknown> });
  if (!plain) return refuse("bad_frame", "уведомление не влезает в 4 096 Б и без notify.body", { client: to, type });
  const outcomes = await Promise.all(subs.map((s) => deliver(t, s, plain, type)));
  if (outcomes.includes("sent")) return answer(ok(f.id ?? ""));
  return answer(fail(f.id ?? "", outcomes.includes("push_failed") ? "push_failed" : "gone"));
}
