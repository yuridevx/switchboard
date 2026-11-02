// Модуль push: пуш клиенту, которого нет на связи, и каждому устройству человека ~email не на связи. Решение — по последнему roster;
// подписки, ключ VAPID и шифрование — у Worker-модуля push. Своего хранилища нет.
import type { Frame, Host, Module } from "@switchboard/host";
import { kindOf, reaches } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

/** Что показать: заголовок, текст, кнопки и tag. Пишет модуль, чей кадр идёт человеку. */
export type Notify = { title?: string; body?: string; actions?: Array<{ title: string; frame?: unknown }>; tag?: string; [k: string]: unknown };

/** notify v1: кадр для этих клиентов; кого нет на связи — достать пушем. */
export type NotifyRequest = { clients: string[]; frame: { type: string; from?: string; notify: Notify } };
export type NotifyResult = { pushed: string[] };

type Roster = { clients?: string[] };

export function make(): Module {
  let host: Host;

  async function notify(req: Frame): Promise<NotifyResult> {
    const clients = req.clients;
    const frame = req.frame as NotifyRequest["frame"] | undefined;
    if (!Array.isArray(clients) || !frame || typeof frame.type !== "string" || !frame.notify) throw refuse("bad_frame", "notify: нужны clients и frame { type, notify }");
    // последний roster — у ядра; до первого пушить некому: кто на связи, неизвестно
    const roster = host.roster() as Roster | null;
    if (!roster) {
      host.log({ ev: "notify", why: `${frame.type} → ${clients.join(", ")}: roster ещё не пришёл — пуша нет` });
      return { pushed: [] };
    }
    const online = roster.clients ?? [];
    // пуш — только людям и их устройствам: сессиям и машинам пушей нет; устройство на связи — без пуша,
    // адрес человека — один запрос, его устройства на связи — в skip
    const away = clients.filter((c): c is string => kindOf(c) === "user" || (kindOf(c) === "device" && !online.includes(c)));
    if (!away.length) return { pushed: [] };
    const sent = await Promise.all(
      away.map(async (to) => {
        const skip = kindOf(to) === "user" ? online.filter((c) => reaches(to, c)) : [];
        const push = { to, ...(skip.length ? { skip } : {}), type: frame.type, ...(frame.from !== undefined ? { from: frame.from } : {}), notify: frame.notify };
        const r = await host.request("push.send", { push });
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
    start(h) {
      host = h;
    },
    // хранить нечего: начатые push.send ядро доводит до ответа
    stop() {},
  };
}
