// Маршрут: адрес страницы ↔ текущий экран, история переходов, экран-список рядом в широком виде.
import type { Nav } from "./nav.ts";
import type { Registry } from "./registry.ts";
import type { CoreStore } from "./state.ts";
import type { Params } from "./types.ts";

export type Router = ReturnType<typeof createRouter>;

export function createRouter(d: { win: Window; wide: boolean; beside?: Record<string, string | string[]>; registry: Registry; nav: Nav; state: CoreStore }) {
  const { win, wide, beside, registry, nav, state } = d;
  const screens = registry.screens;
  /** адрес, по которому уже построен текущий экран: своё pushState не строит его дважды */
  let routed = "";
  let depth = 0;

  function parseHash(): { screen: string; params: Params } {
    const raw = win.location.hash.replace(/^#/, "");
    const [path, q = ""] = raw.split("?");
    for (const [n, s] of screens) {
      if ((s.def.path ?? n) === path && s.def.place !== "top") return { screen: n, params: Object.fromEntries(new URLSearchParams(q)) };
    }
    return { screen: nav.home(), params: {} };
  }

  function hashOf(screen: string, params: Params): string {
    const s = screens.get(screen);
    const q = new URLSearchParams(params).toString();
    return "#" + (s?.def.path ?? screen) + (q ? "?" + q : "");
  }

  function route() {
    const { full, roster, master, current } = state.get();
    if (full || !roster) return;
    const next = parseHash();
    routed = win.location.hash;
    // широкий вид: экран рядом со списком — список слева остаётся, меняется только правая часть;
    // слева — разрешённый список, который уже стоит слева или открыт сейчас; иначе первый
    const allowed = wide ? [beside?.[next.screen] ?? []].flat() : [];
    const was = master ?? current?.screen;
    const name = was && allowed.includes(was) ? was : allowed[0];
    state.set({ master: name && screens.has(name) ? name : null, current: next });
    for (const x of registry.mods) if (x.mod.on?.current) registry.call(x, "смене экрана", () => x.mod.on!.current!(next));
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
    win.history.replaceState(null, "", hashOf(nav.home(), {}));
    route();
  }

  return {
    route,
    go,
    back,
    /** Слушать переходы браузера. */
    listen() {
      win.addEventListener("popstate", () => {
        depth = (win.history.state as { depth?: number } | null)?.depth ?? 0;
        route();
      });
      win.addEventListener("hashchange", () => {
        if (win.location.hash !== routed) route();
      });
    },
  };
}
