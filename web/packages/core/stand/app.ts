// Стенд: приложение на странице happy-dom с поддельным relay и хранилищем в памяти.
import type { Roster } from "@switchboard/relay";
import { memoryStore, startApp, type AppPart, type StartOptions } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY } from "./relay.ts";

export type StandOptions = {
  roster?: Roster;
  relay?: FakeRelay;
  store?: ReturnType<typeof memoryStore>;
  /** адрес страницы до старта: "/#client.phone…" */
  url?: string;
  ios?: boolean;
  standalone?: boolean;
  wide?: boolean;
  pauseMs?: number;
  /** прочие опции запуска приложения (beside, brand) */
  options?: Partial<StartOptions>;
};

/** Поднять приложение на стенде: страница, relay, хранилище; дождаться первого roster. */
export async function stand(parts: AppPart[], o: StandOptions = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById("app")!;
  history.replaceState(null, "", o.url ?? "/");
  const relay = o.relay ?? new FakeRelay(o.roster ?? homeRoster());
  const store = o.store ?? memoryStore({ key: KEY });
  const run = startApp({
    root,
    relayUrl: "wss://relay.test",
    parts,
    store,
    WebSocket: relay.WebSocket,
    platform: { ios: !!o.ios, standalone: !!o.standalone },
    pauseMs: o.pauseMs ?? 5,
    wide: o.wide,
    ...o.options,
  });
  await run.ready;
  await flush();
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  /** нажать элемент и дать отработать обещаниям */
  const click = async (el: Element | null) => {
    if (!el) throw new Error("стенд: нечего нажимать");
    (el as HTMLElement).click();
    await flush();
  };
  /** кнопка по тексту */
  const button = (text: string | RegExp) =>
    $$<HTMLButtonElement>("button").find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) ?? null;
  return { root, relay, store, run, $, $$, click, button, text: () => root.querySelector(".sb-main")?.textContent ?? "" };
}

export { FakeRelay, flush, homeRoster, KEY };
