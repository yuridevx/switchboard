// Леса границы «оболочка приложения», сторона телефона: старт по списку сборки. Общее обоих приложений — в тестах пульта.
// Вход — файл сборки, исход — страница и кадры. Номер — эталон-источник.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepo, order } from "@switchboard/manifest-gate";
import { idbStore } from "@switchboard/web-core";
import { manifest as uiM } from "@switchboard/web-ui";
import { manifest as viewM } from "@switchboard/web-view";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";
import { FakeRelay, flush, homeRoster, KEY } from "../../packages/core/stand/app.ts";
import { phoneParts } from "../stand/parts.ts";

vi.setConfig({ testTimeout: 20_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("старт", () => {
  it("4001 · оболочка телефона по build.json: hello на каждую машину, домашний раздел «Вам», свои разделы, узкий вид", async () => {
    const relay = new FakeRelay(homeRoster());
    vi.stubGlobal("indexedDB", new IDBFactory());
    await idbStore().set("key", KEY);
    const mods = order(loadRepo(root).filter((m) => m.into?.includes("phone")));
    const list = { app: "phone", version: "1.0.0+1", fleet: "test", modules: mods.map((m) => ({ name: m.name, version: m.version })), workers: FakeRelay.WORKERS };
    vi.stubGlobal("fetch", async (u: string, o?: RequestInit) => (u === "./build.json" ? { json: async () => list } : relay.fetch(u, o)));
    vi.stubGlobal("WebSocket", relay.WebSocket);
    // загрузчик вместо import map браузера: те же модули, настоящая оболочка и настоящий старт сборки
    const set = [...phoneParts(fakeBrowser()), { manifest: viewM, module: () => ({}) }, { manifest: uiM, module: () => ({}) }];
    const load = async (name: string) => {
      const p = set.find((x) => x.manifest.name === name)!;
      return { default: p.module, manifest: p.manifest };
    };
    vi.doMock("../../shell.ts", async (real) => {
      const { boot } = (await real()) as typeof import("../../shell.ts");
      return { boot: (o: object) => boot({ ...o, load } as never) };
    });
    await import("../src/main.ts");
    await vi.waitFor(() => expect(document.querySelector(".sb-bt b")?.textContent, document.body.textContent ?? "").toBe("Вам"), { timeout: 15_000 });
    await flush();
    expect(relay.hellos).toHaveLength(2);
    expect(document.querySelector<HTMLElement>(".sb-navcol")!.hidden).toBe(true);
    expect([...document.querySelectorAll<HTMLElement>(".sb-nv")].map((b) => b.dataset.screen)).toEqual(["inbox", "board", undefined]);
    expect(document.body.textContent).toContain("Флот");
    // вкладка «Флот»: разделы в порядке оболочки, журнала и точек на телефоне нет
    location.hash = "#accounts";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush(10);
    expect([...document.querySelectorAll<HTMLElement>(".sb-nv")].map((b) => b.dataset.screen)).toEqual(["accounts", "profiles", "incidents", "settings", "inbox", "board", undefined]);
  });
});
