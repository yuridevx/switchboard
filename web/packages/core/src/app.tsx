// Ядро веб-приложения: гейт набора, пропуск, связь с машинами флота клиентом fleet, маршрут кадров модулям,
// экраны и адрес, хранилище, штатный уход с экрана. Ни одной функции приложения само не знает.
// Вид ядра — разделы, шапка, поиск, экраны входа и отказа — в папке view.
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import { serviceAddress } from "@switchboard/protocol";
import { plural } from "@switchboard/web-ui";
import { appGate, nameOf, ownerOf } from "./gate.ts";
import { idbStore } from "./store.ts";
import { same } from "./same.ts";
import type { App, AppModule, ConnState, Ctx, Manifest, Params, Platform, Result, Running, Screen, SlotProps, StartOptions } from "./types.ts";
import { place } from "./view/place.tsx";
import { pageCss, Root, type Core, type Hit } from "./view/shell.tsx";
import { browserOld, connectionStopped, gateRefused, inviteRefused, installHere, KeyPrompt, outdated, passRefused } from "./view/stops.tsx";

export type Mod = { m: Manifest; mod: AppModule; app: App; failed: string | null };

/** Приглашение в адресе страницы: #invite=<номер>.<секрет>; его же принимает поле ввода. */
const INVITE_RE = /^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/;
/** Предел приёма приглашения у gate. */
const REDEEM_MS = 30_000;
/** Причины своих закрытий link — не отказ relay. */
const OWN = new Set(["closing", "hidden", "now"]);
const MAX_PAUSE = 60_000;

/** Номер пропуска для экрана: client.phone.k2a9.<секрет> → client.phone.k2a9. */
export const keyId = (key: string) => key.split(".").slice(0, 3).join(".");

/** Платформа по navigator: iPhone/iPad, запущено ли с экрана «Домой», есть ли @scope. */
export function detectPlatform(win: Window): Platform {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent);
  const standalone = nav.standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches;
  return { ios, standalone, scope: "CSSScopeRule" in win };
}

