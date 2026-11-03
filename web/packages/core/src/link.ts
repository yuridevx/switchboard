// Связь с машинами флота: клиент fleet, состояние связи, roster, маршрут кадров модулям, запросы и пауза переподключения.
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import { plural } from "@switchboard/web-ui";
import type { Registry } from "./registry.ts";
import type { CoreStore } from "./state.ts";
import type { ConnState, Ctx, Result, StartOptions } from "./types.ts";

/** Причины своих закрытий link — не отказ relay. */
const OWN = new Set(["closing", "hidden", "now"]);
const MAX_PAUSE = 60_000;

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
  const firstPause = o.pauseMs ?? 1_000;
  const pending = new Set<Promise<unknown>>();
  let lk: FleetClient | null = null;
  let pause = firstPause;
  let tick: ReturnType<typeof setInterval> | undefined;

  function setConn(conn: ConnState) {
    state.set({ conn });
    for (const x of registry.mods) if (x.mod.on?.link) registry.call(x, "смене связи", () => x.mod.on!.link!(conn));
    changed();
  }

  function onState(s: string, why?: string) {
    if (s === "stopped") {
      if (why !== undefined && OWN.has(why)) return;
      clearInterval(tick);
      setConn("stopped");
      return refused(why ?? "");
    }
    if (s === "open") {
      clearInterval(tick);
      pause = firstPause;
      state.set({ retryAt: 0 });
      setConn("open");
      return;
    }
    if (s === "closed") {
      // та же пауза, что у link: растёт вдвое до потолка, сбрасывается на принятом hello
      const retryAt = Date.now() + pause;
      state.set({ retryAt });
      pause = Math.min(pause * 2, MAX_PAUSE);
      console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
      setConn("closed");
      clearInterval(tick);
      tick = setInterval(changed, 1_000);
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
    for (const x of registry.mods) {
      if (x.mod.on?.roster && x.m.uses["roster@relay"] !== undefined) registry.call(x, "кадре roster", () => x.mod.on!.roster!(roster));
    }
    if (!first) return changed();
    state.set({ connecting: false });
    route();
    if (state.get().fresh) {
      const ms = roster.machines.map((m) => m.machine);
      const n = roster.sessions.length;
      toast(`Вы во флоте: ${ms.join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
    }
  }

  function connect() {
    pause = firstPause;
    // флот собран, когда каждое соединение этого клиента хоть раз открылось или закрылось; до того roster неполный —
    // экраны его не видят: при возвращении на страницу остаётся прежний, без мигания «половина флота → весь»
    const settled = new Set<string>();
    let held = false;
    const whole = () => !!lk && lk.links().size > 0 && [...lk.links().keys()].every((m) => settled.has(m));
    lk = fleet({
      workers: o.workers,
      key: state.get().key,
      pauseMs: firstPause,
      maxPauseMs: MAX_PAUSE,
      WebSocket: o.WebSocket as WsCtor | undefined,
      fetch: o.fetch,
      // отказ пропуску на любой машине или у gate — остановка; иначе состояние флота: открыт, если открыта хоть одна машина;
      // модули узнают о смене состояния флота, а не каждого соединения
      onState: (m, s, why) => {
        if (s === "stopped" && why !== undefined && !OWN.has(why)) return onState("stopped", why);
        const was = whole();
        if (m && s !== "connecting") settled.add(m);
        if (!whole()) return;
        const now = lk?.state ?? s;
        if (now !== state.get().conn) onState(now, why);
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
    reconnectNow() {
      lk?.close(1000, "now");
      connect();
    },
    /** Запрос кадром; связи нет — disconnected сразу. Начатый запрос держит уход с экрана до reply. */
    async request(f: Frame): Promise<Result> {
      if (!lk || state.get().conn !== "open") return { ok: false, error: "disconnected" };
      const p = lk.request(f);
      pending.add(p);
      const r = await p;
      pending.delete(p);
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    },
    /** Дождаться начатых запросов. */
    settle: () => Promise.all([...pending]),
    /** Уход с экрана: close(1000); страница скрыта — вид не будим. */
    close() {
      clearInterval(tick);
      lk?.close(1000, "hidden");
      lk = null;
      state.set({ conn: "connecting", retryAt: 0 }, { quiet: true });
    },
    stopTick: () => clearInterval(tick),
  };
}
