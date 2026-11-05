// Помощники лесов ядра: манифест, модули-образцы, запуск без ожидания, клавиши и разметка.
import { useEffect } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { memoryStore, startApp, type App, type AppModule, type AppPart, type Manifest, type StartOptions } from "../contract.ts";
import { FakeRelay, KEY, oneMachine } from "../stand/relay.ts";

/** Тишина в журнале и настоящие часы после каждого теста файла. */
export function quiet() {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

export const man = (name: string, provides: Record<string, number> = {}, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, ...uses } });

/** Запуск без ожидания: тест смотрит страницу до первого roster или стоит на поддельных часах. */
export function begin(parts: AppPart[], o: { relay?: FakeRelay; store?: unknown; url?: string; options?: Partial<StartOptions> } = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", o.url ?? "/");
  const root = document.getElementById("app")!;
  const relay = o.relay ?? new FakeRelay(oneMachine());
  const store = (o.store ?? memoryStore({ key: KEY })) as ReturnType<typeof memoryStore>;
  const run = startApp({ root, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts, store, WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5, ...o.options });
  return { run, root, relay, store };
}

/** Образец: раздел list с меткой need, экран item, кадр question, запросы answer и push.key. */
export function sample(log: string[] = [], over: Partial<AppModule> = {}) {
  const box: { app: App } = { app: null as never };
  const mod: AppModule = {
    frames: {
      question(f) {
        if (f.boom) throw new TypeError("boom");
        log.push(`question ${f.from}`);
      },
    },
    on: { roster: (r) => log.push(`roster ${r.sessions.length}`), link: (s, m) => log.push(m ? `link ${s} @${m}` : `link ${s}`), show: () => void log.push("show sample") },
    screens: {
      list: {
        nav: "Сессии",
        mark: "need",
        label: "Список",
        view() {
          const n = box.app.use(() => box.app.roster()?.sessions.length);
          useEffect(() => () => void log.push("list closed"), []);
          return `список ${n}`;
        },
        head: () => ({ title: "Флот", sub: `${box.app.roster()?.machines.length} машины` }),
      },
      item: {
        label: "Карточка",
        view({ params: p }) {
          useEffect(() => () => void log.push(`item closed ${p.callsign}`), [p.callsign]);
          return `item ${p.callsign}`;
        },
        head: (p) => ({ title: p.callsign, mono: true }),
      },
    },
    marks: { need: () => (box.app.roster()?.sessions ?? []).filter((s) => s.state === "waiting").length },
    store: ["drafts"],
    start() {
      log.push("start sample");
    },
    stop() {
      log.push("stop sample");
    },
    ...over,
  };
  const part: AppPart = {
    manifest: man("sample", { list: 1, item: 1, need: 1 }, { "roster@relay": 1, "question@host-questions": 1, "answer@host-questions": 1, "push.key@push": 1 }),
    module: (a) => {
      box.app = a;
      return mod;
    },
  };
  return { part, box, mod };
}

/** Второй модуль: свой экран side; uses — экран item и метка need образца. */
export function other(log: string[] = [], over: Partial<AppModule> = {}) {
  const box: { app: App } = { app: null as never };
  const part: AppPart = {
    manifest: man("other", { side: 1 }, { "item@sample": 1, "need@sample": 1 }),
    module: (a) => ({
      screens: { side: { label: "Сбоку", view: () => "сбоку" } },
      start() {
        box.app = a;
        log.push("start other");
      },
      stop() {
        log.push("stop other");
      },
      ...over,
    }),
  };
  return { part, box };
}

/** Модуль m: раздел a, экран b. */
export function mod(over: Partial<AppModule> = {}, provides: Record<string, number> = {}, uses: Record<string, number> = {}) {
  const box: { app: App } = { app: null as never };
  const part: AppPart = {
    manifest: man("m", { a: 1, b: 1, ...provides }, uses),
    module: (a) => {
      box.app = a;
      return { screens: { a: { nav: "А", label: "А", view: () => <div data-s="a">а</div> }, b: { label: "Б", view: () => <div data-s="b">б</div> } }, ...over };
    },
  };
  return { part, box };
}

/** Ребёнок за ребёнком: тег и классы. */
export const shape = (el: Element) => [...el.children].map((c) => `${c.tagName.toLowerCase()}.${c.className.trim().replace(/ +/g, ".")}`);
export const attrs = (el: Element) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
export const texts = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((b) => b.textContent);
export const key = (over: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...over }));
export const ctrlK = () => key({ key: "k", code: "KeyK", ctrlKey: true });
/** Адрес сменили снаружи. */
export function hash(h: string) {
  history.replaceState(null, "", h);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
export const reloads = () => vi.spyOn(window.location, "reload").mockImplementation(() => {});
