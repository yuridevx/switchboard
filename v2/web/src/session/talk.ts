// Разговор сессии на странице: история страницами, лента по подписке с номерами, свёртка в строки.
// Своё сообщение видно сразу и ведёт свой статус: уходит, в очереди, принято, не ушло. Вопросы сбоку живут здесь же.
import { message, messageCancel, sessionCall, sessionHistory, sessionRead, sessionUnwatch, sessionWatch, type Frame, type SdkEvent } from "@sb/protocol";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, sayError } from "../api.ts";
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
  // статус сообщения несёт номер самого сообщения: его ключ — номер вместе со статусом
  const key = (e: SdkEvent) => (e.type === "message.status" ? `${e.uuid}:${(e as Msg).status}` : e.uuid);
  const seen = new Set(base.map(key).filter(Boolean));
  const fresh = add.filter((e) => !e.uuid || !seen.has(key(e)));
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

/** Пропуск в ленте: пачка из n событий кончается номером seq, а у зрителя последним был last. Сколько событий потеряно. */
export const missed = (last: number, seq: number, n: number): number => Math.max(0, seq - n - last);

/** Своё сообщение получило номер у сессии: показанное заранее берёт этот номер; запись ленты с ним уже пришла — показанное заранее лишнее. */
export function bindLocal(events: SdkEvent[], local: string, uuid: string, state: "queued" | "sent"): SdkEvent[] {
  if (events.some((e) => e.uuid === uuid)) return events.filter((e) => e.uuid !== local);
  return events.map((e) => (e.uuid === local ? ({ ...e, uuid, _state: state } as SdkEvent) : e));
}

const setState = (events: SdkEvent[], id: string, state: string, extra: object = {}): SdkEvent[] => events.map((e) => (e.uuid === id ? ({ ...e, _state: state, ...extra } as SdkEvent) : e));

export type FileOut = { name: string; mime: string; base64: string };
export type Priority = "now" | "next" | "later";
/** Вопрос сбоку: ответ Claude мимо разговора. */
export type Aside = { id: string; q: string; a?: string; state: "wait" | "done" | "bad" };

export type Talk = {
  view: View; events: SdkEvent[]; loading: boolean; error: unknown; more: boolean; loadMore(): void;
  /** отправить: сообщение сразу в ленте; отказ — оно остаётся с пометкой «не ушло» */
  send(text: string, files?: FileOut[], priority?: Priority): Promise<boolean>;
  /** снять своё сообщение с очереди сессии; снято — его текст, чтобы вернуть в поле ввода */
  cancel(id: string): Promise<string | null>;
  /** отправить ещё раз то, что не ушло */
  resend(id: string): void;
  /** убрать из ленты то, что не ушло */
  drop(id: string): void;
  asides: Aside[]; aside(q: string): void; dropAside(id: string): void;
};

let localSeq = 0;
const HISTORY = 80;

