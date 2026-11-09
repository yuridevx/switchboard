// Разговор сессии на странице: история страницами, лента по подписке, свёртка в строки.
import { sessionHistory, sessionRead, sessionUnwatch, sessionWatch, type SdkEvent } from "@sb/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { fold, type Msg, type View } from "../chat/fold.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";

/** Слияние истории и живого по uuid: порядок истории, новое — в конец. */
export function mergeEvents(base: SdkEvent[], add: SdkEvent[]): SdkEvent[] {
  const seen = new Set(base.map((e) => e.uuid).filter(Boolean));
  const fresh = add.filter((e) => !e.uuid || !seen.has(e.uuid));
  return fresh.length ? [...base, ...fresh] : base;
}

export type Talk = { view: View; events: SdkEvent[]; loading: boolean; error: unknown; more: boolean; loadMore(): void };

export function useTalk(callsign: string): Talk {
  const [events, setEvents] = useState<SdkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const first = useRef<string | undefined>(undefined);
  const online = useFleet((f) => f.machines[machineOfCall(callsign)]?.online !== false);

  useEffect(() => {
    let alive = true;
    setEvents([]);
    setLoading(true);
    setError(null);
    const link = api.transport.open("watch", {
      machine: machineOfCall(callsign),
      onFrame: (f) => {
        if (alive && f.type === "session.events" && f.callsign === callsign) setEvents((e) => mergeEvents(e, f.events as SdkEvent[]));
      },
    });
    api.call(sessionWatch, { to: callsign }).catch(() => {});
    api.call(sessionHistory, { to: callsign, limit: 80 }).then(
      (r) => {
        if (!alive) return;
        first.current = r.events[0]?.uuid;
        setMore(r.more);
        setEvents((live) => mergeEvents(r.events, live));
        setLoading(false);
      },
      (e) => alive && (setError(e), setLoading(false)),
    );
    return () => {
      alive = false;
      link.close();
      api.call(sessionUnwatch, { to: callsign }).catch(() => {});
    };
  }, [callsign, online]);

  const loadMore = useCallback(() => {
    if (!first.current) return;
    api.call(sessionHistory, { to: callsign, before: first.current, limit: 80 }).then((r) => {
      first.current = r.events[0]?.uuid ?? first.current;
      setMore(r.more);
      setEvents((e) => mergeEvents(r.events, e));
    }, () => {});
  }, [callsign]);

  const view = useMemo(() => fold(events as Msg[]), [events]);
  return { view, events, loading, error, more, loadMore };
}

/** «Прочитано»: открытый разговор снимает пометку у человека на всех устройствах. */
export function useMarkRead(callsign: string) {
  const unread = useFleet((f) => !!f.you && !!f.sessions[callsign]?.unread?.includes(f.you.person));
  useEffect(() => {
    if (unread) api.call(sessionRead, { to: callsign }).catch(() => {});
  }, [callsign, unread]);
}
