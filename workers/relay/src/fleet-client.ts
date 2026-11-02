// Клиент флота: соединение с relay каждой машины, кадр — по адресу, к Worker'у — POST напрямую.
// Машины — из keys.list у gate; машина, которую клиент ещё не знает, видна гостем @машина в roster любого объекта.
// Им пользуются Host, keeper, страницы и программы; Node 24 и браузер.
import { fail, kindOf, machineOf, hostOf, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { link, type Link, type LinkState, type WsCtor } from "./link.ts";

export type FleetOptions = {
  /** адрес relay: wss://switchboard.<subdomain>.workers.dev — объект машины на /m/<машина> */
  relay: string;
  /** адрес gate: https://… — keys.list */
  gate: string;
  /** Worker'ы флота: имя → адрес https; кадр с to: ".имя" — POST по нему */
  workers: Record<string, string>;
  /** пропуск держателя role.name.kid.secret — из файла, переменной окружения или хранилища; не из argv */
  key: string;
  /** своя машина (Host, keeper): соединение с её relay — своё, с hello(); кадры устройствам — через него */
  machine?: string;
  /** поля hello своего соединения: Host — { sdk, contract, sessions }, keeper — { part: "keeper" } */
  hello?: () => Record<string, unknown>;
  /** только своя машина: гостем к другим не входить (keeper) */
  only?: boolean;
  /** входящий кадр с машины, кроме ответов на свои запросы */
  onFrame?: (f: Frame, machine: string) => void;
  /** смена состояния соединения с машиной; машина "" — список машин у gate: stopped со словом — пропуск не принят */
  onState?: (machine: string, state: LinkState, why?: string) => void;
  /** предел запроса, мс — и к relay, и к Worker'у. По умолчанию 120 000 */
  requestMs?: number;
  pingMs?: number;
  pauseMs?: number;
  maxPauseMs?: number;
  WebSocket?: WsCtor;
  fetch?: typeof fetch;
};

export interface FleetClient {
  /** roster флота — объединение roster объектов машин */
  readonly roster: Roster;
  /** соединения по машинам */
  links(): ReadonlyMap<string, Link>;
  /** Запрос по адресу: машина — в её соединение, Worker — POST. Не бросает: отказ — reply { ok: false, error }. */
  request(f: Frame): Promise<Reply>;
  /** Кадр без ожидания ответа по тем же правилам. */
  send(f: Frame): { ok: true } | { ok: false; error: string };
  /** Штатная остановка: ждущие — disconnected на всех соединениях и запросах к Worker'ам, переподключений нет. */
  close(code?: number, reason?: string): void;
}

/** Слова gate, после которых список машин не спрашивают заново: пропуск не принят. */
const FATAL = new Set(["bad_key", "revoked"]);

export function fleet(o: FleetOptions): FleetClient {
  const doFetch = o.fetch ?? fetch;
  const requestMs = o.requestMs ?? 120_000;
  const firstPause = o.pauseMs ?? 1_000;
  const maxPause = o.maxPauseMs ?? 60_000;
  const links = new Map<string, Link>();
  const posts = new Set<AbortController>();
  let stopped = false;
  let pause = firstPause;
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const prefix = Math.random().toString(36).slice(2, 8);

  function open(machine: string) {
    if (stopped || links.has(machine)) return;
    const own = machine === o.machine;
    const l = link({
      url: `${o.relay.replace(/\/$/, "")}/m/${machine}`,
      key: o.key,
      hello: own ? o.hello : undefined,
      requestMs,
      pingMs: o.pingMs,
      pauseMs: o.pauseMs,
      maxPauseMs: o.maxPauseMs,
      WebSocket: o.WebSocket,
      onState: (s, why) => o.onState?.(machine, s, why),
      onFrame: (f) => {
        if (f.type === "roster" && !o.only) {
          // Host другой машины в гостях — машина, которую клиент мог ещё не знать
          for (const c of (f as unknown as Roster).clients) if (c.startsWith("@")) open(c.slice(1));
        }
        o.onFrame?.(f, machine);
      },
    });
    links.set(machine, l);
  }

  /** keys.list роли host у gate → соединение с каждой машиной; сбой — повтор с растущей паузой, отказ пропуску — стоп. */
  async function list() {
    const r = await post(o.gate, { type: "keys.list", id: `${prefix}-list`, v: 1, role: "host" });
    if (stopped) return;
    if (r.ok) {
      pause = firstPause;
      for (const p of (r.result as { passes: Array<{ name: string }> }).passes) open(p.name);
      return;
    }
    if (FATAL.has(r.error)) return o.onState?.("", "stopped", r.error);
    o.onState?.("", "closed", r.error);
    listTimer = setTimeout(list, pause);
    pause = Math.min(pause * 2, maxPause);
  }

  /** POST кадра с пропуском; ответ — reply. Нет ответа за предел — timeout, close() — disconnected, сеть — offline. */
  async function post(url: string, f: Frame): Promise<Reply> {
    const id = f.id ?? "";
    if (stopped) return fail(id, "disconnected");
    const ac = new AbortController();
    posts.add(ac);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      ac.abort();
    }, requestMs);
    try {
      const res = await doFetch(url, { method: "POST", body: JSON.stringify({ ...f, key: o.key }), signal: ac.signal });
      if (res.status === 204) return { type: "reply", id, ok: true };
      return (await res.json()) as Reply;
    } catch (e) {
      return fail(id, late ? "timeout" : ac.signal.aborted ? "disconnected" : "offline");
    } finally {
      clearTimeout(timer);
      posts.delete(ac);
    }
  }

  /** Соединение, которому по адресу кадр; к Worker'у — его адрес. */
  function target(f: Frame): { link: Link } | { url: string } | { error: string } {
    const to = typeof f.to === "string" ? f.to : undefined;
    if (to !== undefined) {
      switch (kindOf(to)) {
        case "service": {
          const url = o.workers[to.slice(1)];
          return url ? { url } : { error: "offline" };
        }
        case "machine":
        case "session":
        case "part": {
          const l = links.get(machineOf(to)!);
          return l ? { link: l } : { error: "offline" };
        }
        case "device":
        case "user": {
          // устройства — гости каждой машины: Host шлёт через свою, страница — через любую открытую
          const l = (o.machine ? links.get(o.machine) : undefined) ?? [...links.values()].find((x) => x.state === "open");
          return l ? { link: l } : { error: "disconnected" };
        }
        default:
          return { error: "bad_frame" };
      }
    }
    if (f.to !== undefined) return { error: "bad_frame" };
    const m = hostOf(f);
    if (!m) return { error: "bad_frame" };
    const l = links.get(m);
    return l ? { link: l } : { error: "offline" };
  }

  if (o.machine) open(o.machine);
  if (!o.only) void list();

  return {
    get roster(): Roster {
      const r: Roster = { type: "roster", machines: [], sessions: [], clients: [], workers: [] };
      for (const l of links.values()) {
        const x = l.roster;
        if (!x || l.state !== "open") continue;
        r.machines.push(...x.machines);
        r.sessions.push(...x.sessions);
        for (const c of x.clients) if (!c.startsWith("@") && !r.clients.includes(c)) r.clients.push(c);
        for (const w of x.workers) if (!r.workers.some((y) => y.name === w.name)) r.workers.push(w);
      }
      return r;
    },
    links: () => links,
    request(f: Frame): Promise<Reply> {
      const g = { ...f, id: f.id ?? `${prefix}-${++seq}` };
      const t = target(g);
      if ("error" in t) return Promise.resolve(fail(g.id, t.error));
      return "url" in t ? post(t.url, g) : t.link.request(g);
    },
    send(f: Frame) {
      const list = Array.isArray(f.to) ? (f.to as string[]) : [undefined];
      let sent = false;
      let last = "offline";
      for (const a of list) {
        const one = a === undefined ? f : { ...f, to: a };
        const t = target(one);
        if ("error" in t) {
          last = t.error;
          continue;
        }
        if ("url" in t) {
          void post(t.url, one);
          sent = true;
          continue;
        }
        const r = t.link.send(one);
        if (r.ok) sent = true;
        else last = r.error;
      }
      return sent ? { ok: true as const } : { ok: false as const, error: last };
    },
    close(code = 1000, reason = "closing") {
      stopped = true;
      if (listTimer !== undefined) clearTimeout(listTimer);
      for (const ac of [...posts]) ac.abort();
      for (const l of links.values()) l.close(code, reason);
    },
  };
}
