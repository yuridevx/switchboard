// Связь с машинами флота: клиент fleet, состояние связи, roster, маршрут кадров модулям, запросы и пауза переподключения.
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import { plural } from "@switchboard/web-ui";
import type { Registry } from "./registry.ts";
import type { CoreStore } from "./state.ts";
import type { ConnState, Ctx, Result, StartOptions } from "./types.ts";

/** Причины своих закрытий link — не отказ relay. */
const OWN = new Set(["closing", "hidden", "now"]);

export type Link = ReturnType<typeof createLink>;

export function createLink(d: {
  o: Pick<StartOptions, "workers" | "pauseMs" | "WebSocket" | "fetch">;
  state: CoreStore;
  registry: Registry;
  changed(): void;
  route(): void;
  toast(text: string, tone?: "ok" | "bad"): void;
  /** отказ пропуску или остановка relay */
  refused(why: string): void;
}) {
  const { o, state, registry, changed, route, toast, refused } = d;
  const pending = new Set<Promise<unknown>>();
  let lk: FleetClient | null = null;
  /** адрес пропуска: новый клиент после ухода со страницы узнаёт его заново, вид всё это время показывает прежний */
  let addr: string | null = null;
  /** since машин по roster: новый или машина пришла — её экраны спрашивают заново; других копий нет */
  let since: Map<string, unknown> | null = null;
  /** машины, чьё соединение вернулось внутри открытого флота: подписки на них пропали, сообщит их roster */
  const returned = new Set<string>();

  /** Машины этого roster, вернувшиеся, пришедшие или перезапустившиеся; первый roster — точка отсчёта. */
  function backOf(r: Roster): string[] {
    const was = since;
    since = new Map(r.machines.map((m) => [m.machine, m.since]));
    if (!was) return [];
    return r.machines.filter((m) => returned.delete(m.machine) || was.get(m.machine) !== m.since).map((m) => m.machine);
  }

  function setConn(conn: ConnState, machine?: string) {
    state.set({ conn });
    for (const x of registry.mods) if (x.mod.on?.link) registry.call(x, "смене связи", () => x.mod.on!.link!(conn, machine));
    changed();
  }

  function onState(s: string, why?: string, retryAt = 0) {
    if (s === "stopped") {
      if (why !== undefined && OWN.has(why)) return;
      setConn("stopped");
      return refused(why ?? "");
    }
    if (s === "open") {
      state.set({ retryAt: 0 });
      setConn("open");
      return;
    }
    if (s === "closed") {
      state.set({ retryAt });
      console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
      setConn("closed");
      return;
    }
    setConn("connecting");
  }

  function deliver(f: Frame, ctx: Ctx = { open: false }) {
    const x = registry.frameOwner(f.type);
    if (x) {
      registry.call(x, `кадре ${f.type}`, () => x.mod.frames![f.type](f, ctx));
      return;
    }
    if (typeof f.id === "string" && f.type !== "reply") {
      // запрос к приложению: клиент запросов не обслуживает
      lk?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
      return;
    }
    console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  function onFrame(f: Frame) {
    if (f.type !== "roster") return deliver(f);
    const first = !state.get().roster;
    // roster флота — объединение roster объектов машин
    const roster = lk?.roster ?? (f as unknown as Roster);
    state.set({ roster, rosterAt: Date.now() });
    const back = backOf(roster);
    for (const x of registry.mods) {
      if (x.mod.on?.roster && x.m.uses["roster@relay"] !== undefined) registry.call(x, "кадре roster", () => x.mod.on!.roster!(roster));
    }
    if (state.get().conn === "open") for (const m of back) setConn("open", m);
    if (!first) return changed();
    route();
    if (state.get().fresh) {
      const ms = roster.machines.map((m) => m.machine);
      const n = roster.sessions.length;
      toast(`Вы во флоте: ${ms.join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
    }
  }

  function connect() {
    // флот собран, когда каждое соединение этого клиента хоть раз открылось или закрылось; до того roster неполный —
    // экраны его не видят: при возвращении на страницу остаётся прежний, без мигания «половина флота → весь»
    const settled = new Set<string>();
    let held = false;
    /** машины, оборвавшиеся при открытом флоте: их возвращение модули иначе не увидят */
    const gone = new Set<string>();
    const whole = () => !!lk && lk.links().size > 0 && [...lk.links().keys()].every((m) => settled.has(m));
    lk = fleet({
      workers: o.workers,
      key: state.get().key,
      pauseMs: o.pauseMs,
      WebSocket: o.WebSocket as WsCtor | undefined,
      fetch: o.fetch,
      // отказ пропуску на любой машине или у gate — остановка; иначе состояние флота: открыт, если открыта хоть одна машина;
      // модули узнают о смене состояния флота, а не каждого соединения
      onState: (m, s, why, retryAt) => {
        if (s === "stopped" && why !== undefined && !OWN.has(why)) return onState("stopped", why);
        // список машин у gate: не ответил и соединений нет — полоса «Нет связи», fleet спросит снова
        if (m === "" && s === "closed") return lk?.links().size ? undefined : onState("closed", why, retryAt);
        // ответил, что машин нет: флот честно пуст, страница работает, Worker'ы — напрямую
        if (m === "" && s === "open") {
          onState("open");
          return onFrame({ type: "roster" });
        }
        const was = whole();
        if (m && s === "closed") gone.add(m);
        if (m && s !== "connecting") settled.add(m);
        if (!whole()) return;
        const now = lk?.state ?? s;
        if (now !== state.get().conn) {
          // открылась первая машина: о ней — состояние флота; остальные оборвавшиеся сообщат своим возвращением
          if (m) gone.delete(m);
          onState(now, why, retryAt);
          // одна машина вернулась внутри открытого флота: её hello принят, подписки на ней пропали — сообщит её roster
        } else if (m && s === "open" && gone.delete(m)) returned.add(m);
        // флот без связи: отсчёт — до ближайшей попытки любого соединения
        else if (s === "closed" && now === "closed" && retryAt) {
          const was = state.get().retryAt;
          state.set({ retryAt: was > Date.now() ? Math.min(was, retryAt) : retryAt });
        }
        // последней собралась закрывшаяся машина: отложенный roster остальных — сейчас; открывшаяся пришлёт свой следом
        if (!was && held) {
          held = false;
          if (s !== "open") onFrame({ type: "roster" });
        }
      },
      onFrame: (f) => {
        if (f.type === "roster" && !whole()) return void (held = true);
        onFrame(f);
      },
    });
  }

  return {
    connect,
    deliver,
    address() {
      addr = lk?.addr ?? addr;
      return addr;
    },
    reconnectNow() {
      lk?.close(1000, "now");
      connect();
    },
    /** Запрос кадром; связи нет — disconnected сразу. Начатый запрос держит уход с экрана до reply. read — только читает: предел 10 с. */
    async request(f: Frame, read = false): Promise<Result> {
      if (!lk || state.get().conn !== "open") return { ok: false, error: "disconnected" };
      const p = lk.request(f, read);
      pending.add(p);
      const r = await p;
      pending.delete(p);
      if (r.ok) return { ok: true, result: r.result };
      const why = (r as { why?: unknown }).why;
      return { ok: false, error: r.error, ...(typeof why === "string" ? { why } : {}) };
    },
    /** Дождаться начатых запросов. */
    settle: () => Promise.all([...pending]),
    /** Уход с экрана: close(1000); страница скрыта — вид не будим. */
    close() {
      lk?.close(1000, "hidden");
      lk = null;
      state.set({ conn: "connecting", retryAt: 0 }, { quiet: true });
    },
  };
}
