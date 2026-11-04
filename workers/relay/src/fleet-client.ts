// Клиент флота: соединение с relay каждой машины, кадр — по адресу, к Worker'у — POST напрямую.
// Машины — из keys.list у gate; машина, которую клиент ещё не знает, видна гостем @машина в roster любого объекта.
// Им пользуются Host, keeper, страницы и программы; Node 24 и браузер.
import { CALL_MS, READ_MS, fail, kindOf, machineOf, hostOf, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { link, type Link, type LinkState, type WsCtor } from "./link.ts";

export type FleetOptions = {
  /**
   * Worker'ы флота: имя → адрес https — одна карта адресов. Кадр с to: ".имя" — POST по нему; relay — объекты машин
   * (wss того же адреса, /m/<машина>); gate — keys.list, без него машины только по roster.
   */
  workers: Record<string, string>;
  /** пропуск держателя role.name.kid.secret — из файла, переменной окружения или хранилища; не из argv */
  key: string;
  /** своя машина (Host, keeper): соединение с её relay — своё, с hello(); кадры устройствам — через него */
  machine?: string;
  /** поля hello своего соединения: Host — { sdk, contract, sessions } */
  hello?: () => Record<string, unknown>;
  /** входящий кадр с машины, кроме ответов на свои запросы */
  onFrame?: (f: Frame, machine: string) => void;
  /** смена состояния соединения с машиной; машина "" — список машин у gate: stopped со словом — пропуск не принят; open — машин нет */
  onState?: (machine: string, state: LinkState, why?: string, retryAt?: number) => void;
  /** кадр без ожидания к Worker'у не дошёл: слово отказа — держатель пишет его в свой журнал */
  onLost?: (f: Frame, word: string) => void;
  /** предел запроса, мс — и к relay, и к Worker'у. По умолчанию CALL_MS */
  requestMs?: number;
  pingMs?: number;
  pauseMs?: number;
  maxPauseMs?: number;
  WebSocket?: WsCtor;
  fetch?: typeof fetch;
};

export interface FleetClient {
  /** состояние своего соединения (у Host и keeper), у страницы — open, если открыто хоть одно */
  readonly state: LinkState;
  /** roster флота — объединение roster объектов машин */
  readonly roster: Roster;
  /** адрес своего пропуска от gate при входе; до ответа gate — null */
  readonly addr: string | null;
  /** соединения по машинам */
  links(): ReadonlyMap<string, Link>;
  /** Запрос по адресу: машина — в её соединение, Worker — POST. Не бросает: отказ — reply { ok: false, error }. read — только читает: предел READ_MS. */
  request(f: Frame, read?: boolean): Promise<Reply>;
  /** Кадр без ожидания ответа по тем же правилам. */
  send(f: Frame): { ok: true } | { ok: false; error: string };
  /** Штатная остановка: ждущие — disconnected на всех соединениях и запросах к Worker'ам, переподключений нет. */
  close(code?: number, reason?: string): void;
}

/** Адрес объектов relay из адреса Worker'а relay: https://… → wss://…, без «/» в конце. */
export const relayWs = (workers: Record<string, string>): string => (workers.relay ?? "").replace(/^http/, "ws").replace(/\/$/, "");

export function fleet(o: FleetOptions): FleetClient {
  const relay = relayWs(o.workers);
  const doFetch = o.fetch ?? fetch;
  const requestMs = o.requestMs ?? CALL_MS;
  const firstPause = o.pauseMs ?? 1_000;
  const maxPause = o.maxPauseMs ?? 60_000;
  const links = new Map<string, Link>();
  /** откуда пришёл запрос «id|from»: ответ — тем же соединением, там его ждут */
  const origin = new Map<string, Link>();
  const posts = new Set<AbortController>();
  let stopped = false;
  let addr: string | null = null;
  let pause = firstPause;
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const prefix = Math.random().toString(36).slice(2, 8);

  function open(machine: string) {
    if (stopped || links.has(machine)) return;
    const own = machine === o.machine;
    const l = link({
      url: `${relay}/m/${machine}`,
      key: o.key,
      hello: own ? o.hello : undefined,
      requestMs,
      pingMs: o.pingMs,
      pauseMs: o.pauseMs,
      maxPauseMs: o.maxPauseMs,
      WebSocket: o.WebSocket,
      onState: (s, why, retryAt) => o.onState?.(machine, s, why, retryAt),
      onFrame: (f) => {
        if (typeof f.id === "string" && f.type !== "reply" && typeof f.from === "string") origin.set(`${f.id}|${f.from}`, l);
        if (f.type === "roster") {
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
    const r = await post(o.workers.gate, { type: "keys.list", id: `${prefix}-list`, v: 1, role: "host" }, true);
    if (stopped) return;
    if (r.ok) {
      pause = firstPause;
      const got = r.result as { passes: Array<{ name: string }>; you?: string };
      addr = got.you ?? null;
      for (const p of got.passes) open(p.name);
      // машин нет и не будет: держателю без своей машины больше нечего ждать
      if (!links.size) o.onState?.("", "open");
      return;
    }
    // пропуск не принят: список машин не спрашивают заново
    if (r.error === "bad_key") return o.onState?.("", "stopped", r.error);
    o.onState?.("", "closed", r.error, Date.now() + pause);
    listTimer = setTimeout(list, pause);
    pause = Math.min(pause * 2, maxPause);
  }

  /**
   * POST кадра с пропуском; ответ — reply. Нет ответа за предел — timeout, close() — disconnected, сеть или ответ не JSON
   * (страница ошибки Cloudflare) — offline; причина — в why отказа: исключение сети или статус и начало тела.
   */
  async function post(url: string, f: Frame, read = false): Promise<Reply> {
    const id = f.id ?? "";
    if (stopped) return fail(id, "disconnected");
    const ac = new AbortController();
    posts.add(ac);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      ac.abort();
    }, read ? Math.min(READ_MS, requestMs) : requestMs);
    try {
      const res = await doFetch(url, { method: "POST", body: JSON.stringify({ ...f, key: o.key }), signal: ac.signal });
      if (res.status === 204) return { type: "reply", id, ok: true };
      const text = await res.text();
      try {
        return JSON.parse(text) as Reply;
      } catch {
        return { ...fail(id, "offline"), why: `${res.status}: ${text.slice(0, 160)}` } as unknown as Reply;
      }
    } catch (e) {
      return { ...fail(id, late ? "timeout" : ac.signal.aborted ? "disconnected" : "offline"), why: String(e) } as unknown as Reply;
    } finally {
      clearTimeout(timer);
      posts.delete(ac);
    }
  }

  /** POST без ожидания: отказ — onLost. */
  async function lost(url: string, f: Frame): Promise<void> {
    const r = await post(url, f);
    if (!r.ok && !stopped) o.onLost?.(f, r.error);
  }

  /** Соединение, которому по адресу кадр; к Worker'у — его адрес. */
  function target(f: Frame): { link: Link } | { url: string } | { error: string } {
    const to = typeof f.to === "string" ? f.to : undefined;
    if (to !== undefined) {
      switch (kindOf(to)) {
        case "service": {
          // кадр к Worker'у через relay не ходит: адреса нет — отказ здесь же
          const url = o.workers[to.slice(1)];
          return url ? { url } : { error: "offline" };
        }
        case "machine":
        case "session":
        case "part":
          return machineLink(machineOf(to)!);
        case "device":
        case "user": {
          // устройства — гости каждой машины: Host шлёт через свою, страница — через любую открытую
          const l = home();
          return l ? { link: l } : { error: "disconnected" };
        }
        default:
          return judged();
      }
    }
    if (f.to !== undefined) return judged();
    const m = hostOf(f);
    if (!m) return judged();
    return machineLink(m);
  }

  /** Адрес не разобран: кадр — в своё соединение, решает relay. */
  function judged(): { link: Link } | { error: string } {
    const l = home();
    return l ? { link: l } : { error: "bad_frame" };
  }

  /** Кадр одному адресату или по callsign: машина — её соединение, Worker — POST без ожидания. */
  function one(f: Frame): { ok: true } | { ok: false; error: string } {
    const t = target(f);
    if ("error" in t) return { ok: false, error: t.error };
    if ("url" in t) {
      void lost(t.url, f);
      return { ok: true };
    }
    return t.link.send(f);
  }

  /** Своё соединение, у страницы — любое открытое. */
  function home(): Link | undefined {
    return (o.machine ? links.get(o.machine) : undefined) ?? [...links.values()].find((x) => x.state === "open");
  }

  /** Соединение машины; его ещё нет — своё: relay доставит, если машина у него в гостях, иначе offline. */
  function machineLink(m: string): { link: Link } | { error: string } {
    const l = links.get(m) ?? home();
    return l ? { link: l } : { error: "offline" };
  }

  if (o.machine) open(o.machine);
  if (o.workers.gate) void list();

  return {
    get addr() {
      return addr;
    },
    get state(): LinkState {
      if (o.machine) return links.get(o.machine)?.state ?? "connecting";
      const all = [...links.values()];
      return all.some((l) => l.state === "open") ? "open" : stopped ? "stopped" : (all[0]?.state ?? "connecting");
    },
    get roster(): Roster {
      const r: Roster = { type: "roster", machines: [], sessions: [], clients: [] };
      for (const l of links.values()) {
        const x = l.roster;
        if (!x || l.state !== "open") continue;
        r.machines.push(...x.machines);
        r.sessions.push(...x.sessions);
        for (const c of x.clients) if (!c.startsWith("@") && !r.clients.includes(c)) r.clients.push(c);
      }
      return r;
    },
    links: () => links,
    request(f: Frame, read = false): Promise<Reply> {
      const g = { ...f, id: f.id ?? `${prefix}-${++seq}` };
      const t = target(g);
      if ("error" in t) return Promise.resolve(fail(g.id, t.error));
      return "url" in t ? post(t.url, g, read) : t.link.request(g, read);
    },
    send(f: Frame) {
      // ответ на запрос — тем же соединением, по которому пришёл запрос: там его ждёт спросивший
      const back = f.type === "reply" && typeof f.id === "string" && typeof f.to === "string" ? `${f.id}|${f.to}` : "";
      const via = back ? origin.get(back) : undefined;
      if (via) {
        origin.delete(back);
        if (via.state === "open") return via.send(f);
      }
      // список адресатов — по соединениям: каждому соединению и Worker'у один кадр со своей частью списка
      if (!Array.isArray(f.to)) return one(f);
      const groups = new Map<Link | string, string[]>();
      let last = "offline";
      for (const a of f.to as string[]) {
        const t = target({ ...f, to: a });
        if ("error" in t) {
          last = t.error;
          continue;
        }
        const k = "url" in t ? t.url : t.link;
        groups.set(k, [...(groups.get(k) ?? []), a]);
      }
      let sent = false;
      let refused: { ok: false; error: string } | undefined;
      for (const [k, to] of groups) {
        const r = typeof k === "string" ? (void lost(k, { ...f, to }), { ok: true as const }) : k.send({ ...f, to });
        if (r.ok) sent = true;
        else refused = r;
      }
      return sent ? { ok: true as const } : (refused ?? { ok: false as const, error: last });
    },
    close(code = 1000, reason = "closing") {
      stopped = true;
      origin.clear();
      if (listTimer !== undefined) clearTimeout(listTimer);
      for (const ac of [...posts]) ac.abort();
      for (const l of links.values()) l.close(code, reason);
    },
  };
}
