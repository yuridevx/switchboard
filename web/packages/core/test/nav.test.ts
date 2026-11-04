// Разделы страницы по прототипу «Пульт и телефон» (подписан пользователем 2 нояб.: «основа дизайна ок»):
// группа «Флот», поиск Ctrl K в широком виде и кнопкой в шапке на телефоне, вкладки внизу в узком.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, startApp, type AppModule, type AppPart, type Manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY } from "../stand/relay.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

const man = (name: string, provides: Record<string, number>): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2 } });

/** Работа с поиском и кнопкой шапки; два раздела группы «Флот». */
let added = 0;
function parts(): AppPart[] {
  const work: AppModule = {
    screens: {
      work: {
        nav: "Работа",
        find: (q) => ["refactor@win", "api@wsl"].filter((c) => c.includes(q)).map((c) => ({ label: c, hint: "сессия", dot: "busy", screen: "work", params: { callsign: c } })),
        view: ({ params: p }) => `работа ${p.callsign ?? "все"}`,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => (added++, undefined) } }),
      },
    },
  };
  const fleet: AppModule = {
    screens: {
      machines: { nav: "Машины", group: "Флот", view: () => "машины" },
      access: { nav: "Аккаунты", group: "Флот", view: () => "аккаунты" },
    },
  };
  return [
    { manifest: man("w", { work: 1 }), module: () => work },
    { manifest: man("f", { machines: 1, access: 1 }), module: () => fleet },
  ];
}

async function run(wide: boolean) {
  const relay = new FakeRelay(homeRoster());
  const r = startApp({
    root: document.getElementById("app")!,
    workers: FakeRelay.WORKERS,
    fetch: relay.fetch,
    parts: parts(),
    wide,
    sections: ["work", "machines", "access"],
    store: memoryStore({ key: KEY }),
    WebSocket: relay.WebSocket,
    platform: { ios: false, standalone: false },
    pauseMs: 5,
  });
  await r.ready;
  await flush();
  return r;
}
const texts = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((b) => b.textContent);

describe("разделы страницы", () => {
  it("5170 · широкий вид: раздел и группа «Флот» с подписью; подпунктов под разделом нет, кнопки шапки нет", async () => {
    await run(true);
    expect(texts(".sb-navcol .sb-nv")).toEqual(["Работа", "Машины", "Аккаунты"]);
    expect(texts(".sb-navcol .sb-grp")).toEqual(["Флот"]);
    // машин и имени устройства в колонке больше нет
    expect(document.querySelector(".sb-nm, .sb-me, .sb-ncap")).toBeNull();
    expect(document.querySelector("[data-find], [data-new]")).toBeNull();
    [...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")][1].click();
    await flush();
    expect(location.hash).toBe("#machines");
    expect(document.querySelector('.sb-navcol .sb-nv[aria-current="page"]')!.textContent).toBe("Машины");
  });

  it("5173 · узкий вид: в шапке раздела — поиск и кнопка раздела; поиск открывает тот же Ctrl K; кнопка зовёт действие раздела", async () => {
    added = 0;
    await run(false);
    document.querySelector<HTMLElement>("[data-find]")!.click();
    await flush();
    expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(false);
    document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    document.querySelector<HTMLElement>("[data-new]")!.click();
    expect(added).toBe(1);
  });

  it("5171 · Ctrl K: разделы и строки find экранов; Enter открывает первую; Esc закрывает", async () => {
    await run(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
    expect(input).not.toBeNull();
    // поиск открылся — ввод сразу в поле
    expect(document.activeElement).toBe(input);
    expect(texts(".sb-palit .l")).toEqual(["Работа", "refactor@win", "api@wsl", "Машины", "Аккаунты"]);
    input.value = "api";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(texts(".sb-palit .l")).toEqual(["api@wsl"]);
    document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(location.hash).toBe("#work?callsign=api%40wsl");
    expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(true);
    document.querySelector<HTMLElement>(".sb-goto")!.click();
    await flush();
    document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(true);
  });

  it("5175 · narrowGroup: в широком виде раздел отдельно, в узком — в группе («Инциденты» во «Флоте» телефона)", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): телефон — Вам, Работа, Флот (аккаунты, машины, инциденты, настройки)
    const relay = new FakeRelay(homeRoster());
    const mods = (): AppPart[] => [
      ...parts(),
      { manifest: man("i", { incidents: 1 }), module: () => ({ screens: { incidents: { nav: "Инциденты", narrowGroup: "Флот", view: () => "инциденты" } } }) },
    ];
    const start = (wide: boolean) =>
      startApp({ root: document.getElementById("app")!, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: mods(), wide, sections: ["work", "incidents", "machines", "access"], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    await start(true).ready;
    await flush();
    expect(texts(".sb-navcol .sb-nv:not(.sub)")).toEqual(["Работа", "Инциденты", "Машины", "Аккаунты"]);
    document.body.innerHTML = '<div id="app"></div>';
    await start(false).ready;
    await flush();
    expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
    location.hash = "#incidents";
    await flush();
    expect(texts(".sb-navrow .sb-nv")).toEqual(["Инциденты", "Машины", "Аккаунты"]);
  });

  it("5174 · beside списком: карточка открыта от «Вам» — слева «Вам», от «Работы» — «Работа»; поиск ведёт и на экран из uses", async () => {
    const relay = new FakeRelay(homeRoster());
    const lists: AppModule = {
      screens: {
        inbox: { nav: "Вам", find: () => [{ label: "site@laptop", screen: "card", params: { callsign: "site@laptop" } }], view: () => "вам" },
        board: { nav: "Работа", view: () => "работа" },
      },
    };
    const card: AppModule = { screens: { card: { view: ({ params: p }) => `карточка ${p.callsign}` } } };
    const r = startApp({
      root: document.getElementById("app")!,
      workers: FakeRelay.WORKERS,
      fetch: relay.fetch,
      parts: [
        { manifest: { ...man("l", { inbox: 1, board: 1 }), uses: { "app@web-core": 2, "card@c": 1 } }, module: () => lists },
        { manifest: man("c", { card: 1 }), module: () => card },
      ],
      wide: true,
      beside: { card: ["board", "inbox"] },
      store: memoryStore({ key: KEY }),
      WebSocket: relay.WebSocket,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
    });
    await r.ready;
    await flush();
    location.hash = "#inbox";
    await flush();
    location.hash = "#card?callsign=site%40laptop";
    await flush();
    expect(document.querySelector(".sb-master")!.getAttribute("data-screen")).toBe("inbox");
    location.hash = "#board";
    await flush();
    location.hash = "#card?callsign=site%40laptop";
    await flush();
    expect(document.querySelector(".sb-master")!.getAttribute("data-screen")).toBe("board");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    expect(texts(".sb-palit .l")).toContain("site@laptop");
  });

  it("5172 · узкий вид: вкладки внизу — разделы без группы и одна вкладка группы; открыт раздел группы — его соседи лентой над экраном", async () => {
    await run(false);
    expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
    expect(document.querySelector<HTMLElement>(".sb-navrow")!.hidden).toBe(true);
    document.querySelector<HTMLElement>('.sb-tabs [data-group="Флот"]')!.click();
    await flush();
    expect(location.hash).toBe("#machines");
    expect(texts(".sb-navrow .sb-nv")).toEqual(["Машины", "Аккаунты"]);
    expect(document.querySelector('.sb-tabs [data-group="Флот"]')!.getAttribute("aria-current")).toBe("page");
  });
});
