// Клиент флота: соединение с relay каждой машины; кадр к машине — в её соединение, к Worker'у — POST с пропуском.
import { CALL_MS, READ_MS, fail, hostOf, isReply, kindOf, machineOf, ok, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { link, newId, nextPause, type Link, type LinkState, type Sent, type WsCtor } from "./link.ts";

export type FleetClient = {
  /** адрес пропуска, как его назвал gate */
  readonly addr: string | null;
  /** объединение открытых объектов */
  readonly roster: Roster;
  readonly state: LinkState;
  links(): Map<string, Link>;
  request(f: Omit<Frame, "id"> & { id?: string }, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  close(code?: number, reason?: string): void;
};

export type FleetOptions = {
  workers: Record<string, string>;
  key: string;
  /** своя машина: с ней соединение сразу и как Host */
  machine?: string;
  hello?: () => Record<string, unknown>;
  onFrame?: (f: Frame) => void;
  /** machine "" — список машин у gate */
  onState?: (machine: string, state: LinkState, why?: string, retryAt?: number) => void;
  /** кадр без ожидания к Worker'у не дошёл */
  onLost?: (f: Frame, word: string) => void;
  fetch?: typeof fetch;
  WebSocket?: WsCtor;
  pauseMs?: number;
};

export const relayWs = (workers: Record<string, string>): string => (workers.relay ?? "").replace(/^http/, "ws").replace(/\/$/, "");

const refused = (error: string) => ({ ok: false as const, error });

export function fleet(o: FleetOptions): FleetClient {
  const { workers } = o;
  const relay = relayWs(workers);
  const links = new Map<string, Link>();
  const posts = new Set<AbortController>();
  /** соединение, которым пришёл запрос «id|from»: ответ ждут там */
  const asked = new Map<string, Link>();
  let pause = o.pauseMs ?? 1000;
  let addr: string | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;

  function open(machine: string) {
    if (links.has(machine) || !relay) return;
    const l: Link = link({
      url: `${relay}/m/${machine}`,
      key: o.key,
      WebSocket: o.WebSocket,
      pauseMs: o.pauseMs,
      hello: machine === o.machine ? o.hello : undefined,
      onState: (state, why, retryAt) => o.onState?.(machine, state, why, retryAt),
      onFrame(f) {
        if (f.type === "roster") for (const c of (f as unknown as Roster).clients) if (kindOf(c) === "machine") open(machineOf(c)!);
        if (f.id && f.type !== "reply") asked.set(`${f.id}|${f.from}`, l);
        o.onFrame?.(f);
      },
    });
    links.set(machine, l);
  }

  /** Соединение для адресов без своего объекта: своя машина, у страницы — открытое или первое. */
  const main = (): Link | undefined => {
    const all = [...links.values()];
    return o.machine ? links.get(o.machine) : (all.find((l) => l.state === "open") ?? all[0]);
  };

  async function post(url: string, f: Frame, ms: number): Promise<Reply & { why?: string }> {
    const id = f.id ?? "";
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    posts.add(stop);
    try {
      const res = await (o.fetch ?? fetch)(url, { method: "POST", body: JSON.stringify({ ...f, key: o.key }), signal: stop.signal });
      if (res.status === 204) return ok(id);
      const text = await res.text();
      const reply = parseFrame(text);
      return reply && isReply(reply) ? reply : { ...fail(id, "offline"), why: `${res.status}: ${text.slice(0, 160)}` };
    } catch (e) {
      if (closed) return fail(id, "disconnected");
      return stop.signal.aborted ? { ...fail(id, "timeout"), why: `${url} молчит ${ms / 1000} с` } : { ...fail(id, "offline"), why: String(e) };
    } finally {
      clearTimeout(timer);
      posts.delete(stop);
    }
  }

  async function listMachines() {
    const r = await post(workers.gate, { type: "keys.list", id: `${newId()}-list`, v: 2, kind: "machine" }, READ_MS);
    if (closed) return;
    if (r.ok) {
      const { passes, you } = r.result as { passes: Array<{ addr: string; wait: boolean }>; you?: string };
      addr = you ?? null;
      for (const p of passes) if (!p.wait) open(p.addr.slice(1));
      if (!links.size) o.onState?.("", "open");
    } else if (r.error === "bad_key") o.onState?.("", "stopped", r.error);
    else {
      retry = setTimeout(listMachines, pause);
      o.onState?.("", "closed", r.error, Date.now() + pause);
      pause = nextPause(pause);
    }
  }

  /** Куда кадр: соединение, адрес Worker'а или отказ. */
  function route(f: Pick<Frame, "to" | "callsign" | "machine">): Link | string | { ok: false; error: string } {
    if (kindOf(f.to) === "service") return workers[(f.to as string).slice(1)] ?? refused("offline");
    const machine = typeof f.to === "string" ? machineOf(f.to) : hostOf(f);
    const via = machine ? (links.get(machine) ?? main()) : main();
    if (via) return via;
    if (machine) return refused("offline");
    return refused(kindOf(f.to) ? "disconnected" : "bad_frame");
  }

  /** Кадр без ожидания: у Worker'а отказ приходит позже — в onLost. */
  function through(via: Link | string, f: Frame): Sent {
    if (typeof via !== "string") return via.send(f);
    void post(via, f, CALL_MS).then((r) => {
      if (!r.ok && !closed) o.onLost?.(f, r.error);
    });
    return { ok: true };
  }

  function send(f: Frame): Sent {
    if (closed) return refused("disconnected");
    if (f.type === "reply" && f.id) {
      const key = `${f.id}|${f.to}`;
      const via = asked.get(key);
      asked.delete(key);
      if (via?.state === "open") return via.send(f);
    }
    if (!Array.isArray(f.to)) {
      const r = route(f);
      return typeof r === "object" && "error" in r ? r : through(r, f);
    }
    // список: каждому соединению и Worker'у один кадр со своей частью
    const parts = new Map<Link | string, string[]>();
    const results: Sent[] = [];
    for (const to of f.to) {
      const r = route({ to });
      if (typeof r === "object" && "error" in r) results.push(r);
      else parts.set(r, [...(parts.get(r) ?? []), to]);
    }
    for (const [via, to] of parts) results.unshift(through(via, { ...f, to }));
    return results.find((r) => r.ok) ?? results[0];
  }

  function request(f: Omit<Frame, "id"> & { id?: string }, read = false): Promise<Reply> {
    const id = f.id ?? newId();
    const frame = { ...f, id } as Frame;
    if (closed) return Promise.resolve(fail(id, "disconnected"));
    const r = route(frame);
    if (typeof r === "string") return post(r, frame, read ? READ_MS : CALL_MS);
    return "error" in r ? Promise.resolve(fail(id, r.error)) : r.request(frame, read);
  }

  if (o.machine) open(o.machine);
  if (workers.gate) void listMachines();

  return {
    get addr() {
      return addr;
    },
    get roster() {
      const opened = [...links.values()].flatMap((l) => (l.state === "open" && l.roster ? [l.roster] : []));
      return {
        type: "roster" as const,
        machines: opened.flatMap((r) => r.machines),
        sessions: opened.flatMap((r) => r.sessions),
        clients: [...new Set(opened.flatMap((r) => r.clients))].filter((c) => kindOf(c) !== "machine"),
      };
    },
    get state() {
      return closed ? "stopped" : (main()?.state ?? "connecting");
    },
    links: () => links,
    request,
    send,
    close(code, reason) {
      closed = true;
      clearTimeout(retry);
      for (const stop of posts) stop.abort();
      for (const l of links.values()) l.close(code, reason);
    },
  };
}
