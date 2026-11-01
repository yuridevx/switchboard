// Модуль push: пуш клиенту, которого нет на связи. Решение — по последнему roster;
// подписки, ключ VAPID и шифрование — у Worker-модуля push. Своего хранилища нет.
import type { Frame, Host, Module } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

/** Что показать: заголовок, текст, кнопки и tag. Пишет модуль, чей кадр идёт человеку. */
export type Notify = { title?: string; body?: string; actions?: Array<{ title: string; frame?: unknown }>; tag?: string; [k: string]: unknown };

/** notify v1: кадр для этих клиентов; кого нет на связи — достать пушем. */
export type NotifyRequest = { clients: string[]; frame: { type: string; from?: string; notify: Notify } };
export type NotifyResult = { pushed: string[] };

type Roster = { clients?: string[]; workers?: Array<{ name: string; contract?: Record<string, number> }> };

/** Версия push.send, которую зовёт модуль: та же, что в uses. */
const SEND_V = 1;

export function make(): Module {
  let host: Host;
  /** последний roster; null — после старта Host его ещё не было */
  let roster: Roster | null = null;

  async function notify(req: Frame): Promise<NotifyResult> {
    const clients = req.clients;
    const frame = req.frame as NotifyRequest["frame"] | undefined;
    if (!Array.isArray(clients) || !frame || typeof frame.type !== "string" || !frame.notify) throw refuse("bad_frame", "notify: нужны clients и frame { type, notify }");
    if (!roster) {
      host.log({ ev: "notify", why: `${frame.type} → ${clients.join(", ")}: roster ещё не пришёл — пуша нет` });
      return { pushed: [] };
    }
    const online = new Set(roster.clients ?? []);
    // пуш — только устройствам людей: сессиям и машинам пушей нет
    const away = clients.filter((c): c is string => kindOf(c) === "device" && !online.has(c));
    if (!away.length) return { pushed: [] };
    const worker = roster.workers?.find((w) => w.name === "push");
    if (worker?.contract?.["push.send"] !== SEND_V) {
      host.log({ kind: "stop", ev: "push.send", word: "offline", why: `push.send v${SEND_V} — нет в roster; ${frame.type} → ${away.join(", ")} без пуша` });
      return { pushed: [] };
    }
    const sent = await Promise.all(
      away.map(async (to) => {
        const push = { to, type: frame.type, ...(frame.from !== undefined ? { from: frame.from } : {}), notify: frame.notify };
        const r = await host.request("push.send", { v: SEND_V, push });
        if (r.ok) return to;
        if (r.error === "gone") host.log({ ev: "push.send", word: "gone", why: `${to}: подписки нет — ${frame.type} без пуша` });
        else host.log({ kind: "stop", ev: "push.send", word: r.error, why: `push.send ${to}: ${r.error} — ${frame.type} без пуша` });
        return null;
      }),
    );
    return { pushed: sent.filter((x): x is string => x !== null) };
  }

  return {
    requests: { notify },
    on: {
      frame(f) {
        if (f.type === "roster") roster = f as Roster;
      },
    },
    start(h) {
      host = h;
    },
    // хранить нечего: начатые push.send ядро доводит до ответа
    stop() {},
  };
}
