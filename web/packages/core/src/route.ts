// Адрес: экран и параметры после #. Адрес — источник правды: и open, и назад, и ссылка идут через него.
import type { Modules } from "./modules.ts";
import type { Page } from "./page.ts";
import type { Params } from "./types.ts";

export type Route = ReturnType<typeof createRoute>;

export function createRoute(page: Page, mods: Modules) {
  const { win } = page;
  const home = () => mods.sections[0]?.name;

  function addressOf(screen: string, params: Params = {}) {
    const query = new URLSearchParams(params).toString();
    return `#${mods.screens.get(screen)?.def.path ?? screen}${query ? `?${query}` : ""}`;
  }

  /** Экран адреса; незнакомый адрес — домашний раздел. */
  function parse(): { screen: string; params: Params } {
    const hash = win.location.hash.slice(1);
    const at = hash.indexOf("?");
    const path = at < 0 ? hash : hash.slice(0, at);
    const s = [...mods.screens.values()].find((x) => (x.def.path ?? x.name) === path && !mods.isTop(x));
    return s ? { screen: s.name, params: Object.fromEntries(new URLSearchParams(at < 0 ? "" : hash.slice(at + 1))) } : { screen: home(), params: {} };
  }

  /** Список слева: тот, что уже стоит или открыт сейчас, иначе первый. */
  function masterOf(screen: string) {
    const lists = [page.o.beside?.[screen] ?? []].flat();
    if (!page.wide || !lists.length) return null;
    const was = page.current;
    return lists.find((l) => l === was?.master) ?? lists.find((l) => l === was?.screen) ?? lists[0];
  }

  /** Открыть экран адреса: до первого roster и после отказа не открывается ничего. */
  function follow() {
    if (!page.roster || page.stop) return;
    const { screen, params } = parse();
    const was = page.current;
    if (!screen || (was?.screen === screen && JSON.stringify(was.params) === JSON.stringify(params))) return;
    page.current = { screen, params, master: masterOf(screen) };
    page.changed();
    mods.each("переходе", (d) => d.on?.current?.({ screen, params }));
  }

  return {
    follow,
    addressOf,
    open(screen: string, params?: Params) {
      const hash = addressOf(screen, params);
      if (win.location.hash === hash) return;
      win.history.pushState({ depth: (win.history.state?.depth ?? 0) + 1 }, "", hash);
      follow();
    },
    back() {
      if (win.history.state?.depth) return win.history.back();
      win.history.replaceState(null, "", addressOf(home()));
      follow();
    },
    /** Убрать приглашение из адреса. */
    clear: () => win.history.replaceState(null, "", win.location.pathname + win.location.search),
    listen(on: { signal: AbortSignal }) {
      win.addEventListener("hashchange", follow, on);
      win.addEventListener("popstate", follow, on);
    },
  };
}
