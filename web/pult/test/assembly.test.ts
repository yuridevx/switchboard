// Пульт из архивов каталога: упаковка модулей и оболочки монорепо, раскладка сборки (как у «Выпусков»), старт страницы
// по build.json. import map браузера на стенде заменяет node_modules сборки: «@switchboard/<модуль>» → тот же файл m/.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check, loadRepo, order } from "@switchboard/manifest-gate";
import { webBuild, type BuildList } from "@switchboard/release";
import type { BuildOptions } from "@switchboard/web-core";
import { packFromRepo as packModule } from "../../../tools/release-cli/src/module.ts";
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
    const list: BuildList = {
      app: "pult",
      version: `${shell.version}+1`,
      fleet: "test",
      modules: packed.map((p) => ({ name: p.name, version: p.version })),
      workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" },
    };
    const files = webBuild(shell.tgz, packed, list);
    expect(files.filter((f) => f.path.startsWith("m/")).length).toBe(16);

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
    expect([...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")].map((b) => b.dataset.screen)).toEqual(["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"]);
    expect(document.querySelector(".sb-brand b")!.textContent).toBe("Пульт");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
  }, 120_000);
});

describe("состав оболочки", () => {
  it("5193 · состав приложения — только into модулей: оболочка пульта и телефона пользуется лишь ядром страницы, снять любой модуль страницы её uses не мешает", () => {
    // источник: отчёт слепого архитектора 2 нояб.: пункт 4 — состав приложения записан дважды (uses оболочки и into
    // модулей); снять модуль страницы упиралось в uses оболочки (check_failed)
    const repo = loadRepo(root).map(({ imports: _i, pkg: _p, dir: _d, ...m }) => m);
    for (const app of ["pult", "phone"]) {
      const shell = repo.find((m) => m.name === app)!;
      expect(Object.keys(shell.uses)).toEqual(["app@web-core"]);
      const set = repo.filter((m) => m.name === app || m.into?.includes(app));
      for (const gone of set.filter((m) => m.name !== app && m.name !== "web-core")) {
        expect(check(set.filter((m) => m !== gone)).filter((e) => e.startsWith(`модуль ${app}:`))).toEqual([]);
      }
    }
  });
});

// Статика оболочки пульта: dist без модулей, адресов relay и Worker'ов и ключа флота — всё это даёт список сборки.
// Здесь, а не своим файлом: dist пульта собирает и упаковка выше — два файла тестов параллельно ломали одну папку
// (CI 3 нояб.: ENOTEMPTY в rmSync сборки).
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");

describe("статика оболочки пульта", () => {
  it("4187 · dist: app.js, sw.js, статика и значки; адресов relay и Worker'ов, модулей и ключа флота нет", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адресов relay в коде оболочек 0
    const r = spawnSync(process.execPath, [join(app, "build.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(dist).sort()).toEqual(["_headers", "app.js", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "index.html", "manifest.webmanifest", "sw.js"]);
    for (const f of ["app.js", "sw.js", "index.html"]) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
    }
    // модули — в m/ сборки, а не в оболочке: экранов модулей в app.js нет
    expect(readFileSync(join(dist, "app.js"), "utf8")).not.toContain("Новая сессия");
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('<script src="app.js" defer></script>');
  }, 60_000);
});