export function useTalk(callsign: string): Talk {
  const [events, setEvents] = useState<SdkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [asides, setAsides] = useState<Aside[]>([]);
  const first = useRef<string | undefined>(undefined);
  /** номер последнего события ленты у этого зрителя; null — подписка ещё не ответила */
  const seq = useRef<number | null>(null);
  /** что отправляли: для повтора */
  const sent = useRef(new Map<string, { text: string; files?: FileOut[]; priority?: Priority }>());
  const eventsRef = useRef<SdkEvent[]>(events);
  eventsRef.current = events;
  const online = useFleet((f) => f.machines[machineOfCall(callsign)]?.online !== false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    setEvents([]);
    setAsides([]);
    setLoading(true);
    setError(null);
    seq.current = null;
    if (!online) return void setLoading(false);
    const history = () =>
      api.call(sessionHistory, { to: callsign, limit: HISTORY }).then(
        (r) => {
          if (!alive) return;
          first.current = r.events[0]?.uuid;
          setMore(r.more);
          setEvents((live) => mergeEvents(r.events, live));
          setLoading(false);
        },
        (e) => alive && (setError(e), setLoading(false)),
      );
    /** дочитать пропущенное: что помнит Host — событиями, иначе разговор перечитывается */
    const catchUp = (after: number) =>
      api.call(sessionWatch, { to: callsign, after }).then((r) => {
        if (!alive) return;
        seq.current = r.seq;
        if (r.gap) void history();
        else if (r.events?.length) setEvents((e) => mergeEvents(e, r.events!));
      }, () => {});
    const onFrame = (f: Frame) => {
      if (!alive || f.type !== "session.events" || f.callsign !== callsign) return;
      const list = f.events as SdkEvent[];
      const at = f.seq as number;
      if (seq.current !== null && missed(seq.current, at, list.length) > 0) void catchUp(seq.current);
      if (seq.current !== null) seq.current = Math.max(seq.current, at);
      setEvents((e) => mergeEvents(e, list));
    };
    const watch = () => api.call(sessionWatch, { to: callsign }).then((r) => {
      if (!alive) return;
      seq.current = r.seq;
      // что уже ждёт в очереди сессии — видно сразу
      // работы, которые идут сейчас: в файле разговора их нет — их отдаёт Host со своим временем начала
      if (r.running?.length) setEvents((e) => mergeEvents(e, r.running!));
      if (r.queued?.length) setEvents((e) => mergeEvents(e, r.queued!.flatMap((q) => [{ type: "user", uuid: q.uuid, from: q.from, message: { role: "user", content: q.text } }, { type: "message.status", uuid: q.uuid, status: "queued" }] as SdkEvent[])));
    }, () => {});
    let opened = false;
    const link = api.transport.open("watch", {
      machine: machineOfCall(callsign),
      onFrame,
      // соединение вернулось после обрыва: подписка заново и дочитка пропущенного
      onState: (s) => {
        if (s !== "open") return;
        if (opened && seq.current !== null) void catchUp(seq.current);
        // подписка — когда соединение зрителя уже стоит: закрытое перед ним (другая сессия той же машины, перезагрузка) объявляет зрителя ушедшим,
        // и подписка, пришедшая раньше этого, снялась бы
        if (!opened) watch();
        opened = true;
      },
    });
    void history();
    return () => {
      alive = false;
      link.close();
      api.call(sessionUnwatch, { to: callsign }).catch(() => {});
    };
  }, [callsign, online, epoch]);

  const loadMore = useCallback(() => {
    if (!first.current) return;
    api.call(sessionHistory, { to: callsign, before: first.current, limit: HISTORY }).then((r) => {
      first.current = r.events[0]?.uuid ?? first.current;
      setMore(r.more);
      setEvents((e) => mergeEvents(r.events, e));
    }, () => {});
  }, [callsign]);

  const send = useCallback(async (text: string, files?: FileOut[], priority?: Priority) => {
    const id = `local-${++localSeq}`;
    sent.current.set(id, { text, files, priority });
    const content = files?.some((f) => f.mime.startsWith("image/"))
      ? [{ type: "text", text }, ...files.filter((f) => f.mime.startsWith("image/")).map((f) => ({ type: "image", source: { type: "base64", media_type: f.mime, data: f.base64 } }))]
      : text;
    const names = files?.filter((f) => !f.mime.startsWith("image/")).map((f) => f.name) ?? [];
    setEvents((e) => [...e, { type: "user", uuid: id, message: { role: "user", content }, _local: true, _state: "sending", ...(names.length ? { _files: names } : {}) } as SdkEvent]);
    try {
      const r = await api.call(message, { to: callsign, text, ...(files?.length ? { files } : {}), ...(priority && priority !== "next" ? { priority } : {}) });
      sent.current.delete(id);
      setEvents((e) => (r.uuid ? bindLocal(e, id, r.uuid, r.queued ? "queued" : "sent") : setState(e, id, r.queued ? "queued" : "sent")));
      return true;
    } catch (err) {
      setEvents((e) => setState(e, id, "lost", { _why: sayError(err) }));
      return false;
    }
  }, [callsign]);

  const cancel = useCallback(async (id: string) => {
    try {
      const r = await api.call(messageCancel, { to: callsign, uuid: id });
      if (!r.cancelled) return notifications.show({ message: "Сообщение уже ушло сессии", color: "orange" }), null;
      setEvents((e) => setState(e, id, "cancelled"));
      const was = eventsRef.current.find((e) => e.uuid === id);
      return (was && userText(was)) || null;
    } catch (err) {
      notifications.show({ title: "Не получилось", message: sayError(err), color: "red" });
      return null;
    }
  }, [callsign]);

  const drop = useCallback((id: string) => (sent.current.delete(id), setEvents((e) => e.filter((x) => x.uuid !== id))), []);
  const resend = useCallback((id: string) => {
    const was = sent.current.get(id);
    if (!was) return;
    drop(id);
    void send(was.text, was.files, was.priority);
  }, [drop, send]);

  const aside = useCallback((q: string) => {
    const id = `aside-${++localSeq}`;
    setAsides((a) => [...a, { id, q, state: "wait" }]);
    const settle = (patch: Partial<Aside>) => setAsides((a) => a.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    api.call(sessionCall, { to: callsign, method: "sideQuestion", args: [q] }).then(
      (r) => settle({ state: "done", a: String((r as { response?: string } | null)?.response ?? "Claude не ответил") }),
      (e) => settle({ state: "bad", a: sayError(e) }),
    );
  }, [callsign]);
  const dropAside = useCallback((id: string) => setAsides((a) => a.filter((x) => x.id !== id)), []);

  // разговор начат заново — история прежнего не нужна
  // след сброса остаётся в истории: перечитанная лента его покажет, но второй раз перечитывать не станет
  const resets = useRef(new Set<string>());
  const reset = events.find((e) => e.type === "conversation_reset" && !(e as Msg)._seen && !resets.current.has(String(e.uuid)))?.uuid;
  useEffect(() => {
    if (!reset) return;
    resets.current.add(String(reset));
    setEpoch((n) => n + 1);
  }, [reset]);

  const view = useMemo(() => fold(events as Msg[]), [events]);
  return { view, events, loading, error, more, loadMore, send, cancel, resend, drop, asides, aside, dropAside };
}

/** «Прочитано»: открытый разговор снимает пометку у человека на всех устройствах. */
export function useMarkRead(callsign: string) {
  const unread = useFleet((f) => !!f.you && !!f.sessions[callsign]?.unread?.includes(f.you.person));
  useEffect(() => {
    if (unread) api.call(sessionRead, { to: callsign }).catch(() => {});
  }, [callsign, unread]);
}

/** Черновик на каждую сессию: хранится в браузере, переживает уход со страницы. */
const DRAFT = "sb2.draft.";
export const draft = {
  get(callsign: string): string {
    try {
      return localStorage.getItem(DRAFT + callsign) ?? "";
    } catch {
      return "";
    }
  },
  set(callsign: string, text: string): void {
    try {
      if (text) localStorage.setItem(DRAFT + callsign, text);
      else localStorage.removeItem(DRAFT + callsign);
    } catch {
      /* без хранилища черновик живёт до ухода со страницы */
    }
  },
};
