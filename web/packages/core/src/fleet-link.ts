// Связь страницы с флотом: клиент fleet, состояние флота для модулей, roster, маршрут кадров и начатые запросы.
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import { plural } from "@switchboard/web-ui";
import type { Modules } from "./modules.ts";
import type { Snapshot } from "./snapshot.ts";
import type { ConnState, Ctx, Result, StartOptions } from "./types.ts";

/** Свои закрытия соединений — не отказ relay. */
const OWN_CLOSE = new Set(["closing", "hidden", "now"]);

export type FleetLink = ReturnType<typeof createFleetLink>;

export function createFleetLink(d: {
  o: Pick<StartOptions, "workers" | "pauseMs" | "WebSocket" | "fetch">;
  snap: Snapshot;
  modules: Modules;
  route(): void;
  /** отказ пропуску или остановка relay */
  refused(why: string): void;
}) {
  const { o, snap, modules, route, refused } = d;
  const started = new Set<Promise<unknown>>();
  let client: FleetClient | null = null;
  /** адрес пропуска: новый клиент после ухода со страницы узнаёт его заново, вид всё это время показывает прежний */
  let address: string | null = null;
  /** since машин по roster: сменился или машина пришла — её экраны спрашивают заново */
  let sinceOf: Map<string, unknown> | null = null;
  /** машины, чьё соединение вернулось внутри открытого флота: подписки на них пропали, сообщит их roster */
  const returned = new Set<string>();

  /** Машины этого roster, вернувшиеся, пришедшие или перезапустившиеся; первый roster — точка отсчёта. */
  function machinesBack(r: Roster): string[] {
    const known = sinceOf;
    sinceOf = new Map(r.machines.map((m) => [m.machine, m.since]));
    if (!known) return [];
    return r.machines.filter((m) => returned.delete(m.machine) || known.get(m.machine) !== m.since).map((m) => m.machine);
  }

  /** Сообщить модулям состояние флота; machine — внутри открытого флота вернулась только эта машина. */
  function announce(conn: ConnState, machine?: string) {
    snap.set({ conn });
    for (const x of modules.list) if (x.mod.on?.link) modules.call(x, "смене связи", () => x.mod.on!.link!(conn, machine));
    snap.changed();
  }

  function fleetState(conn: ConnState, why?: string, retryAt = 0) {
    if (conn === "open") snap.set({ retryAt: 0 });
    if (conn === "closed") {
      snap.set({ retryAt });
      console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
    }
    announce(conn);
  }

  function deliver(f: Frame, ctx: Ctx = { open: false }) {
    const owner = modules.frameOwner(f.type);
    if (owner) return void modules.call(owner, `кадре ${f.type}`, () => owner.mod.frames![f.type](f, ctx));
    // запрос к приложению: клиент запросов не обслуживает
    if (typeof f.id === "string" && f.type !== "reply") return void client?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
    console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  function welcome(roster: Roster) {
    const n = roster.sessions.length;
    const machines = roster.machines.map((m) => m.machine).join(" и ") || "машин нет";
    snap.toast(`Вы во флоте: ${machines} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
  }

  function takeRoster(f: Frame) {
    const first = !snap.get().roster;
    // roster флота — объединение roster объектов машин
    const roster = client?.roster ?? (f as unknown as Roster);
    snap.set({ roster, rosterAt: Date.now() });
    const back = machinesBack(roster);
    for (const x of modules.list) if (x.mod.on?.roster && x.m.uses["roster@relay"] !== undefined) modules.call(x, "кадре roster", () => x.mod.on!.roster!(roster));
    if (snap.get().conn === "open") for (const m of back) announce("open", m);
    if (!first) return snap.changed();
    route();
    if (snap.get().fresh) welcome(roster);
  }

  const take = (f: Frame) => (f.type === "roster" ? takeRoster(f) : deliver(f));

  /** Отказ пропуску на любой машине или у gate, остановка relay: дальше не подключаемся. */
  function stop(why: string) {
    announce("stopped");
    refused(why);
  }

  function connect() {
    // флот собран, когда каждое соединение этого клиента хоть раз открылось или закрылось; до того экраны его не видят:
    // при возвращении на страницу остаётся прежний roster, без мигания «половина флота → весь»
    const settled = new Set<string>();
    /** машины, оборвавшиеся при открытом флоте: их возвращение модули иначе не увидят */
    const dropped = new Set<string>();
    let rosterHeld = false;
    const gathered = () => !!client && client.links().size > 0 && [...client.links().keys()].every((m) => settled.has(m));

    /** Список машин у gate: не ответил и соединений нет — нет связи; ответил, что машин нет, — флот честно пуст. */
    function onGateList(state: string, why?: string, retryAt?: number) {
      if (state === "closed" && !client?.links().size) fleetState("closed", why, retryAt);
      if (state === "open") {
        fleetState("open");
        take({ type: "roster" });
      }
    }

    function onMachine(machine: string, state: string, why?: string, retryAt?: number) {
      const wasGathered = gathered();
      if (state === "closed") dropped.add(machine);
      if (state !== "connecting") settled.add(machine);
      if (!gathered()) return;
      const whole = (client?.state ?? state) as ConnState;
      if (whole !== snap.get().conn) {
        // состояние флота сменилось: о нём и сообщаем, остальные оборвавшиеся сообщат своим возвращением
        dropped.delete(machine);
        fleetState(whole, why, retryAt);
      } else if (state === "open" && dropped.delete(machine)) returned.add(machine);
      else if (state === "closed" && whole === "closed" && retryAt) {
        // флот без связи: отсчёт — до ближайшей попытки любого соединения
        const planned = snap.get().retryAt;
        snap.set({ retryAt: planned > Date.now() ? Math.min(planned, retryAt) : retryAt });
      }
      // последней собралась закрывшаяся машина: отложенный roster остальных — сейчас; открывшаяся пришлёт свой следом
      if (!wasGathered && rosterHeld) {
        rosterHeld = false;
        if (state !== "open") take({ type: "roster" });
      }
    }

    client = fleet({
      workers: o.workers,
      key: snap.get().key,
      pauseMs: o.pauseMs,
      WebSocket: o.WebSocket as WsCtor | undefined,
      fetch: o.fetch,
      onState(machine, state, why, retryAt) {
        if (state === "stopped") {
          if (!OWN_CLOSE.has(why ?? "")) stop(why ?? "");
          return;
        }
        return machine ? onMachine(machine, state, why, retryAt) : onGateList(state, why, retryAt);
      },
      onFrame(f) {
        if (f.type === "roster" && !gathered()) rosterHeld = true;
        else take(f);
      },
    });
  }

  return {
    connect,
    deliver,
    address() {
      address = client?.addr ?? address;
      return address;
    },
    reconnectNow() {
      client?.close(1000, "now");
      connect();
    },
    /** Запрос кадром; связи нет — disconnected сразу. Начатый запрос держит уход с экрана до reply. read — только читает: предел 10 с. */
    async request(f: Frame, read = false): Promise<Result> {
      if (!client || snap.get().conn !== "open") return { ok: false, error: "disconnected" };
      const pending = client.request(f, read);
      started.add(pending);
      const r = await pending;
      started.delete(pending);
      if (r.ok) return { ok: true, result: r.result };
      const { why } = r as { why?: unknown };
      return { ok: false, error: r.error, ...(typeof why === "string" ? { why } : {}) };
    },
    /** Дождаться начатых запросов. */
    finishRequests: () => Promise.all([...started]),
    /** Уход с экрана: close(1000); страница скрыта — вид не будим. */
    close() {
      client?.close(1000, "hidden");
      client = null;
      snap.set({ conn: "connecting", retryAt: 0 }, { quiet: true });
    },
  };
}
