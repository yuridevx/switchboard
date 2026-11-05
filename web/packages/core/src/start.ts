// Запуск приложения: гейт набора → пропуск → start модулей → связь → экран из адреса; уход и возвращение страницы.
import { createElement } from "react";
import { withLimit } from "@switchboard/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UI_CSS } from "@switchboard/web-ui";
import { appOf, type Core } from "./app.ts";
import { appGate } from "./gate.ts";
import { createLink } from "./link.ts";
import { createModules } from "./modules.ts";
import { createPage } from "./page.ts";
import { createPass } from "./pass.ts";
import { createRoute } from "./route.ts";
import type { Running, StartOptions } from "./types.ts";
import { Shell } from "./view/shell.tsx";
import css from "./view/shell.css";

const LIMIT_MS = 30_000;
const TOAST_MS = 6_000;

const warnAfter = (word: string) => () => console.warn(`switchboard: ${word} за 30 с`);

export function startApp(o: StartOptions): Running {
  const page = createPage(o);
  const { win } = page;
  const doc = win.document;
  const mods = createModules(page);
  const route = createRoute(page, mods);
  const root = createRoot(o.root);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Страница стоит с причиной; связь закрыта. */
  function stop(word: string, invite?: boolean) {
    page.stop = { word, invite };
    core.link.drop("stopped", "stopped");
    page.changed();
  }

  function fatal(e: unknown) {
    page.stop = { word: "crash" };
    core.link.drop("stopped", "stopped");
    root.unmount();
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

  /** Что идёт: null — страница на экране; иначе — уход, его ждёт возвращение. */
  let leaving: Promise<void> | null = null;

  async function leave() {
    const say = async () => {
      await core.link.drain();
      for (const m of [...mods.list].reverse()) await mods.call(m, "остановке", () => m.def.stop?.());
      await core.link.drain();
    };
    await withLimit(say(), LIMIT_MS, warnAfter("прощание модулей не успело"));
    core.link.drop("hidden");
  }

  const hide = () => (leaving ??= leave());

  async function show() {
    if (!leaving) return;
    await leaving;
    leaving = null;
    if (page.stop || !page.key) return;
    const greet = async () => void (await Promise.all(mods.list.map((m) => mods.call(m, "возвращении", () => m.def.on?.show?.()))));
    await withLimit(greet(), LIMIT_MS, warnAfter("возвращение модулей не успело"));
    core.link.back();
  }

  const onVisible = () => void (doc.visibilityState === "hidden" ? hide() : show());
  const onLeave = () => void hide();

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
    const started = (async () => {
      for (const m of mods.list) await mods.call(m, "старте", () => m.def.start?.());
    })();
    await withLimit(started, LIMIT_MS, warnAfter("модули не запустились"));
    if (doc.visibilityState === "hidden") leaving = Promise.resolve();
    else core.link.back();
  }

  flushSync(() => root.render(createElement(Shell, { core, pass, css: UI_CSS + css, fatal: (e: unknown) => void Promise.resolve().then(() => fatal(e)) })));

  const unlisten = route.listen();
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("pagehide", onLeave);
  const ready = boot().catch(fatal);

  return {
    ready,
    get stopped() {
      return page.stop?.word ?? null;
    },
    failed: page.failed,
    hide,
    show,
    unmount() {
      unlisten();
      doc.removeEventListener("visibilitychange", onVisible);
      win.removeEventListener("pagehide", onLeave);
      clearTimeout(toastTimer);
      core.link.drop("unmount");
      if (!page.stop || page.stop.word !== "crash") root.unmount();
    },
  };
}
