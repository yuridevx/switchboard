// Модуль watch: живая лента сессии для зрителей. Сообщения SDK как есть, пачками: первое сообщение
// открывает окно, через WINDOW_MS всё окно уходит одним кадром session.events всем зрителям.
// Никто не смотрит — ничего не шлёт и не копит. Зрители — в хранилище сессии: переживают перезапуск Host.
import type { Frame, Host, Module, SDKMessage, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";

/** Окно пачки — как в опыте 17. */
export const WINDOW_MS = 100;

/** session.events — один кадр на всех зрителей; relay раздаёт по to. */
export type EventsFrame = { type: "session.events"; v: 1; from: string; to: string[]; seq: number; events: SDKMessage[] };

type Batch = { events: SDKMessage[]; timer: ReturnType<typeof setTimeout> };

export function make(): Module {
  let host: Host;
  /** номер пачки сессии с 1 в каждом процессе Host: разрыв клиент видит по seq */
  const seq = new Map<string, number>();
  /** открытые пачки по callsign */
  const open = new Map<string, Batch>();

  const viewers = (s: Session) => s.store<string[]>().get() ?? [];

  /** Зритель — отправитель запроса: клиенту его ставит relay, модулю этой машины — Host. */
  function viewer(req: Frame, from?: string): string {
    if (!from) throw refuse("bad_frame", `${req.type}: нет from`);
    return from;
  }

  function flush(callsign: string): void {
    const b = open.get(callsign);
    if (!b) return;
    open.delete(callsign);
    clearTimeout(b.timer);
    const s = host.session(callsign);
    const to = s ? viewers(s) : [];
    if (!to.length) return; // зрителей не осталось — пачка пропала
    const n = (seq.get(callsign) ?? 0) + 1;
    seq.set(callsign, n);
    // связи нет — кадр пропал: очереди нет, клиент добирает историей по разрыву seq
    host.emit({ type: "session.events", v: 1, from: callsign, to, seq: n, events: b.events } satisfies EventsFrame);
  }

  return {
    session: () => ({ includePartialMessages: true }),
    requests: {
      "session.watch"(req, ctx) {
        const s = host.session(req.callsign as string)!;
        const v = viewer(req, ctx.from);
        s.store<string[]>().update((cur = []) => (cur.includes(v) ? cur : [...cur, v]));
        return undefined;
      },
      "session.unwatch"(req, ctx) {
        const s = host.session(req.callsign as string)!;
        const v = viewer(req, ctx.from);
        s.store<string[]>().update((cur = []) => (cur.includes(v) ? cur.filter((x) => x !== v) : cur));
        return undefined;
      },
      "session.watchers"(req) {
        return viewers(host.session(req.callsign as string)!);
      },
    },
    on: {
      event(s, msg) {
        const cs = s.info.callsign;
        const b = open.get(cs);
        if (b) {
          b.events.push(msg);
          return;
        }
        if (!viewers(s).length) return;
        open.set(cs, { events: [msg], timer: setTimeout(() => flush(cs), WINDOW_MS) });
      },
      // roster без клиента — он ушёл: снять его из зрителей всех сессий машины
      frame(f) {
        if (f.type !== "roster") return;
        const online = new Set((f.clients as string[] | undefined) ?? []);
        for (const { callsign } of host.sessions()) {
          const st = host.session(callsign)!.store<string[]>();
          const cur = st.get() ?? [];
          const keep = cur.filter((v) => online.has(v));
          if (keep.length !== cur.length) st.set(keep);
        }
      },
    },
    start(h) {
      host = h;
    },
    // штатная остановка: дослать открытые пачки, снять таймеры
    stop() {
      for (const cs of [...open.keys()]) flush(cs);
    },
  };
}
