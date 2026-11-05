// Клиент флота: по link на машину (список — у gate, новые — гостями из roster), кадр — в соединение его машины, к Worker'у — POST с пропуском.
import { CALL_MS, READ_MS, fail, hostOf, isReply, kindOf, machineOf, ok, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { backoff, link, newId, type Link, type LinkOptions, type LinkState, type Sent } from "./link.ts";

export type FleetOptions = Omit<LinkOptions, "url" | "onState"> & {
  /** адреса Worker'ов: relay — wss того же адреса, gate — список машин, остальные — POST кадра */
  workers: Record<string, string>;
  /** своя машина: её соединение входит как Host с полями hello */
  machine?: string;
  /** m — машина; "" — список машин у gate */
  onState?: (machine: string, state: LinkState, why?: string, retryAt?: number) => void;
  /** кадр без ожидания к Worker'у не дошёл */
  onLost?: (f: Frame, word: string) => void;
  fetch?: typeof fetch;
};

export type FleetClient = {
  /** адрес пропуска, как его назвал gate */
  readonly addr: string | null;
  /** roster флота: объединение открытых соединений */
  readonly roster: Roster;
  readonly state: LinkState;
  links(): ReadonlyMap<string, Link>;
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  close(code?: number, reason?: string): void;
};

export const relayWs = (workers: Record<string, string>): string => (workers.relay ? workers.relay.replace(/^http/, "ws").replace(/\/$/, "") : "");

/** Отказ POST: причина рядом со словом. */
const refusal = (id: string, word: string, why: string) => ({ type: "reply", id, ok: false, error: word, why }) as Reply;

/** Куда кадр: соединение, адрес Worker'а для POST или слово отказа. */
type Route = Link | string | { error: string };

export function fleet(o: FleetOptions): FleetClient {
  const { workers, key, machine } = o;
  const relay = relayWs(workers);
  const requestMs = o.requestMs ?? CALL_MS;
  const readMs = Math.min(READ_MS, requestMs);
  const links = new Map<string, Link>();
  /** откуда пришёл запрос «id|from»: ответ — тем же соединением, там его ждёт спросивший */
  const askedVia = new Map<string, Link>();
  const posts = new Set<AbortController>();
  const pause = backoff(o.pauseMs, o.maxPauseMs);
  let addr: string | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function join(m: string) {
    if (closed || links.has(m)) return;
    const via = link({
      ...o,
      url: `${relay}/m/${m}`,
      hello: m === machine ? o.hello : undefined,
      onState: (st, why, retryAt) => o.onState?.(m, st, why, retryAt),
      onFrame(f) {
        if (f.type === "roster") for (const c of (f as unknown as Roster).clients) if (kindOf(c) === "machine") join(machineOf(c)!);
        if (f.id && !isReply(f)) askedVia.set(`${f.id}|${f.from}`, via);
        o.onFrame?.(f);
      },
    });
    links.set(m, via);
  }

  /** POST кадра с пропуском; ответ — кадром при любом статусе. */
  async function post(url: string, f: Frame, ms: number): Promise<Reply> {
    const id = f.id ?? "";
    const stop = new AbortController();
    posts.add(stop);
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      const res = await (o.fetch ?? globalThis.fetch)(url, { method: "POST", body: JSON.stringify({ ...f, key }), signal: stop.signal });
      if (res.status === 204) return ok(id);
      const text = await res.text();
      const reply = parseFrame(text);
      return reply && isReply(reply) ? reply : refusal(id, "offline", `${res.status}: ${text.slice(0, 160)}`);
    } catch (e) {
      if (closed) return fail(id, "disconnected");
      return stop.signal.aborted ? refusal(id, "timeout", `${f.type}: нет ответа за ${ms / 1000} с`) : refusal(id, "offline", String(e));
    } finally {
      clearTimeout(timer);
      posts.delete(stop);
    }
  }

  async function listMachines() {
    // суффикс id — знак для стенда Host: так он отличает этот список от keys.list модулей
    const r = await post(workers.gate, { type: "keys.list", id: `${newId()}-list`, v: 1, role: "host" }, readMs);
    if (closed) return;
    if (!r.ok) {
      if (r.error === "bad_key") return o.onState?.("", "stopped", r.error);
      const p = pause.take();
      retry = setTimeout(listMachines, p);
      return o.onState?.("", "closed", r.error, Date.now() + p);
    }
    const { passes, you } = r.result as { passes: Array<{ name: string }>; you?: string };
    addr = you ?? null;
    for (const p of passes) join(p.name);
    if (!links.size) o.onState?.("", "open");
  }

  /** Своё соединение; у страницы — любое открытое, иначе любое: оно и скажет disconnected. */
  const home = (): Link | undefined => {
    if (machine) return links.get(machine);
    const all = [...links.values()];
    return all.find((l) => l.state === "open") ?? all[0];
  };

  function routeOf(f: Pick<Frame, "to" | "callsign" | "machine">): Route {
    const { to } = f;
    const kind = kindOf(to);
    if (kind === "service") return workers[(to as string).slice(1)] ?? { error: "offline" };
    const m = kind === "part" ? machineOf(to as string) : hostOf(f);
    if (m) return links.get(m) ?? home() ?? { error: "offline" };
    return home() ?? { error: kind ? "disconnected" : "bad_frame" };
  }

  function sendBy(route: Route, f: Frame): Sent {
    if (typeof route === "string") {
      void post(route, f, requestMs).then((r) => {
        if (!r.ok && !closed) o.onLost?.(f, r.error);
      });
      return { ok: true };
    }
    return "error" in route ? { ok: false, error: route.error } : route.send(f);
  }

  /** Список адресатов: каждому соединению и Worker'у один кадр со своей частью списка. */
  function sendList(f: Frame, list: string[]): Sent {
    const parts = new Map<Link | string, string[]>();
    let refused = "offline";
    for (const to of list) {
      const route = routeOf({ to });
      if (typeof route === "object" && "error" in route) refused = route.error;
      else parts.set(route, [...(parts.get(route) ?? []), to]);
    }
    const sent = [...parts].map(([route, to]) => sendBy(route, { ...f, to }));
    return sent.find((s) => s.ok) ?? sent.at(-1) ?? { ok: false, error: refused };
  }

  if (machine) join(machine);
  if (workers.gate) void listMachines();

  return {
    get addr() {
      return addr;
    },
    get state() {
      if (closed) return "stopped";
      if (machine) return links.get(machine)?.state ?? "connecting";
      const all = [...links.values()];
      return (all.find((l) => l.state === "open") ?? all[0])?.state ?? "connecting";
    },
    get roster() {
      const open = [...links.values()].filter((l) => l.state === "open").flatMap((l) => l.roster ?? []);
      return {
        type: "roster" as const,
        machines: open.flatMap((r) => r.machines),
        sessions: open.flatMap((r) => r.sessions),
        clients: [...new Set(open.flatMap((r) => r.clients))].filter((c) => kindOf(c) !== "machine"),
      };
    },
    links: () => links,
    async request(f, read = false) {
      const id = f.id ?? newId();
      if (closed) return fail(id, "disconnected");
      const route = routeOf(f);
      if (typeof route === "string") return post(route, { ...f, id }, read ? readMs : requestMs);
      return "error" in route ? fail(id, route.error) : route.request(f, read);
    },
    send(f) {
      if (closed) return { ok: false, error: "disconnected" };
      if (f.type === "reply" && f.id) {
        const asked = `${f.id}|${f.to}`;
        const via = askedVia.get(asked);
        askedVia.delete(asked);
        if (via?.state === "open") return via.send(f);
      }
      return Array.isArray(f.to) ? sendList(f, f.to) : sendBy(routeOf(f), f);
    },
    close(code, reason) {
      closed = true;
      if (retry) clearTimeout(retry);
      for (const stop of posts) stop.abort();
      for (const l of links.values()) l.close(code, reason);
    },
  };
}
