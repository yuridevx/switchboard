// Запуск приложения: гейт набора → пропуск → start модулей → связь → экран из адреса; уход и возвращение страницы.
import { createElement } from "react";
import { withLimit } from "@switchboard/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { appOf, type Core } from "./app.ts";
import { appGate } from "./gate.ts";
import { createLink } from "./link.ts";
import { createModules } from "./modules.ts";
import { createPage } from "./page.ts";
import { createPass } from "./pass.ts";
import { createRoute } from "./route.ts";
import type { Running, StartOptions } from "./types.ts";
import { Shell } from "./view/shell.tsx";

const STEP_MS = 30_000;
const TOAST_MS = 6_000;

const late = (word: string) => () => console.warn(`switchboard: ${word} за 30 с`);

export function startApp(o: StartOptions): Running {
  const page = createPage(o);
  const { win } = page;
  const doc = win.document;
  const mods = createModules(page);
  const route = createRoute(page, mods);
  const listening = new AbortController();
  const on = { signal: listening.signal };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Страница стоит с причиной; связь закрыта. */
  function stop(word: string, invite?: boolean) {
    console.error(`switchboard: ${word}`);
    page.stop = { word, invite };
    core.link.close("stopped", "stopped");
    page.changed();
  }

  /** Упал вид ядра или вход: граница модуля сюда не достаёт, на странице — причина. */
  function fell(e: unknown) {
    console.error("switchboard: приложение упало", e);
    page.stop = { word: "crash" };
    core.link.close("stopped", "stopped");
    o.root.textContent = `Приложение упало: ${(e as Error).message}`;
  }

  function toast(text: string, tone: "ok" | "bad" = "bad") {
    page.toast = { text, tone, shown: true };
    page.changed();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      page.toast = { ...page.toast, shown: false };
      page.changed();
    }, TOAST_MS);
  }

  const core: Core = { page, mods, route, toast, link: createLink(page, mods, route, stop, toast) };
  const pass = createPass(page, route, stop);

  /** Уход идёт или прошёл; null — страница на экране. */
  let leaving: Promise<void> | null = null;

  async function leave() {
    const farewell = async () => {
      await core.link.drain();
      await Promise.all([...mods.list].reverse().map((m) => mods.call(m, "остановке", () => m.def.stop?.())));
      await core.link.drain();
    };
    await withLimit(farewell(), STEP_MS, late("прощание модулей не успело"));
    // уход — не обрыв: вернёмся и подключимся, красной лампы и «данные на…» на возвращении нет
    core.link.close("hidden", "connecting");
  }

  const hide = () => (leaving ??= leave());

  async function show() {
    const left = leaving;
    if (!left) return;
    await left;
    // за один уход возвращаются раз: страница успела скрыться и показаться, пока уход шёл
    if (leaving !== left) return;
    leaving = null;
    if (page.stop || !page.key) return;
    const greeting = async () => void (await Promise.all(mods.list.map((m) => mods.call(m, "возвращении", () => m.def.on?.show?.()))));
    await withLimit(greeting(), STEP_MS, late("возвращение модулей не успело"));
    if (!leaving) core.link.open();
  }

  async function boot() {
    if (page.platform.scope === false) return stop("browser");
    mods.define(o.parts, (m) => appOf(m, core));
    page.errors = appGate(mods.defined());
    if (page.errors.length) return stop("gate");
    mods.order();
    page.css = mods.list.flatMap((m) => (m.def.css ? [`@scope ([data-module="${m.name}"]) to ([data-module]) {\n${m.def.css}\n}`] : [])).join("\n");
    page.changed();

    const key = await pass.enter();
    if (!key) return;
    page.key = key;
    page.changed();
    const starting = async () => {
      for (const m of mods.list) await mods.call(m, "старте", () => m.def.start?.());
    };
    await withLimit(starting(), STEP_MS, late("модули не запустились"));
    page.started = true;
    if (doc.visibilityState === "hidden") leaving = Promise.resolve();
    else core.link.open();
  }

  const root = createRoot(o.root, { onUncaughtError: fell });
  flushSync(() => root.render(createElement(Shell, { core, pass })));
  route.listen(on);
  doc.addEventListener("visibilitychange", () => void (doc.visibilityState === "hidden" ? hide() : show()), on);
  win.addEventListener("pagehide", () => void hide(), on);

  return {
    ready: boot().catch(fell),
    get stopped() {
      return page.stop?.word ?? null;
    },
    failed: page.failed,
    hide,
    show,
    unmount() {
      listening.abort();
      clearTimeout(toastTimer);
      core.link.close("unmount");
      root.unmount();
    },
  };
}
