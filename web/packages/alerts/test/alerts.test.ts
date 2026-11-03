// web-alerts: полоса «Включить уведомления», пуши из раздела pushes и служебный обработчик.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore } from "@switchboard/web-core";
import { b64url, createAlerts, manifest as alertsM, serviceWorker, type BrowserPush } from "../contract.ts";
import { createAlertsStore, READY_MS } from "../src/store.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";
import { fakeBrowser, fakeScope } from "../stand/fakes.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const parts = (browser: BrowserPush) => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts(browser) },
];

describe("полоса «Включить уведомления»", () => {
  it("разрешение по нажатию → push.key → подписка этим ключом → push.subscribe → полосы нет", async () => {
    const br = fakeBrowser();
    const relay = new FakeRelay(homeRoster());
    const key = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9";
    relay.handlers["push.key"] = () => ({ ok: true, result: { key } });
    relay.handlers["push.subscribe"] = () => ({ ok: true });
    const t = await stand(parts(br), { relay });
    expect(br.calls).toEqual(["register sw.js"]);
    expect(t.$(".al-card")!.textContent).toBe("Включить уведомленияСессии достучатся, когда приложение закрыто.Включить");
    await t.click(t.button("Включить"));
    expect(br.calls).toEqual(["register sw.js", "requestPermission", `subscribe ${b64url(key).length}`]);
    expect(relay.sent("push.key")[0]).toMatchObject({ v: 1, to: ".push" });
    expect(relay.sent("push.subscribe")[0]).toMatchObject({ v: 1, to: ".push", sub: { endpoint: "https://web.push.apple.com/QF3" } });
    expect(t.$(".al-card")).toBeNull();
    expect(t.$(".sb-toast")!.textContent).toBe("Уведомления включены: сессии достучатся, когда приложение закрыто.");
    // новая машина в roster: машинам подписка не уходит, в хранилище страницы подписки нет
    const r = homeRoster();
    r.machines.push({ machine: "mac", since: 2, proto: 1, contract: r.machines[0].contract });
    relay.setRoster(r);
    await flush();
    expect(relay.got.filter((f) => f.to === ".push").map((f) => f.type)).toEqual(["push.key", "push.subscribe"]);
    expect(relay.got.filter((f) => f.to !== ".push").every((f) => !f.type.startsWith("push") && !("sub" in f))).toBe(true);
    expect(JSON.stringify(t.store.data)).not.toContain("endpoint");
  });

  it("отказ push.key — «Не вышло: слово», кнопка «Ещё раз»", async () => {
    const br = fakeBrowser();
    const relay = new FakeRelay(homeRoster());
    relay.handlers["push.key"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(br), { relay });
    await t.click(t.button("Включить"));
    expect(t.$(".al-card")!.textContent).toBe("Включить уведомленияНе вышло: offlineЕщё раз");
  });

  it("пуши из раздела pushes — владельцу кадра при старте; нажатый — открывает свой экран", async () => {
    const store = memoryStore({
      key: KEY,
      pushes: [{ id: "p1", type: "message", from: "poe-bot@pc", notify: { title: "poe-bot@pc", body: "Эталоны: 13 из 13. Катить в основную?" }, at: 1, clicked: true }],
    });
    const relay = new FakeRelay(homeRoster());
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const t = await stand(parts(fakeBrowser("granted")), { store, relay });
    expect(store.data.pushes).toEqual([]);
    expect(location.hash).toBe("#chat?callsign=poe-bot%40pc");
    expect(t.$(".chat-in")!.textContent).toContain("из уведомления");
  });
});

