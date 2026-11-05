// Связь страницы с флотом. Соединения, ping и паузы — у клиента флота из контракта relay; здесь — одно состояние на весь флот:
// флот открывается, когда ответили все машины; дальше open, пока открыта хоть одна; возврат одной машины — отдельное событие.
import { fleet, type FleetClient, type Roster, type WsCtor } from "@switchboard/relay";
import type { Frame, Reply } from "@switchboard/protocol";
import type { ConnState } from "./types.ts";

export type LinkOptions = {
  workers: Record<string, string>;
  key: string;
  fetch?: typeof fetch;
  WebSocket?: unknown;
  pauseMs?: number;
  on: {
    /** состояние флота сменилось; open — вместе с собранным roster */
    state(state: ConnState, why?: string, roster?: Roster, address?: string | null): void;
    /** соединение оборвалось, снова — в retryAt */
    retry(retryAt: number, why: string): void;
    /** roster открытого флота; machines — вернувшиеся, пришедшие и перезапустившиеся машины */
    roster(r: Roster, machines: string[]): void;
    frame(f: Frame): void;
  };
};

export type FleetLink = {
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): void;
  close(reason: string): void;
};

const sinceOf = (r: Roster) => new Map(r.machines.map((m) => [m.machine, m.since]));

export function connect(o: LinkOptions): FleetLink {
  let closed = false;
  let state: ConnState = "connecting";
  /** флот собран и roster отдан */
  let gathered = false;
  /** список машин у gate: пуст или не получен */
  let list: "wait" | "empty" | "failed" = "wait";
  let known = new Map<string, number>();

  const whole = (): ConnState => {
    const all = [...client.links().values()].map((l) => l.state);
    if (!all.length) return list === "empty" ? "open" : list === "failed" ? "closed" : "connecting";
    if (gathered ? all.includes("open") : !all.includes("connecting") && all.includes("open")) return "open";
    return all.includes("connecting") ? "connecting" : "closed";
  };

  /** Сверить состояние флота: собрался — open с roster; разошёлся — новый сбор. */
  function settle() {
    const now = whole();
    if (now !== "open") gathered = false;
    if (now === "open" && !gathered) {
      gathered = true;
      const r = client.roster;
      known = sinceOf(r);
      state = now;
      return o.on.state(now, undefined, r, client.addr);
    }
    if (now !== state) o.on.state((state = now));
  }

  function onRoster() {
    if (!gathered) return settle();
    const r = client.roster;
    const was = known;
    known = sinceOf(r);
    o.on.roster(r, r.machines.map((m) => m.machine).filter((m) => was.get(m) !== known.get(m)));
  }

  const client: FleetClient = fleet({
    workers: o.workers,
    key: o.key,
    fetch: o.fetch,
    WebSocket: o.WebSocket as WsCtor | undefined,
    pauseMs: o.pauseMs,
    onFrame(f) {
      if (closed) return;
      if (f.type === "roster") onRoster();
      else o.on.frame(f);
    },
    onState(machine, s, why, retryAt) {
      if (closed) return;
      if (s === "stopped") return o.on.state((state = "stopped"), why);
      // открытие соединения: следом придёт его roster
      if (s === "open" && machine) return;
      if (!machine) list = s === "open" ? "empty" : "failed";
      if (s === "closed") known.delete(machine);
      settle();
      if (s === "closed") o.on.retry(retryAt!, why ?? "");
    },
  });

  return {
    request: (f, read) => client.request(f, read),
    send: (f) => void client.send(f),
    close(reason) {
      closed = true;
      client.close(1000, reason);
    },
  };
}
