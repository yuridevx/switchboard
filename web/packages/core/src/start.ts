// Страница приложения: гейт → пропуск → модули → связь → экран из адреса; уход и возвращение. Каждый шаг с пределом.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { fail as refuse, withLimit, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import { plural } from "@switchboard/web-ui";
import { createBus, type Core } from "./core.ts";
import { appGate } from "./gate.ts";
import { connect, type FleetLink } from "./link.ts";
import { createModules } from "./modules.ts";
import { fromInvite, inviteIn, redeem } from "./pass.ts";
import { masterOf, parseHash, sameParams, toHash } from "./route.ts";
import { idbStore } from "./store.ts";
import type { ConnState, Params, Platform, Running, StartOptions } from "./types.ts";
import { slotFor } from "./view/place.tsx";
import { Shell } from "./view/shell.tsx";

const STEP_MS = 30_000;
const TOAST_MS = 6_000;

const platformOf = (win: Window): Platform => ({
  ios: /iPhone|iPad|iPod/.test(win.navigator.userAgent),
  standalone: (win.navigator as { standalone?: boolean }).standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches,
  scope: "CSSScopeRule" in win,
});

/** Запустить приложение: гейт → пропуск → модули → связь. */
export function startApp(o: StartOptions): Running {
  const win = o.window ?? window;
  const doc = win.document;
  const fetcher = o.fetch ?? fetch.bind(globalThis);
  const store = o.store ?? idbStore();
  const platform = o.platform ?? platformOf(win);
  const wide = !!o.wide;
  const bus = createBus();
  const core: Core = { stopped: null, errors: [], invite: null, key: null, invited: false, started: false, link: "connecting", roster: null, rosterAt: null, address: null, lost: null, current: null, toast: null, failed: {}, searching: false };
  const listening = new AbortController();
  const on = { signal: listening.signal };
  let link: FleetLink | null = null;
  let gone = false;
  let hidden = false;
  let leaving: Promise<void> = Promise.resolve();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** запросы, которые ещё ждут ответа: уход их доводит */
  const pending = new Set<Promise<unknown>>();

  function ask(f: Frame, read: boolean): Promise<Reply> {
    if (!link) return Promise.resolve(refuse("", "disconnected"));
    const real = (g: Frame) => (link ? link.request(g, read) : Promise.resolve(refuse("", "disconnected")));
    const r = o.seam ? o.seam.request(f, read, real) : real(f);
    pending.add(r);
    void r.finally(() => pending.delete(r));
    return r;
  }
  async function drained() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  function toast(text: string, tone: "ok" | "bad" = "bad") {
    clearTimeout(toastTimer);
    core.toast = { text, tone, shown: true };
    toastTimer = setTimeout(() => {
      core.toast = { text, tone, shown: false };
      bus.changed();
    }, TOAST_MS);
    bus.changed();
  }

  function deliver(f: Frame, ctx = { open: false }) {
    const owner = modules.entries.find((e) => e.def.frames && Object.hasOwn(e.def.frames, f.type));
    if (owner) {
      if (!modules.off(owner)) modules.trap(owner, `кадре ${f.type}`, () => owner.def.frames![f.type](f, ctx));
    } else if (typeof f.id === "string" && f.type !== "reply") {
      link?.send({ ...refuse(f.id, "unknown_request"), to: f.from } as Frame);
    } else {
      console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
    }
  }

  // ---------- адрес ----------

  /** Экран адреса: незнакомый адрес, команда и полоса top — домашний раздел. */
  function screenAt(hash: string): { screen: string; params: Params } {
    const { path, params } = parseHash(hash);
    for (const e of modules.entries) {
      for (const [name, s] of Object.entries(e.def.screens ?? {})) {
        if ((s.path ?? name) === path && s.place !== "top") return { screen: name, params };
      }
    }
    return { screen: modules.sections()[0] ?? "", params: {} };
  }

  /** Показать экран; тот же экран с теми же параметрами — ничего. */
  function show(next: { screen: string; params: Params }) {
    const was = core.current;
    if (was && was.screen === next.screen && sameParams(was.params, next.params)) return;
    core.current = { ...next, master: masterOf(wide ? o.beside?.[next.screen] : undefined, was) };
    bus.changed();
    modules.each("смене экрана", (d) => d.on?.current?.(next));
  }

  function route() {
    if (core.current && core.stopped === null) show(screenAt(win.location.hash));
  }

  function open(screen: string, params: Params = {}) {
    const was = core.current;
    if (was && was.screen === screen && sameParams(was.params, params)) return;
    const depth = ((win.history.state as { depth?: number } | null)?.depth ?? 0) + 1;
    win.history.pushState({ depth }, "", toHash(modules.screenOf(screen)?.[1].path ?? screen, params));
    // до первого roster экран возьмёт его из адреса
    route();
  }

  function back() {
    if ((win.history.state as { depth?: number } | null)?.depth) return win.history.back();
    const home = modules.sections()[0];
    win.history.replaceState(null, "", toHash(modules.screenOf(home)?.[1].path ?? home));
    show({ screen: home, params: {} });
  }

  // ---------- связь ----------

  function stop(why: string) {
    console.error(`switchboard: ${why}`);
    core.stopped = why;
    core.lost = null;
    core.searching = false;
    bus.changed();
  }

  function takeRoster(given: Roster) {
    const r = o.seam ? o.seam.roster(given) : given;
    core.roster = r;
    core.rosterAt = Date.now();
    for (const e of modules.entries) {
      if (!modules.off(e) && e.manifest.uses["roster@relay"] !== undefined) modules.trap(e, "кадре roster", () => e.def.on?.roster?.(r));
    }
  }

  /** Флот открылся впервые: экран из адреса; принятое приглашение — тост о флоте. */
  function firstOpen(r: Roster) {
    if (core.invited) {
      const n = r.sessions.length;
      toast(`Вы во флоте: ${r.machines.map((m) => m.machine).join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
    }
    show(screenAt(win.location.hash));
  }

  function openLink() {
    if (gone || core.stopped !== null) return;
    core.link = "connecting";
    link = connect({
      workers: o.workers,
      key: core.key!,
      fetch: fetcher,
      WebSocket: o.WebSocket,
      pauseMs: o.pauseMs,
      on: {
        state(state: ConnState, why, roster, address) {
          core.link = state;
          if (state === "stopped") {
            link?.close("stopped");
            link = null;
            stop(why ?? "");
          }
          if (roster) {
            core.roster = o.seam ? o.seam.roster(roster) : roster;
            core.address = address ?? core.address;
            core.lost = null;
          }
          modules.each("смене связи", (d) => d.on?.link?.(state));
          if (roster) {
            takeRoster(roster);
            if (!core.current) firstOpen(roster);
          }
          bus.changed();
        },
        retry(retryAt, why) {
          console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
          if (core.link !== "open") core.lost = { retryAt };
          bus.changed();
        },
        roster(r, machines) {
          takeRoster(r);
          for (const m of machines) modules.each("смене связи", (d) => d.on?.link?.("open", m));
          bus.changed();
        },
        frame: (f) => deliver(f),
      },
    });
  }

  // ---------- уход и возвращение ----------

  function hide(): Promise<void> {
    if (hidden || gone) return leaving;
    hidden = true;
    const farewell = (async () => {
      await drained();
      await Promise.all([...modules.entries].reverse().map((e) => (modules.off(e) ? undefined : modules.trap(e, "остановке", () => e.def.stop?.()))));
      await drained();
    })();
    leaving = withLimit<unknown>(farewell, STEP_MS, () => console.warn("switchboard: прощание модулей не успело за 30 с")).then(() => {
      link?.close("hidden");
      link = null;
      core.link = "connecting";
      core.lost = null;
    });
    return leaving;
  }

  async function comeBack(): Promise<void> {
    await leaving;
    if (!hidden || gone || core.stopped !== null) return;
    hidden = false;
    const greeting = Promise.all(modules.each("возвращении на экран", (d) => d.on?.show?.()));
    await withLimit<unknown>(greeting, STEP_MS, () => console.warn("switchboard: возвращение модулей не успело за 30 с"));
    if (!hidden) openLink();
  }

  // ---------- запуск ----------

  const clearHash = () => win.history.replaceState(null, "", win.location.pathname + win.location.search);

  /** Приглашение → пропуск в хранилище; отказ — слово. */
  async function accept(invite: string): Promise<string | null> {
    const r = await redeem(fetcher, o.workers.gate, invite);
    if ("error" in r) return r.error;
    await store.set("key", r.key);
    core.key = r.key;
    return null;
  }

  async function boot(): Promise<void> {
    if (platform.scope === false) return stop("browser");
    core.errors = appGate(modules.entries.map((e) => ({ manifest: e.manifest, module: modules.off(e) ? {} : e.def })));
    if (core.errors.length) return stop("gate");
    const invite = win.location.hash.startsWith("#invite=") ? inviteIn(win.location.hash) : null;
    core.invite = invite;
    if (invite && platform.ios && !platform.standalone) return stop("install");
    core.key =
      (await withLimit(store.get<string>("key"), STEP_MS, () => {
        throw new Error("хранилище не ответило за 30 с");
      })) ?? null;
    if (invite) {
      clearHash();
      if (core.key && !fromInvite(core.key, invite)) return stop("replace");
      if (!core.key) {
        const word = await accept(invite);
        if (word) return stop(word);
        core.invited = true;
      }
    }
    if (!core.key) return stop("no_key");
    bus.changed();
    const starting = (async () => {
      for (const e of modules.entries) if (!modules.off(e)) await modules.trap(e, "старте", () => e.def.start?.());
    })();
    await withLimit<unknown>(starting, STEP_MS, () => console.warn("switchboard: модули не запустились за 30 с"));
    core.started = true;
    bus.changed();
    if (doc.visibilityState === "hidden") hidden = true;
    else openLink();
  }

  // ---------- страница ----------

  const reload = () => win.location.reload();
  const modules = createModules(o.parts, { core, bus, store, wide, application: o.application, workers: o.workers, sections: o.sections, ask, open, back, toast, deliver, reload, slot: slotFor });

  win.addEventListener("hashchange", route, on);
  win.addEventListener("popstate", route, on);
  doc.addEventListener("visibilitychange", () => void (doc.visibilityState === "hidden" ? hide() : comeBack()), on);
  win.addEventListener("pagehide", () => void hide(), on);

  /** Упал вид ядра или вход: граница модуля сюда не достаёт, на странице — причина. */
  function fell(where: string, e: unknown) {
    gone = true;
    console.error(`switchboard: ${where}`, e);
    o.root.textContent = `Приложение упало: ${e instanceof Error ? e.message : String(e)}`;
  }
  const root = createRoot(o.root, { onUncaughtError: (e) => fell("вид ядра упал", e) });
  const page = {
    core,
    bus,
    modules,
    wide,
    brand: o.brand,
    doc,
    open,
    back,
    reload,
    accept,
    now() {
      link?.close("now");
      openLink();
    },
    search() {
      core.searching = !core.searching;
      bus.changed();
    },
    async wipe() {
      await store.clear();
      clearHash();
      reload();
    },
  };
  flushSync(() => root.render(createElement(Shell, { page })));

  const ready = boot().then(
    () => flushSync(bus.flush),
    (e: unknown) => {
      root.unmount();
      fell("вход не удался", e);
    },
  );

  return {
    ready,
    get stopped() {
      return core.stopped;
    },
    failed: core.failed,
    hide,
    show: comeBack,
    unmount() {
      gone = true;
      listening.abort();
      clearTimeout(toastTimer);
      link?.close("unmount");
      link = null;
      root.unmount();
    },
  };
}
