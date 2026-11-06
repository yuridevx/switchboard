// Клиент флота для живых сценариев и эталонов: адреса тестового флота (или SWITCHBOARD_WORKERS — одна карта адресов,
// relay в ней — объекты машин), соединение с relay каждой машины, к Worker'ам — POST. state open — открыты все известные
// машины: сценарий ждёт флот целиком.
import { fleet, relayWs, type FleetClient, type Frame, type LinkState, type Roster } from "@switchboard/relay";

export const WORKERS: Record<string, string> = process.env.SWITCHBOARD_WORKERS
  ? JSON.parse(process.env.SWITCHBOARD_WORKERS)
  : {
      relay: "https://switchboard.yuridevx1608.workers.dev/",
      ...Object.fromEntries(["gate", "push", "points", "ledger", "github", "prefs", "fleetkeys", "releases"].map((n) => [n, `https://switchboard-${n}.yuridevx1608.workers.dev/`])),
    };

/** адрес объектов relay — для сценариев, которые открывают сокет сами */
export const RELAY = relayWs(WORKERS);

export type Client = Pick<FleetClient, "request" | "send" | "close" | "links"> & { readonly state: LinkState; readonly roster: Roster | null };

/** Клиент флота с пропуском key; machine и hello — у программы, которая входит как машина (смоук). */
export function client(key: string, o: { onFrame?: (f: Frame) => void; machine?: string; hello?: () => Record<string, unknown> } = {}): Client {
  // отказ пропуску у gate (keys.list) — тоже остановка
  let refused = false;
  const c = fleet({
    workers: WORKERS,
    key,
    machine: o.machine,
    hello: o.hello,
    onFrame: o.onFrame ? (f) => o.onFrame!(f) : undefined,
    onState: (m, st) => void (m === "" && st === "stopped" && (refused = true)),
  });
  return {
    get state(): LinkState {
      const all = [...c.links().values()];
      if (refused || all.some((l) => l.state === "stopped")) return "stopped";
      return all.length && all.every((l) => l.state === "open") ? "open" : "connecting";
    },
    get roster() {
      return [...c.links().values()].some((l) => l.state === "open") ? c.roster : null;
    },
    request: (f, read) => c.request(f, read),
    send: (f) => c.send(f),
    close: (code, reason) => c.close(code, reason),
    links: () => c.links(),
  };
}
