// Ядро веб-приложения: собирает части и запускает вход. Ни одной функции приложения само не знает.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createAddress } from "./address.ts";
import { createHalt, enter } from "./entry.ts";
import { createFleetLink } from "./fleet-link.ts";
import { createLeave } from "./leave.ts";
import { moduleApp } from "./module-app.ts";
import { createModules } from "./modules.ts";
import { keyId } from "./pass.ts";
import { createSections } from "./sections.ts";
import { createSnapshot } from "./snapshot.ts";
import { idbStore } from "./store.ts";
import type { Platform, Running, StartOptions } from "./types.ts";
import { pageCss, Root } from "./view/shell.tsx";

export { keyId };

/** Платформа по navigator: iPhone/iPad, запущено ли с экрана «Домой», есть ли @scope. */
function detectPlatform(win: Window): Platform {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    ios: /iPhone|iPad|iPod/.test(nav.userAgent),
    standalone: nav.standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches,
    scope: "CSSScopeRule" in win,
  };
}

/** Запустить приложение: гейт → пропуск → модули → связь. */
export function startApp(o: StartOptions): Running {
  const win = o.window ?? window;
  const store = o.store ?? idbStore();
  const wide = !!o.wide;

  const snap = createSnapshot(pageCss([]));
  const modules = createModules(snap.changed);
  const sections = createSections(modules, { wide, order: o.sections });
  const address = createAddress({ win, wide, beside: o.beside, modules, sections, snap });
  const halt = createHalt({ o, snap, store, win });
  const link = createFleetLink({ o, snap, modules, route: address.route, refused: halt.refused });
  const leave = createLeave({ modules, link, snap });

  const fell = (where: string, e: unknown) => {
    console.error(`switchboard: ${where}`, e);
    o.root.textContent = `Приложение упало: ${e instanceof Error ? e.message : String(e)}`;
  };

  // каркас страницы встаёт сразу: экран старта виден до ответа хранилища
  const view = createRoot(o.root, { onUncaughtError: (e) => fell("вид ядра упал", e) });
  flushSync(() => view.render(<Root core={{ wide, brand: o.brand, win, snap, modules, sections, address, link, halt }} />));

  const ready = enter({
    o,
    snap,
    store,
    win,
    platform: o.platform ?? detectPlatform(win),
    modules,
    address,
    link,
    leave,
    halt,
    define: () => modules.define(o.parts, (x) => moduleApp(x, { o, store, snap, modules, address, link })),
  }).catch((e) => {
    view.unmount();
    fell("вход не удался", e);
  });

  return {
    ready,
    get stopped() {
      return snap.get().full?.why ?? null;
    },
    get failed() {
      return Object.fromEntries(modules.list.filter((x) => x.failed).map((x) => [x.m.name, x.failed!]));
    },
    hide: leave.hide,
    show: leave.show,
    unmount: () => view.unmount(),
  };
}
