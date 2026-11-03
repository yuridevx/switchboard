// Ядро веб-приложения: гейт набора, пропуск, связь с машинами флота клиентом fleet, маршрут кадров модулям,
// экраны и адрес, хранилище, штатный уход с экрана. Ни одной функции приложения само не знает.
// Здесь — только сборка частей: bus (подписка вида), state (снимок), registry (модули), nav, router, link, lifecycle, boot; вид — в папке view.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { boot, createHalt } from "./boot.tsx";
import { createBus } from "./bus.ts";
import { createLifecycle } from "./lifecycle.ts";
import { createLink } from "./link.ts";
import { moduleApp } from "./module-app.tsx";
import { createNav } from "./nav.ts";
import { keyId } from "./pass.ts";
import { createRegistry } from "./registry.ts";
import { createRouter } from "./router.ts";
import { createCoreState, createToast } from "./state.ts";
import { idbStore } from "./store.ts";
import type { Platform, Running, StartOptions } from "./types.ts";
import type { Core } from "./view/core.ts";
import { pageCss, Root } from "./view/shell.tsx";

export { keyId };

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
  const store = o.store ?? idbStore();
  const platform = o.platform ?? detectPlatform(win);
  const wide = !!o.wide;

  const bus = createBus();
  const state = createCoreState(pageCss([]), bus.changed);
  const toast = createToast(state);
  const registry = createRegistry(bus.changed);
  const nav = createNav(registry, { wide, sections: o.sections });
  const router = createRouter({ win, wide, beside: o.beside, registry, nav, state });
  const halt = createHalt({ state, store, win, o });
  const link = createLink({ o, state, registry, changed: bus.changed, route: router.route, toast, refused: halt.refused });
  const life = createLifecycle({ registry, link, state });

  const core: Core = {
    wide,
    brand: o.brand,
    win,
    subscribe: bus.subscribe,
    rev: bus.rev,
    use: bus.useSelect,
    state: state.get,
    keyLabel: () => keyId(state.get().key),
    lookup: registry.lookup,
    fail: registry.fail,
    reload: () => win.location.reload(),
    wipe: halt.wipe,
    acceptInvite: halt.acceptInvite,
    head: nav.head,
    sections: nav.sections,
    countOf: nav.countOf,
    groupOf: nav.groupOf,
    hits: nav.hits,
    go: router.go,
    back: router.back,
    reconnectNow: link.reconnectNow,
  };

  // каркас страницы встаёт сразу: экран старта виден до ответа хранилища
  const view = createRoot(o.root, {
    onUncaughtError: (e) => {
      console.error("switchboard: вид ядра упал", e);
      o.root.textContent = `Приложение упало: ${e instanceof Error ? e.message : String(e)}`;
    },
  });
  flushSync(() => view.render(<Root core={core} />));

  const appFor = (x: Parameters<typeof moduleApp>[0]) => moduleApp(x, { o, store, state, registry, router, link, bus, toast, core });
  const ready = boot({ o, state, store, win, platform, registry, appFor, router, link, life, stopWith: halt.stopWith });
  return {
    ready,
    get stopped() {
      return state.get().stopped;
    },
    get failed() {
      return Object.fromEntries(registry.mods.filter((x) => x.failed).map((x) => [x.m.name, x.failed!]));
    },
    hide: life.hide,
    show: life.show,
    unmount: () => view.unmount(),
  };
}
