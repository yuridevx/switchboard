// Подписки push над базой D1 модуля: строка на устройство с номером пропуска; push.key, push.subscribe, push.send.
import { accepts, CALL_MS, fail, kindOf, ok, reaches, within, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { encrypt, fit, publicKey, unb64u, vapidJwt } from "./webpush.ts";

/** Срок хранения пуша у службы, с: сутки. */
export const TTL = 86400;

type Row = { client: string; endpoint: string; p256dh: string; auth: string; at: number; kid: string | null };

/** Кадр с to: ".push" → кадры, которые push шлёт в ответ (reply тому, кто спросил). */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const answer = (r: Frame): Frame[] => (f.id ? [{ ...r, to: from }] : []);
  const refuse = (word: string, why: string, extra: Record<string, unknown> = {}): Frame[] => {
    log({ kind: "refuse", ev: f.type, word, why, from, ...extra });
    return f.id ? answer(fail(f.id, word)) : [];
  };

  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "push ответов не ждёт" });
    return [];
  }
  const bad = accepts(f, CONTRACT);
  if (bad) return refuse(bad.word, bad.why);

  const db = env.DB;
  switch (f.type) {
    case "push.key":
      return answer(ok(f.id ?? "", { key: publicKey(JSON.parse(env.VAPID_PRIVATE)) }));

    case "push.subscribe": {
      const why = checkSub(f.sub);
      if (why) return refuse("bad_frame", why);
      if (!from) return refuse("bad_frame", "нет from — имя клиента ставит relay");
      const sub = f.sub as { endpoint: string; keys: { p256dh: string; auth: string } };
      // одна строка на устройство: новая подписка заменяет прежнюю; номер пропуска — чтобы отзыв гасил уведомления
      await db
        .prepare("INSERT OR REPLACE INTO subs (client, endpoint, p256dh, auth, at, kid) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(from, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now(), typeof f.fromKid === "string" ? f.fromKid : null)
        .run();
      log({ kind: "note", ev: "subscribe", client: from, host: new URL(sub.endpoint).host });
      return answer(ok(f.id ?? ""));
    }

    case "push.send": {
      const p = f.push as { to?: unknown; skip?: unknown; type?: unknown; from?: unknown; notify?: unknown } | undefined;
      if (!p || typeof p !== "object" || typeof p.to !== "string" || typeof p.type !== "string" || !p.notify || typeof p.notify !== "object")
        return refuse("bad_frame", "в push нужны to, type и notify");
      const skip = p.skip ?? [];
      if (!Array.isArray(skip) || !skip.every((s) => typeof s === "string")) return refuse("bad_frame", "skip — список адресов устройств");
      const to = p.to;
      const type = p.type;
      // кому пушить: подписки, до которых доходит to (адрес человека — все его устройства), кроме skip
      const found =
        kindOf(to) === "user"
          ? (await db.prepare("SELECT * FROM subs").all<Row>()).results.filter((r) => reaches(to, r.client) && !skip.includes(r.client))
          : (await db.prepare("SELECT * FROM subs WHERE client = ?").bind(to).all<Row>()).results;
      // отозванный пропуск подписки — строка удалена, ему не пушим; номера сверяются одним вызовом gate
      const kids = found.flatMap((r) => (r.kid ? [r.kid] : []));
      const gone = kids.length ? new Set(await within(env.GATE.revoked(kids), "gate не ответил на revoked")) : new Set<string>();
      for (const r of found.filter((x) => x.kid && gone.has(x.kid))) {
        await db.prepare("DELETE FROM subs WHERE client = ? AND kid = ?").bind(r.client, r.kid).run();
        log({ kind: "refuse", ev: f.type, word: "gone", why: `пропуск ${r.kid} отозван: подписка удалена`, from, client: r.client, type });
      }
      const rows = found.filter((r) => !(r.kid && gone.has(r.kid)));
      if (!rows.length) return refuse("gone", kindOf(to) === "user" ? "пушить некому: подписок нет или все на связи" : "подписки нет", { client: to, type });
      const msg = { type, from: typeof p.from === "string" ? p.from : undefined, notify: p.notify as Record<string, unknown> };
      const body = fit(msg);
      if (!body) return refuse("bad_frame", "уведомление не влезает в 4 096 Б и без notify.body", { client: to, type });
      const jwk = JSON.parse(env.VAPID_PRIVATE) as JsonWebKey;
      // строка журнала на каждое устройство; ответ ok — пуш ушёл хотя бы одному
      const words = await Promise.all(
        rows.map(async (row): Promise<string> => {
          const cipher = await encrypt(body.bytes, unb64u(row.p256dh), unb64u(row.auth));
          const jwt = await vapidJwt(jwk, row.endpoint, env.VAPID_SUB, Date.now());
          const host = new URL(row.endpoint).host;
          const say = (word: string, why: string, extra: Record<string, unknown>) => {
            log({ kind: "refuse", ev: f.type, word, why, from, ...extra });
            return word;
          };
          let status: number;
          try {
            const res = await fetch(row.endpoint, {
              method: "POST",
              signal: AbortSignal.timeout(CALL_MS),
              headers: {
                authorization: `vapid t=${jwt}, k=${publicKey(jwk)}`,
                "content-encoding": "aes128gcm",
                "content-type": "application/octet-stream",
                ttl: String(TTL),
                urgency: "high",
              },
              body: cipher,
            });
            status = res.status;
            await res.body?.cancel();
          } catch (e) {
            return say("push_failed", `служба не ответила: ${String(e)}`, { client: row.client, type, host });
          }
          const what = { client: row.client, type, status, host };
          if (status === 201) {
            log({ kind: "note", ev: "sent", from, ...what, bytes: cipher.length, cut: body.cut });
            return "sent";
          }
          if (status === 404 || status === 410) {
            // подписки больше нет; строку, которую клиент успел заменить, не трогаем
            await db.prepare("DELETE FROM subs WHERE client = ? AND endpoint = ?").bind(row.client, row.endpoint).run();
            return say("gone", `служба ответила ${status}: подписки нет, строка удалена`, what);
          }
          return say("push_failed", `служба ответила ${status}`, what);
        }),
      );
      if (words.includes("sent")) return answer(ok(f.id ?? "", { cut: body.cut }));
      return f.id ? answer(fail(f.id, words.includes("push_failed") ? "push_failed" : "gone")) : [];
    }
  }
  return refuse("unknown_request", `push не обслуживает ${f.type}`);
}

/** https-адрес, который примет отправка: её new URL бросает на всём, что не разбирается. */
function isHttps(x: unknown): boolean {
  return typeof x === "string" && URL.canParse(x) && new URL(x).protocol === "https:";
}

/** Подписка по контракту: https-адрес, p256dh — точка P-256 65 Б, auth — 16 Б. Иначе — причина словами. */
function checkSub(sub: unknown): string | null {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  if (!s || typeof s !== "object") return "нет sub";
  if (!isHttps(s.endpoint)) return "в подписке нет https-адреса";
  if (!s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return "в подписке нет ключей";
  try {
    if (unb64u(s.keys.p256dh).length !== 65) return "p256dh — не точка P-256 в 65 Б";
    if (unb64u(s.keys.auth).length !== 16) return "auth — не 16 Б";
  } catch {
    return "ключи подписки — не base64url";
  }
  return null;
}
