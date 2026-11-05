// Адрес страницы и экран: что открыто, история переходов, экран-список рядом в широком виде.
import type { Modules } from "./modules.ts";
import type { Sections } from "./sections.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Params } from "./types.ts";

export type Address = ReturnType<typeof createAddress>;

export function createAddress(d: { win: Window; wide: boolean; beside?: Record<string, string | string[]>; modules: Modules; sections: Sections; snap: Snapshot }) {
  const { win, wide, beside, modules, sections, snap } = d;
  const { screens } = modules;
  /** адрес, по которому экран уже построен: своё pushState не строит его дважды */
  let builtFor = "";
  /** сколько своих переходов назад ещё есть */
  let depth = 0;

  function fromHash(): { screen: string; params: Params } {
    const [path, query = ""] = win.location.hash.replace(/^#/, "").split("?");
    for (const [name, s] of screens) {
      if ((s.def.path ?? name) === path && s.def.place !== "top") return { screen: name, params: Object.fromEntries(new URLSearchParams(query)) };
    }
    return { screen: sections.home(), params: {} };
  }

  function hashOf(screen: string, params: Params): string {
    const query = new URLSearchParams(params).toString();
    return `#${screens.get(screen)?.def.path ?? screen}${query ? `?${query}` : ""}`;
  }

  /** Широкий вид: список остаётся слева, если он разрешён этому экрану и уже стоит или открыт сейчас; иначе первый разрешённый. */
  function masterFor(screen: string): string | null {
    const { master, current } = snap.get();
    const allowed = wide ? [beside?.[screen] ?? []].flat() : [];
    const standing = master ?? current?.screen;
    const name = standing && allowed.includes(standing) ? standing : allowed[0];
    return name && screens.has(name) ? name : null;
  }

  function route() {
    const { full, roster } = snap.get();
    if (full || !roster) return;
    const next = fromHash();
    builtFor = win.location.hash;
    snap.set({ master: masterFor(next.screen), current: next });
    for (const x of modules.list) if (x.mod.on?.current) modules.call(x, "смене экрана", () => x.mod.on!.current!(next));
  }

  return {
    route,
    go(screen: string, params: Params) {
      const hash = hashOf(screen, params);
      if (hash === win.location.hash) return;
      win.history.pushState({ depth: ++depth }, "", hash);
      route();
    },
    back() {
      if (depth > 0) {
        depth--;
        win.history.back();
        return;
      }
      win.history.replaceState(null, "", hashOf(sections.home(), {}));
      route();
    },
    /** Слушать переходы браузера. */
    listen() {
      win.addEventListener("popstate", () => {
        depth = (win.history.state as { depth?: number } | null)?.depth ?? 0;
        route();
      });
      win.addEventListener("hashchange", () => {
        if (win.location.hash !== builtFor) route();
      });
    },
  };
}
