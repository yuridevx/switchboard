// Пульт из архивов каталога: упаковка модулей и оболочки монорепо, раскладка сборки (как у «Выпусков»), старт страницы
// по build.json. import map браузера на стенде заменяет node_modules сборки: «@switchboard/<модуль>» → тот же файл m/.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepo, order } from "@switchboard/manifest-gate";
import { webBuild, type WebBuildList } from "@switchboard/release";
import type { BuildOptions } from "@switchboard/web-core";
import { packModule } from "../../../tools/release-cli/src/module.ts";
import { PULT } from "../src/options.ts";
import { FakeRelay, flush, KEY } from "../../packages/core/stand/relay.ts";
import { memoryStore } from "@switchboard/web-core";
import { fleetRoster } from "./stand.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("пульт из каталога", () => {
  it("5137 · оболочка и модули из архивов, раскладка сборки, старт по build.json: модули загружены, разделы оболочки, адрес relay — из списка", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» собирают пульт из каталога;
    // модули, адреса relay и Worker'ов страница берёт из списка сборки
    const repo = loadRepo(root);
    const mods = order(repo.filter((m) => m.into?.includes("pult")));
    const shell = packModule(join(root, "web/pult"));
    const packed = mods.map((m) => packModule(join(root, m.dir)));
    const list: WebBuildList = {
      app: "pult",
      version: `${shell.version}+1`,
      fleet: "test",
      modules: packed.map((p) => ({ name: p.name, version: p.version })),
      relay: "wss://relay.from-build",
      workers: FakeRelay.WORKERS,
    };
    const files = webBuild(shell.tgz, packed, list);
    expect(files.filter((f) => f.path.startsWith("m/")).length).toBe(11);

    // сборка на диске; m/<модуль>.js — пакетом @switchboard/<модуль>, как import map страницы
    const dir = mkdtempSync(join(tmpdir(), "switchboard-pult-build-"));
    for (const f of files) {
      const m = /^m\/(.+)\.js$/.exec(f.path);
      const p = m ? join(dir, "node_modules", "@switchboard", m[1]) : join(dir, ...dirname(f.path).split("/"));
      mkdirSync(p, { recursive: true });
      if (!m) writeFileSync(join(dir, ...f.path.split("/")), f.data);
      else {
        writeFileSync(join(p, "package.json"), JSON.stringify({ name: `@switchboard/${m[1]}`, type: "module", exports: "./index.js" }));
        writeFileSync(join(p, "index.js"), f.data);
      }
    }
    const at = (name: string) => pathToFileURL(join(dir, "node_modules", "@switchboard", name, "index.js")).href;
    const core = (await import(/* @vite-ignore */ at("web-core"))) as { startBuild(o: BuildOptions): Promise<{ ready: Promise<void>; failed: Record<string, string>; stopped: string | null }> };

    const relay = new FakeRelay(fleetRoster());
    const urls: string[] = [];
    const WS = relay.WebSocket as unknown as new (u: string) => object;
    const run = await core.startBuild({
      root: document.getElementById("app")!,
      build: JSON.parse(files.find((f) => f.path === "build.json")!.data.toString()),
      load: (name) => import(/* @vite-ignore */ at(name)),
      fetch: relay.fetch,
      store: memoryStore({ key: KEY }),
      WebSocket: class extends WS {
        constructor(u: string) {
          urls.push(u);
          super(u);
        }
      } as never,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
      ...PULT,
    });
    await run.ready;
    await flush();
    expect(run.stopped).toBeNull();
    expect(run.failed).toEqual({});
    expect([...document.querySelectorAll<HTMLElement>(".sb-navcol button")].map((b) => b.dataset.screen)).toEqual(["board", "open", "points", "accounts", "machines", "journal"]);
    expect(document.querySelector(".sb-brand")!.textContent).toBe("SПульт");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
  }, 120_000);
});
