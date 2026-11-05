// Живая лента: зрители сессии и пачки сообщений SDK раз в 100 мс. Всё в памяти: новый Host начинает без зрителей, страница подписывается заново.
import type { Host, SDKMessage, Session } from "@switchboard/host";

const WINDOW_MS = 100;

type Feed = { viewers: Set<string>; batch: SDKMessage[]; seq: number; timer: ReturnType<typeof setTimeout> | null };

export function feeds(host: () => Host) {
  const all = new Map<string, Feed>();
  const of = (callsign: string): Feed => {
    let f = all.get(callsign);
    if (!f) all.set(callsign, (f = { viewers: new Set(), batch: [], seq: 0, timer: null }));
    return f;
  };

  /** Пачка уходит, если есть кому. Нет связи — пропала; номер всё равно растёт: зритель увидит разрыв и доберёт историей. */
  function flush(callsign: string) {
    const f = of(callsign);
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
    const events = f.batch.splice(0);
    if (!events.length || !f.viewers.size) return;
    host().emit({ type: "session.events", from: callsign, to: [...f.viewers], seq: ++f.seq, events });
  }

  return {
    watch: (callsign: string, viewer: string) => void of(callsign).viewers.add(viewer),
    unwatch: (callsign: string, viewer: string) => void of(callsign).viewers.delete(viewer),
    viewers: (callsign: string) => [...of(callsign).viewers],
    event(s: Session, m: SDKMessage) {
      const f = of(s.info.callsign);
      if (!f.viewers.size) return;
      f.batch.push(m);
      f.timer ??= setTimeout(() => flush(s.info.callsign), WINDOW_MS);
    },
    /** Новый roster: кто ушёл с relay, тот больше не зритель. */
    present(clients: string[]) {
      for (const f of all.values()) for (const v of f.viewers) if (!clients.includes(v)) f.viewers.delete(v);
    },
    flushAll: () => [...all.keys()].forEach(flush),
  };
}
