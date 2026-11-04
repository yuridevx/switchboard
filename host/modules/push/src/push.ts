// Модуль push: кадр для людей — тем из них, кого нет на связи, пушем. Кто на связи — последний roster; подписки и шифрование — у Worker'а push.
// Своего хранилища нет: начатые push.send ядро доводит до ответа.
import type { Frame, Host, Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { kindOf, reaches } from "@switchboard/protocol";

type Body = { type: string; from?: string; notify: unknown };

export function make(): Module {
  let host: Host;

  /** Один пуш; true — ушёл. Подписки нет — обычный исход, остальное — остановка со словом. */
  async function push(to: string, body: Body, online: string[]): Promise<boolean> {
    // адрес человека: его устройства на связи пуша не получают
    const skip = kindOf(to) === "user" ? online.filter((c) => reaches(to, c)) : [];
    const r = await host.request("push.send", { push: { to, ...(skip.length ? { skip } : {}), ...body } });
    if (r.ok) return true;
    if (r.error === "gone") host.log({ ev: "push.send", word: "gone", why: `${to}: подписки нет — ${body.type} без пуша` });
    else host.log({ kind: "stop", ev: "push.send", word: r.error, why: `push.send ${to}: ${r.error} — ${body.type} без пуша` });
    return false;
  }

  async function notify(req: Frame): Promise<{ pushed: string[] }> {
    const { clients, frame } = req as { clients?: unknown; frame?: { type?: unknown; from?: string; notify?: unknown } };
    if (!Array.isArray(clients) || typeof frame?.type !== "string" || !frame.notify) throw refuse("bad_frame", "notify: нужны clients и frame { type, notify }");
    const body: Body = { type: frame.type, ...(frame.from !== undefined ? { from: frame.from } : {}), notify: frame.notify };
    const roster = host.roster() as { clients?: string[] } | null;
    if (!roster) {
      host.log({ ev: "notify", why: `${body.type} → ${clients.join(", ")}: roster ещё не пришёл — пуша нет` });
      return { pushed: [] };
    }
    const online = roster.clients ?? [];
    // пуш — людям и их устройствам, сессиям и машинам нет; устройству на связи кадр дошёл без пуша
    const away = (clients as string[]).filter((c) => kindOf(c) === "user" || (kindOf(c) === "device" && !online.includes(c)));
    const results = await Promise.all(away.map((to) => push(to, body, online)));
    return { pushed: away.filter((_, i) => results[i]) };
  }

  return {
    requests: { notify },
    start(h) {
      host = h;
    },
    stop() {},
  };
}
