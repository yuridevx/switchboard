// Леса границы «оболочка приложения», сторона телефона: состав, разделы, статика и сквозные флоу узкого вида.
// Вход — файл сборки, кадры relay и служебный обработчик, исход — страница, кадры и файлы. Номер — эталон-источник; без номера — чьё: код.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepo, order } from "@switchboard/manifest-gate";
import { serviceWorker } from "@switchboard/web-alerts";
import { appGate, idbStore, memoryStore } from "@switchboard/web-core";
import { manifest as uiM } from "@switchboard/web-ui";
import { manifest as viewM } from "@switchboard/web-view";
import { fakeBrowser, fakeScope } from "../../packages/alerts/stand/fakes.ts";
import { defined, FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
import { phoneParts } from "../stand/parts.ts";

vi.setConfig({ testTimeout: 20_000 });

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(app, "../..");

/** relay флота home: лента и вопросы отвечают как Host. */
function homeRelay(roster = homeRoster()) {
  const relay = new FakeRelay(roster);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  return relay;
}

const send = async (t: Awaited<ReturnType<typeof stand>>, text: string) => {
  const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
  inp.value = text;
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  await t.click(t.$(".chat-send"));
};

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

describe("состав и старт", () => {
  it("5139 · модули стенда телефона — те же, что в into телефона; набор проходит гейт ядра", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — единственная запись состава
    const want = loadRepo(root).filter((m) => m.into?.includes("phone") && !["web-core", "web-view", "web-ui"].includes(m.name));
    expect(phoneParts().map((p) => p.manifest.name).sort()).toEqual(want.map((m) => m.name).sort());
    expect(want.length).toBe(13);
    expect(appGate(defined(phoneParts()))).toEqual([]);
  });

  it("4001 · оболочка телефона по build.json: hello на каждую машину, домашний раздел «Вам», свои разделы, узкий вид", async () => {
    const relay = homeRelay();
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

describe("сквозные флоу", () => {
  it("22 · пуш при закрытом приложении: уведомление с полным текстом, нажатие — переписка из уведомления, ответ — session.prompt", async () => {
    const store = memoryStore({ key: KEY });
    const scope = fakeScope();
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2 });
    const text = "Эталоны: 13 из 13. Катить в основную?";
    await scope.fire("push", { data: { json: () => ({ type: "message", from: "poe-bot@pc", notify: { title: "poe-bot@pc", body: text, tag: "m-91" } }) } });
    expect(scope.shown[0]).toMatchObject({ title: "poe-bot@pc", o: { body: text } });
    await scope.fire("notificationclick", { action: "", notification: { data: scope.shown[0].o.data, close: () => {} } });
    expect(scope.opened).toHaveLength(1);
    // окно открылось: приложение стартует с тем же хранилищем
    const relay = homeRelay();
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    const t = await stand(phoneParts(fakeBrowser("granted")), { relay, store });
    expect(t.$(".sb-bt b")!.textContent).toBe("poe-bot");
    expect(t.$(".chat-in")!.textContent).toContain(text);
    expect(t.$(".chat-tag")!.textContent).toBe("из уведомления");
    await send(t, "Катим");
    expect(relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", text: "Катим" })]);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });

  it("107 · уход на домашний экран: ждущий reply дошёл, модули дописали разделы, лента снята, close(1000)", async () => {
    const relay = homeRelay();
    relay.handlers["session.prompt"] = () => undefined;
    const store = memoryStore({ key: KEY });
    const t = await stand(phoneParts(fakeBrowser()), { relay, store, url: "/#sessions" });
    await t.click(t.$('[data-fid="all"]'));
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await send(t, "Задеплой на стенд");
    const draft = t.$<HTMLTextAreaElement>(".chat-inp")!;
    draft.value = "и потом";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    const before = relay.got.length;
    const hiding = t.run.hide();
    await flush();
    expect(relay.socks[0].closedWith).toBeNull();
    relay.reply(relay.sent("session.prompt")[0].id!, { ok: true });
    await hiding;
    expect(relay.got.slice(before).map((f) => f.type)).toEqual(["session.unwatch"]);
    expect(store.data.drafts).toEqual({ "site@laptop": "и потом" });
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    // сессия занята: reply дошёл — сообщение в очереди (эталон 7023)
    expect(t.$(".chat-me small")!.textContent).toBe("в очереди");
  });
});

describe("статика", () => {
  it("4185 · dist: app.js, sw.js, статика и значки; адресов relay и Worker'ов, модулей и ключа флота нет; значки те же", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адресов relay в коде оболочек 0
    const dist = join(app, "dist");
    // чьё: код; в архив каталога идёт вся папка: сборка начинает с чистой
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "stale.js"), "");
    const r = spawnSync(process.execPath, [join(app, "build.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(dist).sort()).toEqual(["app.js", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "index.html", "manifest.webmanifest", "sw.js"]);
    for (const f of ["app.js", "sw.js", "index.html"]) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
    }
    expect(readFileSync(join(dist, "app.js"), "utf8")).not.toContain("Новая сессия");
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('<script src="app.js" defer></script>');
    for (const f of ["index.html", "manifest.webmanifest"]) expect(readFileSync(join(dist, f), "utf8")).toBe(readFileSync(join(app, "public", f), "utf8"));
    const png = (f: string) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex").slice(0, 16);
    expect(["icon-192.png", "icon-512.png", "apple-touch-icon.png"].map(png)).toEqual(ICONS);
    expect(r.stdout).toContain("phone: dist/ собран — оболочка без модулей и адресов");
  }, 60_000);
});

const ICONS = ["5c52146e1da8e8f2", "fcb1346571a28910", "10c5d6b0c4d007a1"];
