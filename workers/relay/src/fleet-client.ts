// Клиент флота: соединение с relay каждой машины, кадр — по адресу, к Worker'у — POST напрямую.
// Машины — из keys.list у gate; машина, которую клиент ещё не знает, видна гостем @машина в roster любого объекта.
// Им пользуются Host, keeper, страницы и программы; Node 24 и браузер.
import { CALL_MS, fail, hostOf, kindOf, machineOf, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { backoff } from "./backoff.ts";
import { link, type Link, type LinkState, type WsCtor } from "./link.ts";
import { poster } from "./post.ts";

type FleetOptions = {
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

type Sent = { ok: true } | { ok: false; error: string };
/** Куда идёт кадр: соединение с машиной, адрес Worker'а или слово отказа. */
type Way = { link: Link } | { url: string } | { error: string };

/** Адрес объектов relay из адреса Worker'а relay: https://… → wss://…, без «/» в конце. */
export const relayWs = (workers: Record<string, string>): string => (workers.relay ?? "").replace(/^http/, "ws").replace(/\/$/, "");

export function fleet(o: FleetOptions): FleetClient {
  const relay = relayWs(o.workers);
  const requestMs = o.requestMs ?? CALL_MS;
  const http = poster(o.key, o.fetch ?? fetch, requestMs);
  const links = new Map<string, Link>();
  /** откуда пришёл запрос «id|from»: ответ — тем же соединением, там его ждут */
  const askedVia = new Map<string, Link>();
  const listPause = backoff(o.pauseMs, o.maxPauseMs);
  const prefix = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let stopped = false;
  let addr: string | null = null;
  let listRetry: ReturnType<typeof setTimeout> | undefined;

  function open(machine: string): void {
    if (stopped || links.has(machine)) return;
    const l = link({
      url: `${relay}/m/${machine}`,
      key: o.key,
      hello: machine === o.machine ? o.hello : undefined,
      requestMs,
      pingMs: o.pingMs,
      pauseMs: o.pauseMs,
      maxPauseMs: o.maxPauseMs,
      WebSocket: o.WebSocket,
      onState: (s, why, retryAt) => o.onState?.(machine, s, why, retryAt),
      onFrame: (f) => {
        if (typeof f.id === "string" && f.type !== "reply" && typeof f.from === "string") askedVia.set(`${f.id}|${f.from}`, l);
        // Host другой машины в гостях — машина, которую клиент мог ещё не знать
        if (f.type === "roster") for (const c of (f as unknown as Roster).clients) if (c.startsWith("@")) open(c.slice(1));
        o.onFrame?.(f, machine);
      },
    });
    links.set(machine, l);
  }

  /** keys.list роли host у gate → соединение с каждой машиной; сбой — повтор с растущей паузой, отказ пропуску — стоп. */
  async function listMachines(): Promise<void> {
    const r = await http.post(o.workers.gate, { type: "keys.list", id: `${prefix}-list`, v: 1, role: "host" }, true);
    if (stopped) return;
    if (r.ok) {
      listPause.reset();
      const { passes, you } = r.result as { passes: Array<{ name: string }>; you?: string };
      addr = you ?? null;
      for (const p of passes) open(p.name);
      // машин нет и не будет: держателю без своей машины больше нечего ждать
      if (!links.size) o.onState?.("", "open");
      return;
    }
    // пропуск не принят: список машин не спрашивают заново
    if (r.error === "bad_key") return o.onState?.("", "stopped", r.error);
    const wait = listPause.next();
    o.onState?.("", "closed", r.error, Date.now() + wait);
    listRetry = setTimeout(listMachines, wait);
  }

  /** Своё соединение, у страницы — любое открытое. */
  const home = (): Link | undefined => (o.machine ? links.get(o.machine) : undefined) ?? [...links.values()].find((l) => l.state === "open");

  /** Адрес не разобран: кадр — в своё соединение, решает relay. */
  function judgedByRelay(): Way {
    const l = home();
    return l ? { link: l } : { error: "bad_frame" };
  }

  /** Соединение машины; его ещё нет — своё: relay доставит, если машина у него в гостях, иначе offline. */
  function toMachine(machine: string): Way {
    const l = links.get(machine) ?? home();
    return l ? { link: l } : { error: "offline" };
  }

  function wayOf(f: Frame): Way {
    if (typeof f.to !== "string") {
      const machine = f.to === undefined ? hostOf(f) : null;
      return machine ? toMachine(machine) : judgedByRelay();
    }
    switch (kindOf(f.to)) {
      case "service": {
        // кадр к Worker'у через relay не ходит: адреса нет — отказ здесь же
        const url = o.workers[f.to.slice(1)];
        return url ? { url } : { error: "offline" };
      }
      case "machine":
      case "session":
      case "part":
        return toMachine(machineOf(f.to)!);
      case "device":
      case "user": {
        // устройства — гости каждой машины: Host шлёт через свою, страница — через любую открытую
        const l = home();
        return l ? { link: l } : { error: "disconnected" };
      }
      default:
        return judgedByRelay();
    }
  }

  /** POST без ожидания: отказ — onLost. */
  function postAndForget(url: string, f: Frame): Sent {
    void http.post(url, f).then((r) => {
      if (!r.ok && !stopped) o.onLost?.(f, r.error);
    });
    return { ok: true };
  }

  function sendOne(f: Frame): Sent {
    const way = wayOf(f);
    if ("error" in way) return { ok: false, error: way.error };
    return "url" in way ? postAndForget(way.url, f) : way.link.send(f);
  }

  /** Список адресатов — по соединениям: каждому соединению и Worker'у один кадр со своей частью списка. */
  function sendToList(f: Frame, addresses: string[]): Sent {
    const groups = new Map<Link | string, string[]>();
    let lastError = "offline";
    for (const a of addresses) {
      const way = wayOf({ ...f, to: a });
      if ("error" in way) lastError = way.error;
      else {
        const k = "url" in way ? way.url : way.link;
        groups.set(k, [...(groups.get(k) ?? []), a]);
      }
    }
    const results = [...groups].map(([k, to]) => (typeof k === "string" ? postAndForget(k, { ...f, to }) : k.send({ ...f, to })));
    return results.find((r) => r.ok) ?? results.at(-1) ?? { ok: false, error: lastError };
  }

  if (o.machine) open(o.machine);
  if (o.workers.gate) void listMachines();

  return {
    get addr() {
      return addr;
    },
    get state(): LinkState {
      if (o.machine) return links.get(o.machine)?.state ?? "connecting";
      const all = [...links.values()];
      if (all.some((l) => l.state === "open")) return "open";
      return stopped ? "stopped" : (all[0]?.state ?? "connecting");
    },
    get roster(): Roster {
      const r: Roster = { type: "roster", machines: [], sessions: [], clients: [] };
      for (const l of links.values()) {
        if (!l.roster || l.state !== "open") continue;
        r.machines.push(...l.roster.machines);
        r.sessions.push(...l.roster.sessions);
        for (const c of l.roster.clients) if (!c.startsWith("@") && !r.clients.includes(c)) r.clients.push(c);
      }
      return r;
    },
    links: () => links,
    request(f, read = false) {
      const framed = { ...f, id: f.id ?? `${prefix}-${++seq}` };
      const way = wayOf(framed);
      if ("error" in way) return Promise.resolve(fail(framed.id, way.error));
      return "url" in way ? http.post(way.url, framed, read) : way.link.request(framed, read);
    },
    send(f) {
      // ответ на запрос — тем же соединением, по которому пришёл запрос: там его ждёт спросивший
      if (f.type === "reply" && typeof f.id === "string" && typeof f.to === "string") {
        const back = `${f.id}|${f.to}`;
        const via = askedVia.get(back);
        askedVia.delete(back);
        if (via?.state === "open") return via.send(f);
      }
      return Array.isArray(f.to) ? sendToList(f, f.to) : sendOne(f);
    },
    close(code = 1000, reason = "closing") {
      stopped = true;
      askedVia.clear();
      if (listRetry !== undefined) clearTimeout(listRetry);
      http.stop();
      for (const l of links.values()) l.close(code, reason);
    },
  };
}