const pushData = (notify: unknown) => ({ data: { json: () => ({ type: "question", from: "profiles@laptop", notify }) } });
const notify = (n: number) => ({
  title: "profiles@laptop спрашивает",
  body: "Какую базу мигрировать первой?",
  tag: "toolu_01Hx",
  actions: ["прод", "стенд", "e2e"].slice(0, n).map((v) => ({
    title: v,
    frame: { type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": v } },
  })),
});

describe("служебный обработчик", () => {
  it("пуш: notify на экран и в pushes; кнопки — только если все помещаются", async () => {
    const scope = fakeScope();
    const store = memoryStore({ key: KEY });
    let max = 2;
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => max });
    await scope.fire("push", pushData(notify(2)));
    expect(scope.shown[0].title).toBe("profiles@laptop спрашивает");
    expect(scope.shown[0].o).toMatchObject({ body: "Какую базу мигрировать первой?", tag: "toolu_01Hx", actions: [{ action: "0", title: "прод" }, { action: "1", title: "стенд" }] });
    expect((store.data.pushes as unknown[])).toHaveLength(1);
    await scope.fire("push", pushData(notify(3)));
    expect(scope.shown[1].o.actions).toEqual([]);
    max = 0; // Safari
    await scope.fire("push", pushData(notify(2)));
    expect(scope.shown[2].o.actions).toEqual([]);
  });

  it("нажатие без кнопки: пуш помечен нажатым, окно открыто; открытое окно — фокус и «pushes»", async () => {
    const scope = fakeScope();
    const store = memoryStore({ key: KEY });
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2 });
    await scope.fire("push", pushData(notify(2)));
    const close = vi.fn();
    await scope.fire("notificationclick", { action: "", notification: { data: scope.shown[0].o.data, close } });
    expect(close).toHaveBeenCalled();
    expect((store.data.pushes as Array<{ clicked?: boolean }>)[0].clicked).toBe(true);
    expect(scope.opened).toEqual(["https://switchboard-phone.test/"]);
    scope.setWins(1);
    await scope.fire("notificationclick", { action: "", notification: { data: scope.shown[0].o.data, close } });
    expect(scope.focused).toEqual(["post pushes", "focus"]);
  });

  it("5136 · адрес relay — из списка сборки: обработчик ждёт обещание build.json и отвечает через relay машины по нему", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): обработчик пушей — из списка сборки, своего адреса нет
    const scope = fakeScope();
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => ({ ok: true });
    const store = memoryStore({ key: KEY });
    let give!: (u: string) => void;
    const relayUrl = new Promise<string>((r) => (give = r));
    serviceWorker(scope, { relayUrl, store, maxActions: () => 2, WebSocket: relay.WebSocket as never });
    await scope.fire("push", pushData(notify(2)));
    const click = scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
    await flush();
    expect(relay.socks).toHaveLength(0);
    give("wss://relay.from-build/");
    await click;
    await flush();
    expect(relay.socks.map((s) => s.url)).toEqual(["wss://relay.from-build/m/laptop"]);
    expect(relay.got.map((f) => f.type)).toContain("answer");
  });

  it("кнопка: отказ relay — уведомление «Ответ не отправлен: слово»", async () => {
    const scope = fakeScope();
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => ({ ok: false, error: "already_answered" });
    const store = memoryStore({ key: KEY });
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2, WebSocket: relay.WebSocket as never });
    await scope.fire("push", pushData(notify(2)));
    await scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
    await flush();
    expect(scope.shown[1].title).toBe("Ответ не отправлен: already_answered");
    expect(scope.shown[1].o.tag).toBe("toolu_01Hx");
    expect(scope.opened).toEqual([]);
  });
});

describe("предел обработчика пушей", () => {
  it("6901 · обработчик не поднялся: «включаю» не остаётся навсегда — отказ словом; подписки нет", async () => {
    vi.useFakeTimers();
    const fails = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const browser: BrowserPush = {
      sw: { register: async () => undefined, ready: new Promise(() => {}), addEventListener: () => {} },
      Notification: { permission: "default", requestPermission: async () => "granted" },
    };
    const store = createAlertsStore(browser);
    const app = {
      changed: () => {},
      store: () => ({ update: async () => [] }),
      deliver: () => {},
      toast: (x: string) => calls.push(x),
      request: async (name: string) => {
        calls.push(name);
        return { ok: true, result: { key: "AAAA" } };
      },
    };
    await store.start(app as never);
    const done = store.enable();
    await vi.advanceTimersByTimeAsync(READY_MS - 1);
    expect(store.state()).toBe("working");
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(store.state()).toBe("error");
    expect(store.error()).toBe("обработчик пушей не поднялся");
    expect(calls).toEqual(["push.key"]);
    fails.mockRestore();
    vi.useRealTimers();
  });
});
