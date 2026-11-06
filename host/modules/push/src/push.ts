// notify: кадр клиентам; кого нет на связи по roster — достать пушем через Worker push. Хранилища нет.
import { refuse, type Host, type Module } from "@switchboard/host";
import { kindOf, reaches, type Frame } from "@switchboard/protocol";

type Pushed = { type: string; from?: string; notify: Record<string, unknown> };

/** push.send по адресам, которых нет на связи: устройство — ему, человек — со skip его устройств на связи. */
function pushesFor(clients: string[], online: string[]): Array<{ to: string; skip?: string[] }> {
  return clients.flatMap((to) => {
    if (kindOf(to) === "device") return online.includes(to) ? [] : [{ to }];
    if (kindOf(to) === "user") {
      const skip = online.filter((c) => reaches(to, c));
      return [skip.length ? { to, skip } : { to }];
    }
    return [];
  });
}

export function make(): Module {
  let host: Host;

  async function send(push: { to: string; skip?: string[] }, frame: Pushed) {
    const r = await host.request("push.send", { push: { ...push, type: frame.type, from: frame.from, notify: frame.notify } });
    if (r.ok) return;
    if (r.error === "gone") host.log({ ev: "push.send", word: "gone", why: `${push.to}: подписки нет — ${frame.type} без пуша` });
    else host.log({ kind: "stop", ev: "push.send", word: r.error, why: `push.send ${push.to}: ${r.error} — ${frame.type} без пуша` });
  }

  return {
    start(h) {
      host = h;
    },
    requests: {
      async notify({ clients, frame }: Frame) {
        const f = frame as Pushed | undefined;
        if (!Array.isArray(clients) || typeof f?.type !== "string" || !f.notify || typeof f.notify !== "object") throw refuse("bad_frame", "notify: clients — список адресов, frame — с type и notify");
        const roster = host.roster();
        if (!roster) return void host.log({ ev: "notify", why: `${f.type} → ${clients.join(", ")}: roster ещё не пришёл — пуша нет` });
        await Promise.all(pushesFor(clients, roster.clients).map((p) => send(p, f)));
      },
    },
  };
}