/** Запустить приложение: гейт → ключ → модули → связь. */
export function startApp(o: StartOptions): Running {
  const win = o.window ?? window;
  const doc = win.document;
  const store = o.store ?? idbStore();
  const platform = o.platform ?? detectPlatform(win);
  const firstPause = o.pauseMs ?? 1_000;
  const wide = !!o.wide;
  /** Как получить пропуск: приглашение выдаёт агент инструментом keys.invite. */
  const invite = (n: string) => `keys.invite client ${n} <почта>`;

  const mods: Mod[] = [];
  const frameOwner = new Map<string, Mod>();
  const screenOwner = new Map<string, { owner: Mod; def: Screen }>();
  const markOwner = new Map<string, Mod>();
  const pending = new Set<Promise<unknown>>();

  let stopped: string | null = null;
  let full: ReactNode = null;
  let css = pageCss([]);
  let key = "";
  let name = "";
  let lk: FleetClient | null = null;
  let conn: ConnState = "connecting";
  let roster: Roster | null = null;
  let rosterAt = 0;
  let pause = firstPause;
  let retryAt = 0;
  let fresh = false;
  let hidden = false;
  let routed = "";
  let current: { screen: string; params: Params } | null = null;
  let master: string | null = null;
  let tops: string[] = [];
  let connecting = false;
  let depth = 0;
  let life: Promise<void> = Promise.resolve();
  let tick: ReturnType<typeof setInterval> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toastNow: { text: string; tone: "ok" | "bad"; shown: boolean } | null = null;

  // ───── подписка вида: одно уведомление за такт ─────
  const subs = new Set<() => void>();
  let rev = 0;
  let queued = false;
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => void subs.delete(f);
  };
  function changed() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      rev++;
      for (const f of [...subs]) f();
    });
  }

  /** Хук выборки: ответ сравнивается с прошлым, тот же — компонент не перерисовывается. */
  function useSelect<T>(select: () => T): T {
    const last = useRef<{ v: T } | null>(null);
    const snap = () => {
      const v = select();
      if (!last.current || !same(last.current.v, v)) last.current = { v };
      return last.current.v;
    };
    return useSyncExternalStore(subscribe, snap, snap);
  }

  function stopWith(why: string, node: ReactNode) {
    stopped = why;
    console.error(`switchboard: ${why}`);
    clearInterval(tick);
    full = node;
    changed();
  }

  // ───── модули ─────
  function failMod(x: Mod, where: string, e: unknown) {
    if (x.failed) return;
    x.failed = `Модуль ${x.m.name} упал на ${where}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    console.error(x.failed, e);
    changed();
  }

  function call<R>(x: Mod, where: string, fn: () => R): R | undefined {
    if (x.failed) return undefined;
    try {
      return fn();
    } catch (e) {
      failMod(x, where, e);
      return undefined;
    }
  }

  async function callAsync(x: Mod, where: string, fn: () => unknown) {
    if (x.failed) return;
    try {
      await fn();
    } catch (e) {
      failMod(x, where, e);
    }
  }

  function usesRef(x: Mod, n: string): string | undefined {
    return Object.keys(x.m.uses).find((r) => nameOf(r) === n);
  }

  /** Может ли модуль открыть экран: свой, из uses или вставленный в его место. */
  function mayOpen(x: Mod, screen: string): boolean {
    const at = screenOwner.get(screen)?.def.place;
    return x.mod.screens?.[screen] !== undefined || (at !== undefined && x.m.provides[at] !== undefined) || !!usesRef(x, screen);
  }

  async function request(x: Mod, n: string, body: Record<string, unknown> = {}): Promise<Result> {
    const ref = usesRef(x, n);
    if (!ref) {
      failMod(x, `запросе ${n}`, new Error(`${n} нет в uses`));
      return { ok: false, error: "module_error" };
    }
    const owner = ownerOf(ref);
    // версия — названная в вызове как есть, иначе из uses: одно правило с ядром Host
    const f: Frame = { ...body, type: n, v: (body.v as number | undefined) ?? x.m.uses[ref] };
    // Worker — .имя, POST по адресу из сборки; имя и версию проверяет получатель и отвечает словом
    if (Object.hasOwn(o.workers, owner)) f.to = serviceAddress(owner);
    if (!lk || conn !== "open") return { ok: false, error: "disconnected" };
    const p = lk.request(f);
    pending.add(p);
    const r = await p;
    pending.delete(p);
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
  }

  function deliver(f: Frame, ctx: Ctx = { open: false }) {
    const x = frameOwner.get(f.type);
    if (x) {
      call(x, `кадре ${f.type}`, () => x.mod.frames![f.type](f, ctx));
      return;
    }
    if (typeof f.id === "string" && f.type !== "reply") {
      // запрос к приложению: клиент запросов не обслуживает
      lk?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
      return;
    }
    console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  const lookup = (screen: string) => screenOwner.get(screen);
  const Place = place({ lookup, use: useSelect, fail: failMod, reload: () => win.location.reload() });

  function appFor(x: Mod): App {
    const Slot = (p: SlotProps) => {
      // чужой экран вне uses — ошибка вызывающего: её ловит граница его экрана
      if (!mayOpen(x, p.screen)) throw new Error(`экрана ${p.screen} нет в uses`);
      return <Place screen={p.screen} params={p.params} close={p.close} />;
    };
    return {
      get name() {
        return name;
      },
      wide,
      request: ((n: string, body?: Record<string, unknown>) => request(x, n, body)) as App["request"],
      open: (screen, params = {}) => {
        if (!mayOpen(x, screen)) return failMod(x, `открытии ${screen}`, new Error(`экрана ${screen} нет в uses`));
        const s = screenOwner.get(screen);
        if (s?.def.run) return void call(s.owner, `команде ${screen}`, () => s.def.run!(params));
        go(screen, params);
      },
      placed: (at, params = {}) => {
        if (x.m.provides[at] === undefined) {
          failMod(x, `месте ${at}`, new Error(`места ${at} нет в provides`));
          return [];
        }
        return [...screenOwner]
          .filter(([n, s]) => s.def.place === at && !s.owner.failed && (!s.def.show || call(s.owner, `экране ${n}`, () => s.def.show!(params)) === true))
          .map(([n, s]) => ({ screen: n, label: s.def.label ?? n }));
      },
      back,
      can: (machine, n) => {
        const m = roster?.machines.find((y) => y.machine === machine);
        return m ? (m.contract ?? {})[n] !== undefined : null;
      },
      roster: () => roster,
      worker: (n) => (Object.hasOwn(o.workers, n) ? o.workers[n] : null),
      current: () => (current ? { screen: current.screen, params: { ...current.params } } : null),
      link: () => conn,
      mark: ((n: string, ...args: string[]) => {
        if (!usesRef(x, n) && !x.mod.marks?.[n]) {
          failMod(x, `метке ${n}`, new Error(`метки ${n} нет в uses`));
          return undefined;
        }
        const ow = markOwner.get(n);
        return ow ? call(ow, `метке ${n}`, () => ow.mod.marks![n](...args)) : undefined;
      }) as App["mark"],
      store: <T,>(section: string) => {
        if (!x.mod.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${x.m.name}`);
        return {
          get: () => store.get<T>(section),
          set: (v: T) => store.set(section, v),
          update: (fn: (old: T | undefined) => T) => store.update<T>(section, fn),
        };
      },
      deliver,
      changed,
      toast,
      use: useSelect,
      Slot,
    };
  }

  // ───── экраны и адрес ─────
  function parseHash(): { screen: string; params: Params } {
    const raw = win.location.hash.replace(/^#/, "");
    const [path, q = ""] = raw.split("?");
    for (const [n, s] of screenOwner) {
      if ((s.def.path ?? n) === path && s.def.place !== "top") return { screen: n, params: Object.fromEntries(new URLSearchParams(q)) };
    }
    return { screen: home(), params: {} };
  }

  /** Разделы по порядку: сначала по sections оболочки, остальные — следом в порядке списка модулей. */
  function sections() {
    const rank = (n: string) => {
      const i = o.sections?.indexOf(n) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...screenOwner].filter(([, s]) => s.def.nav && s.def.place !== "top").sort(([a], [b]) => rank(a) - rank(b));
  }

  function home(): string {
    return sections()[0]?.[0] ?? [...screenOwner.keys()][0] ?? "";
  }

  function hashOf(screen: string, params: Params): string {
    const s = screenOwner.get(screen);
    const q = new URLSearchParams(params).toString();
    return "#" + (s?.def.path ?? screen) + (q ? "?" + q : "");
  }

  function go(screen: string, params: Params) {
    const hs = hashOf(screen, params);
    if (hs === win.location.hash) return;
    depth++;
    win.history.pushState({ depth }, "", hs);
    route();
  }

  function back() {
    if (depth > 0) {
      depth--;
      win.history.back();
      return;
    }
    const hs = hashOf(home(), {});
    win.history.replaceState(null, "", hs);
    route();
  }

  function route() {
    if (stopped || !roster) return;
    const next = parseHash();
    routed = win.location.hash;
    // широкий вид: экран рядом со списком — список слева остаётся, меняется только правая часть;
    // слева — разрешённый список, который уже стоит слева или открыт сейчас; иначе первый
    const allowed = wide ? [o.beside?.[next.screen] ?? []].flat() : [];
    const was = master ?? current?.screen;
    const name = was && allowed.includes(was) ? was : allowed[0];
    master = name && screenOwner.has(name) ? name : null;
    current = next;
    changed();
  }

  // ───── поиск Ctrl K: разделы и то, что экраны отдают в find ─────
  const groupOf = (d: Screen) => (wide ? d.group : (d.narrowGroup ?? d.group));

  function hits(q: string): Hit[] {
    const ql = q.trim().toLowerCase();
    const out: Hit[] = [];
    for (const [n, s] of screenOwner) {
      if (s.owner.failed || s.def.place === "top") continue;
      if (s.def.nav && (!ql || s.def.nav.toLowerCase().includes(ql))) out.push({ label: s.def.nav, hint: groupOf(s.def) ?? "раздел", screen: n, params: {} });
      if (!s.def.find) continue;
      for (const x of call(s.owner, `экране ${n}`, () => s.def.find!(ql)) ?? []) {
        // строка ведёт на экран своего модуля или экран из его uses
        if (s.owner.mod.screens?.[x.screen] === undefined && !usesRef(s.owner, x.screen)) continue;
        out.push({ label: x.label, hint: x.hint, dot: x.dot, screen: x.screen, params: x.params ?? {} });
      }
    }
    return out.slice(0, 40);
  }

  /** Счёт метки раздела: число > 0 или null. */
  function countOf(s: { owner: Mod; def: Screen }): number | null {
    const c = s.def.mark && !s.owner.failed ? call(s.owner, `метке ${s.def.mark}`, () => s.owner.mod.marks![s.def.mark!]()) : undefined;
    return typeof c === "number" && c > 0 ? c : null;
  }

  function toast(text: string, tone: "ok" | "bad" = "bad") {
    clearTimeout(toastTimer);
    toastNow = { text, tone, shown: true };
    changed();
    toastTimer = setTimeout(() => {
      if (toastNow) toastNow = { ...toastNow, shown: false };
      changed();
    }, 6_000);
  }

  // ───── связь ─────
  function connect() {
    pause = firstPause;
    // флот собран, когда каждое соединение этого клиента хоть раз открылось или закрылось; до того roster неполный —
    // экраны его не видят: при возвращении на страницу остаётся прежний, без мигания «половина флота → весь»
    const settled = new Set<string>();
    let held = false;
    const whole = () => !!lk && lk.links().size > 0 && [...lk.links().keys()].every((m) => settled.has(m));
    lk = fleet({
      workers: o.workers,
      key,
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
        if (now !== conn) onState(now, why);
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

  function reconnectNow() {
    lk?.close(1000, "now");
    connect();
  }

  function setConn(s: ConnState) {
    conn = s;
    for (const x of mods) if (x.mod.on?.link) call(x, "смене связи", () => x.mod.on!.link!(s));
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
      retryAt = 0;
      setConn("open");
      return;
    }
    if (s === "closed") {
      // та же пауза, что у link: растёт вдвое до потолка, сбрасывается на принятом hello
      retryAt = Date.now() + pause;
      pause = Math.min(pause * 2, MAX_PAUSE);
      console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
      setConn("closed");
      clearInterval(tick);
      tick = setInterval(changed, 1_000);
      return;
    }
    setConn("connecting");
  }

  function onFrame(f: Frame) {
    if (f.type === "roster") {
      const first = !roster;
      // roster флота — объединение roster объектов машин
      roster = lk?.roster ?? (f as unknown as Roster);
      rosterAt = Date.now();
      for (const x of mods) {
        if (x.mod.on?.roster && x.m.uses["roster@relay"] !== undefined) call(x, "кадре roster", () => x.mod.on!.roster!(roster!));
      }
      if (first) {
        connecting = false;
        route();
        if (fresh) {
          const ms = roster.machines.map((m) => m.machine);
          const n = roster.sessions.length;
          toast(`Вы во флоте: ${ms.join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
        }
      } else changed();
      return;
    }
    deliver(f);
  }

  /** Стереть пропуск и данные приложения на устройстве; дальше — страница без приглашения в адресе: поле приглашения. */
  async function wipe() {
    await store.clear();
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
    win.location.reload();
  }
  const reload = () => win.location.reload();

  function refused(why: string) {
    if (why === "revoked" || why === "bad_key") return stopWith(why, passRefused(why, keyId(key), invite(name), wipe));
    if (why === "contract_mismatch") return stopWith(why, outdated(reload));
    return stopWith(why, connectionStopped(why, reload));
  }

  /** Приём приглашения: POST gate.redeem → пропуск или слово отказа. */
  async function redeem(inv: string): Promise<{ key: string } | { error: string }> {
    try {
      const res = await (o.fetch ?? fetch)(o.workers.gate ?? "", { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite: inv }), signal: AbortSignal.timeout(REDEEM_MS) });
      const r = (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
      return r.ok && r.result ? { key: r.result.key } : { error: r.error ?? "bad_invite" };
    } catch {
      return { error: "gate_unavailable" };
    }
  }

  // ───── уход с экрана и возвращение ─────
  function hide(): Promise<void> {
    life = life.then(async () => {
      if (hidden || stopped) return;
      hidden = true;
      // начатые доводятся до reply, модули дописывают своё (и снимают подписки), затем close(1000)
      await Promise.all([...pending]);
      for (const x of [...mods].reverse()) if (x.mod.stop) await callAsync(x, "остановке", () => x.mod.stop!());
      await Promise.all([...pending]);
      clearInterval(tick);
      lk?.close(1000, "hidden");
      lk = null;
      conn = "connecting";
      retryAt = 0;
    });
    return life;
  }

  function show(): Promise<void> {
    life = life.then(async () => {
      if (!hidden || stopped) return;
      hidden = false;
      for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!(x.app));
      connect();
    });
    return life;
  }

  // ───── старт ─────
  async function boot() {
    const errors = appGate(o.parts);
    if (errors.length) return stopWith("gate", gateRefused(errors));
    if (platform.scope === false) return stopWith("browser", browserOld());
    for (const p of o.parts) {
      const x: Mod = { m: p.manifest, mod: p.module, app: null as unknown as App, failed: null };
      x.app = appFor(x);
      mods.push(x);
      for (const t of Object.keys(p.module.frames ?? {})) frameOwner.set(t, x);
      for (const [n, def] of Object.entries(p.module.screens ?? {})) screenOwner.set(n, { owner: x, def });
      for (const n of Object.keys(p.module.marks ?? {})) markOwner.set(n, x);
    }
    css = pageCss(mods.filter((x) => x.mod.css).map((x) => ({ name: x.m.name, css: x.mod.css! })));
    changed();

    const raw = decodeURIComponent(win.location.hash.replace(/^#/, ""));
    const fromHash = raw.startsWith("invite=") && INVITE_RE.test(raw.slice(7)) ? raw.slice(7) : null;
    if (fromHash && platform.ios && !platform.standalone) {
      // iPhone: пуши — только у приложения с экрана «Домой», хранилище у него своё — приглашение ждёт в адресе, не погашено
      stopped = "install";
      full = installHere(fromHash.split(".")[0]);
      return changed();
    }
    if (fromHash) {
      // приглашение — у gate: секрет пропуска рождается там и приходит один раз; адрес очищен в любом исходе
      win.history.replaceState(null, "", win.location.pathname + win.location.search);
      // то же приглашение уже принято на этом устройстве: иконка экрана «Домой» помнит адрес с #invite= — пропуск в хранилище
      const had = (await store.get<string>("key")) ?? "";
      if (had.split(".")[2] !== fromHash.split(".")[0]) {
        const r = await redeem(fromHash);
        if ("error" in r) return stopWith(r.error, inviteRefused(r.error, wipe));
        await store.set("key", r.key);
        fresh = true;
      }
    }
    key = (await store.get<string>("key")) ?? "";
    if (!key) {
      // приглашение не доехало (iPhone: адрес не дошёл до экрана «Домой») — вставить вручную
      const accept = async (value: string): Promise<string | null> => {
        const v = decodeURIComponent(value.trim().replace(/^.*#(invite=)?/, ""));
        if (!INVITE_RE.test(v)) return "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.";
        const r = await redeem(v);
        if ("error" in r) return `Приглашение не принято: ${r.error}.`;
        await store.set("key", r.key);
        win.location.reload();
        return null;
      };
      return stopWith("no_key", <KeyPrompt command={invite(wide ? "<имя>" : "phone")} accept={accept} />);
    }
    name = key.split(".")[1];

    for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!(x.app));
    tops = [...screenOwner].filter(([, s]) => s.def.place === "top").map(([n]) => n);
    connecting = true;
    changed();
    win.addEventListener("popstate", () => {
      depth = (win.history.state as { depth?: number } | null)?.depth ?? 0;
      route();
    });
    win.addEventListener("hashchange", () => {
      if (win.location.hash !== routed) route();
    });
    doc.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? hide() : show()));
    win.addEventListener("pagehide", () => hide());
    if (doc.visibilityState === "hidden") hidden = true;
    else connect();
  }

  const core: Core = {
    wide,
    brand: o.brand,
    win,
    css: () => css,
    subscribe,
    rev: () => rev,
    use: useSelect,
    Place,
    full: () => full,
    stopped: () => stopped,
    connecting: () => connecting,
    fresh: () => fresh,
    keyLabel: () => keyId(key),
    roster: () => roster,
    conn: () => conn,
    rosterAt: () => rosterAt,
    retryAt: () => retryAt,
    current: () => current,
    master: () => master,
    tops: () => tops,
    toast: () => toastNow,
    lookup,
    head: (screen, params) => {
      const s = screenOwner.get(screen);
      return (s?.def.head && call(s.owner, `экране ${screen}`, () => s.def.head!(params))) || { title: s?.def.nav ?? s?.def.label ?? "" };
    },
    sections,
    countOf,
    groupOf,
    hits,
    go,
    back,
    reconnectNow,
  };

  // каркас страницы встаёт сразу: экран старта виден до ответа хранилища
  const view = createRoot(o.root);
  flushSync(() => view.render(<Root core={core} />));

  const ready = boot();
  return {
    ready,
    get stopped() {
      return stopped;
    },
    get failed() {
      return Object.fromEntries(mods.filter((x) => x.failed).map((x) => [x.m.name, x.failed!]));
    },
    hide,
    show,
  };
}
