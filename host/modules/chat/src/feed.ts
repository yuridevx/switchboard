// Лента разговора: сообщения SDK как есть пачками всем зрителям. Первое сообщение открывает окно, через 100 мс окно уходит одним кадром.
// Зрителей нет — ничего не шлёт и не копит. Зрители — в памяти Host: при новом Host страница подписывается заново и читает историю.
import type { Frame, Host, Module, SDKMessage, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";

const WINDOW_MS = 100;

export type Feed = Pick<Required<Module>, "requests"> & {
  on: Pick<NonNullable<Module["on"]>, "event" | "frame">;
  /** Кто смотрит сессию: им же уходят её вопросы. */
  viewers(s: Session): string[];
  /** Штатная остановка: дослать открытые пачки. */
  flushAll(): void;
};

export function makeFeed(host: () => Host): Feed {
  /** номер пачки с 1 в каждом процессе Host: разрыв клиент видит по seq */
  const seq = new Map<string, number>();
  const open = new Map<string, { events: SDKMessage[]; timer: ReturnType<typeof setTimeout> }>();

  const watching = new Map<string, string[]>();
  const viewers = (s: Session) => watching.get(s.info.callsign) ?? [];

  function flush(callsign: string): void {
    const batch = open.get(callsign);
    if (!batch) return;
    open.delete(callsign);
    clearTimeout(batch.timer);
    const s = host().session(callsign);
    const to = s ? viewers(s) : [];
    if (!to.length) return;
    const n = (seq.get(callsign) ?? 0) + 1;
    seq.set(callsign, n);
    // связи нет или кадр велик — пачка пропала, номер занят: клиент добирает историей по разрыву seq
    host().emit({ type: "session.events", v: 1, from: callsign, to, seq: n, events: batch.events });
  }

  function subscription(type: string, change: (cur: string[], viewer: string) => string[]) {
    return (req: Frame, ctx: { from?: string }) => {
      if (!ctx.from) throw refuse("bad_frame", `${type}: нет from`);
      const viewer = ctx.from;
      const callsign = host().session(req.callsign as string)!.info.callsign;
      watching.set(callsign, change(watching.get(callsign) ?? [], viewer));
      return undefined;
    };
  }

  return {
    requests: {
      "session.watch": subscription("session.watch", (cur, v) => (cur.includes(v) ? cur : [...cur, v])),
      "session.unwatch": subscription("session.unwatch", (cur, v) => cur.filter((x) => x !== v)),
    },
    on: {
      event(s, msg) {
        const callsign = s.info.callsign;
        const batch = open.get(callsign);
        if (batch) batch.events.push(msg);
        else if (viewers(s).length) open.set(callsign, { events: [msg], timer: setTimeout(() => flush(callsign), WINDOW_MS) });
      },
      // клиента нет в roster — он ушёл: снять его из зрителей всех сессий машины
      frame(f) {
        if (f.type !== "roster") return;
        const online = new Set((f.clients ?? []) as string[]);
        for (const [callsign, cur] of watching) watching.set(callsign, cur.filter((v) => online.has(v)));
      },
    },
    viewers,
    flushAll() {
      for (const callsign of [...open.keys()]) flush(callsign);
    },
  };
}
