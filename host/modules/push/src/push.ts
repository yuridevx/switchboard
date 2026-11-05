// Кому пуш: устройство не на связи, человек ~email — кроме его устройств на связи. Шлёт Worker push; исход — только в журнале.
import type { Frame, Host, Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { kindOf, reaches } from "@switchboard/protocol";

type Pushed = { type: string; from?: string; notify: unknown };

async function pushTo(host: Host, to: string, skip: string[], { type, from, notify }: Pushed): Promise<void> {
  const r = await host.request("push.send", { to: ".push", push: { to, ...(skip.length ? { skip } : {}), type, ...(from === undefined ? {} : { from }), notify } });
  if (r.ok) host.log({ ev: "push.send", why: `${to}: ${type} ушёл` });
  else if (r.error === "gone") host.log({ ev: "push.send", word: "gone", why: `${to}: подписки нет — ${type} без пуша` });
  else host.log({ kind: "stop", ev: "push.send", word: r.error, why: `push.send ${to}: ${r.error} — ${type} без пуша` });
}

export function make(): Module {
  let host: Host;
  return {
    start(h) {
      host = h;
    },
    requests: {
      async notify(req: Frame) {
        const { clients, frame } = req as { clients?: unknown; frame?: Partial<Pushed> };
        if (!Array.isArray(clients) || typeof frame?.type !== "string" || !frame.notify) throw refuse("bad_frame", "notify: нужны clients и frame { type, notify }");
        const pushed = frame as Pushed;
        const roster = host.roster();
        if (!roster) {
          host.log({ ev: "notify", why: `${pushed.type} → ${clients.join(", ")}: roster ещё не пришёл — пуша нет` });
          return undefined;
        }
        const online = roster.clients;
        const sends = (clients as string[]).flatMap((to) => {
          if (kindOf(to) === "user") return [pushTo(host, to, online.filter((c) => kindOf(c) === "device" && reaches(to, c)), pushed)];
          return kindOf(to) === "device" && !online.includes(to) ? [pushTo(host, to, [], pushed)] : [];
        });
        await Promise.all(sends);
        return undefined;
      },
    },
  };
}
