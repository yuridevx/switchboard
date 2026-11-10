// Разговор сессии на странице: история страницами, лента по подписке, свёртка в строки; своё сообщение видно сразу.
import { sessionHistory, sessionRead, sessionUnwatch, sessionWatch, type SdkEvent } from "@sb/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { fold, type Msg, type View } from "../chat/fold.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";

/** Текст сообщения человека в записи ленты; не сообщение человека — null. */
function userText(e: SdkEvent): string | null {
  if (e.type !== "user") return null;
  const c = (e as Msg).message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b: Msg) => b.type === "tool_result")) return null;
  return c.filter((b: Msg) => b.type === "text").map((b: Msg) => String(b.text)).join("\n");
}

/** Слияние истории и живого по uuid: порядок истории, новое — в конец. Запись ленты с тем же текстом заменяет своё сообщение, показанное заранее. */
export function mergeEvents(base: SdkEvent[], add: SdkEvent[]): SdkEvent[] {
  const seen = new Set(base.map((e) => e.uuid).filter(Boolean));
  const fresh = add.filter((e) => !e.uuid || !seen.has(e.uuid));
  if (!fresh.length) return base;
  const echoed = new Set<SdkEvent>();
  for (const e of fresh) {
    const text = (e as Msg)._local ? null : userText(e);
    if (text === null) continue;
    const mine = base.find((b) => (b as Msg)._local && !echoed.has(b) && userText(b)?.trim() === text.trim());
    if (mine) echoed.add(mine);
  }
  return [...(echoed.size ? base.filter((b) => !echoed.has(b)) : base), ...fresh];
}

export type Talk = {
  view: View; events: SdkEvent[]; loading: boolean; error: unknown; more: boolean; loadMore(): void;
  /** своё сообщение — в ленту сразу: отправлено или встало в очередь; ответ — номер для отмены */
  say(text: string, queued: boolean): string;
  /** убрать своё сообщение (отмена очереди, отказ отправки) */
  unsay(id: string): void;
};

let localSeq = 0;

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
    if (!online) return void setLoading(false);
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

  const say = useCallback((text: string, queued: boolean) => {
    const id = `local-${++localSeq}`;
    setEvents((e) => [...e, { type: "user", uuid: id, message: { role: "user", content: text }, _local: true, ...(queued ? { _queued: true } : {}) } as SdkEvent]);
    return id;
  }, []);
  const unsay = useCallback((id: string) => setEvents((e) => e.filter((x) => x.uuid !== id)), []);

  const view = useMemo(() => fold(events as Msg[]), [events]);
  return { view, events, loading, error, more, loadMore, say, unsay };
}

/** «Прочитано»: открытый разговор снимает пометку у человека на всех устройствах. */
export function useMarkRead(callsign: string) {
  const unread = useFleet((f) => !!f.you && !!f.sessions[callsign]?.unread?.includes(f.you.person));
  useEffect(() => {
    if (unread) api.call(sessionRead, { to: callsign }).catch(() => {});
  }, [callsign, unread]);
}
