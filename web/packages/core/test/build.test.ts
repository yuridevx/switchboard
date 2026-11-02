// Старт сборки страницы по build.json: модули по списку, адреса — из списка; модуль не загрузился — выключен он один.
// Порядок разделов — у оболочки.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, startApp, startBuild, type AppModule, type AppPart, type BuildList, type Manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY } from "../stand/relay.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

const man = (name: string, provides: Record<string, number>): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 1 } });
const screenMod = (name: string, nav: string): AppModule => ({ screens: { [name]: { nav, label: nav, mount: (el) => void (el.textContent = nav) } } });

describe("сборка страницы", () => {
  it("5134 · startBuild: модули по списку сборки (ядро — само), relay и Worker'ы — из build.json; модуль не загрузился — выключен только он", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адреса relay и Worker'ов страница берёт из
    // списка сборки; модуль не загрузился — выключен только он, остальные работают
    const relay = new FakeRelay(homeRoster());
    const urls: string[] = [];
    const WS = relay.WebSocket;
    const build: BuildList = {
      app: "phone",
      version: "1.1.0+2",
      fleet: "test",
      modules: [
        { name: "web-core", version: "1.1.0" },
        { name: "list", version: "1.0.0" },
        { name: "broken", version: "2.0.0" },
      ],
      // адрес relay — в той же карте Worker'ов: объекты машин — wss того же адреса
      workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" },
    };
    const asked: string[] = [];
    const run = await startBuild({
      root: document.getElementById("app")!,
      build,
      load: async (name) => {
        asked.push(name);
        if (name === "broken") throw new Error("404 m/broken.js");
        return { manifest: man("list", { list: 1 }), default: screenMod("list", "Список") };
      },
      fetch: relay.fetch,
      store: memoryStore({ key: KEY }),
      WebSocket: class extends (WS as unknown as new (u: string) => object) {
        constructor(u: string) {
          urls.push(u);
          super(u);
        }
      } as never,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
    });
    await run.ready;
    await flush();
    expect(asked).toEqual(["list", "broken"]);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
    expect(Object.keys(run.failed)).toEqual(["broken"]);
    expect(run.failed.broken).toContain("импорт: 404 m/broken.js");
    expect(run.stopped).toBeNull();
    expect(document.querySelector(".sb-main")!.textContent).toContain("Список");
  });

  it("5135 · порядок разделов — у оболочки: sections первыми, остальные — следом по списку модулей; домашний — первый", async () => {
    // источник: дизайн «Открытый флот»: «beside и порядок разделов — у оболочки; разделы, которых в ней нет, встают следом»
    const parts: AppPart[] = [
      { manifest: man("a", { a: 1 }), module: screenMod("a", "А") },
      { manifest: man("b", { b: 1 }), module: screenMod("b", "Б") },
      { manifest: man("c", { c: 1 }), module: screenMod("c", "В") },
      { manifest: man("d", { d: 1 }), module: screenMod("d", "Г") },
    ];
    const relay = new FakeRelay(homeRoster());
    const run = startApp({
      root: document.getElementById("app")!,
      workers: FakeRelay.WORKERS,
      fetch: relay.fetch,
      parts,
      wide: true,
      sections: ["c", "a"],
      store: memoryStore({ key: KEY }),
      WebSocket: relay.WebSocket,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
    });
    await run.ready;
    await flush();
    expect([...document.querySelectorAll<HTMLElement>(".sb-navcol button")].map((b) => b.dataset.screen)).toEqual(["c", "a", "b", "d"]);
    expect(document.querySelector('.sb-navcol button[aria-current="page"]')!.getAttribute("data-screen")).toBe("c");
  });
});
