// Леса границы «уведомление доходит до человека», сторона страницы. Снаружи: браузер и scope обработчика — подделки, relay и Worker'ы — поддельный relay стенда.
// Настоящее приложение на странице: вход — кнопка, пуш, нажатие; исход — экран, кадры relay, раздел pushes, журнал браузера. Номер — эталон-источник; без пометки — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore, type App } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM, serviceWorker, type BrowserPush } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";
import { fakeBrowser, fakeScope } from "../stand/fakes.ts";

/** Пределы (чьё: код): обработчик не поднялся, браузер молчит, короткое соединение кнопки. */
const READY_MS = 10_000;
const ASK_MS = 120_000;
const SEND_MS = 30_000;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const parts = (browser: BrowserPush) => [
  { manifest: boardM, module: createBoard },
  { manifest: cardM, module: createCard },
  { manifest: chatM, module: createChat },
  { manifest: askM, module: createAsk },
  { manifest: alertsM, module: createAlerts(browser) },
];

type Ui = Awaited<ReturnType<typeof stand>>;
const card = (t: Ui) => t.$(".al-card")?.textContent ?? null;
const said = () => errors.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
const KEY_B64 = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9";
/** Длина ключа в байтах: сколько браузер получил в applicationServerKey. */
const keyBytes = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)).length;

function relayWithKey() {
  const relay = new FakeRelay(homeRoster());
  relay.handlers["push.key"] = () => ({ ok: true, result: { key: KEY_B64 } });
  relay.handlers["push.subscribe"] = () => ({ ok: true });
  return relay;
}

/** Браузер, который отвечает на разрешение словом answer. */
function answering(answer: string) {
  const b = fakeBrowser("default");
  b.Notification!.requestPermission = async function () {
    b.calls.push("requestPermission");
    this.permission = answer;
    return answer;
  };
  return b;
}

/** Ядро для старта модуля без экрана. */
const coreApp = () => ({ changed() {}, toast() {}, deliver() {}, store: () => ({ update: async () => [] }) }) as unknown as App;
/** Ход платформы при поддельном setTimeout: отрисовка и обещания. */
const turn = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("объявление", () => {
  it("полоса — в месте top под именем «Уведомления»; раздел pushes", () => {
    const m = createAlerts(fakeBrowser())(coreApp());
    expect(m.screens!.alerts).toMatchObject({ place: "top", label: "Уведомления" });
    expect(m.store).toEqual(["pushes"]);
  });

  it.each<[string, () => BrowserPush, string]>([
    ["нет API", () => ({}), "off"],
    ["разрешения не спрашивали", () => fakeBrowser("default"), "ask"],
    ["запрещено", () => fakeBrowser("denied"), "denied"],
    ["разрешено, подписки нет", () => fakeBrowser("granted"), "ask"],
  ])("метка alerts.state после старта, %s", async (_n, browser, state) => {
    const m = createAlerts(browser())(coreApp());
    await m.start!();
    await flush();
    expect((m.marks as Record<string, () => string>)["alerts.state"]()).toBe(state);
  });

  it("без подделки — глобальные API браузера: без PushManager уведомлений нет; с ним спрашиваем", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: async () => "default" });
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { register: async () => undefined, ready: new Promise(() => {}), addEventListener() {} } });
    const off = createAlerts()(coreApp());
    await off.start!();
    expect((off.marks as Record<string, () => string>)["alerts.state"]()).toBe("off");
    vi.stubGlobal("PushManager", class {});
    const on = createAlerts()(coreApp());
    await on.start!();
    expect((on.marks as Record<string, () => string>)["alerts.state"]()).toBe("ask");
  });
});

describe("полоса: включение", () => {
  it("разрешение по нажатию → push.key → подписка этим ключом → push.subscribe → полосы нет, тост; машинам и в хранилище страницы подписки нет", async () => {
    const br = fakeBrowser();
    const relay = relayWithKey();
    const t = await stand(parts(br), { relay });
    expect(br.calls).toEqual(["register sw.js"]);
    expect(card(t)).toBe("Включить уведомленияВключить");
    await t.click(t.button("Включить"));
    expect(br.calls).toEqual(["register sw.js", "requestPermission", `subscribe ${keyBytes(KEY_B64)}`]);
    expect(relay.sent("push.key")[0]).toMatchObject({ v: 1, to: ".push" });
    expect(relay.sent("push.subscribe")[0]).toMatchObject({ v: 1, to: ".push", sub: { endpoint: "https://web.push.apple.com/QF3", keys: { p256dh: "BNc", auth: "tB4" } } });
    expect(t.$(".al-card")).toBeNull();
    expect(t.$(".sb-toast")!.textContent).toBe("Уведомления включены: сессии достучатся, когда приложение закрыто.");
    const r = homeRoster();
    r.machines.push({ machine: "mac", since: 2, proto: 1, contract: r.machines[0].contract });
    relay.setRoster(r);
    await flush();
    expect(relay.got.filter((f) => f.to === ".push").map((f) => f.type)).toEqual(["push.key", "push.subscribe"]);
    expect(relay.got.filter((f) => f.to !== ".push").every((f) => !f.type.startsWith("push") && !("sub" in f))).toBe(true);
    expect(JSON.stringify(t.store.data)).not.toContain("endpoint");
  });

  it("4040 · разрешение не дано: denied — «запрещены» без кнопки, default — снова «Включить»; запросов к push нет", async () => {
    const relay = new FakeRelay(homeRoster());
    const t = await stand(parts(answering("denied")), { relay });
    await t.click(t.button("Включить"));
    expect(t.$(".al-card.muted")!.textContent).toBe("Уведомления запрещеныРазрешите их в настройках браузера для этого сайта.");
    expect(t.$("button.al-on")).toBeNull();
    const relay2 = new FakeRelay(homeRoster());
    const t2 = await stand(parts(answering("default")), { relay: relay2 });
    await t2.click(t2.button("Включить"));
    expect(card(t2)).toBe("Включить уведомленияВключить");
    expect([...relay.got, ...relay2.got].filter((f) => f.type.startsWith("push"))).toEqual([]);
  });

  it.each<[string, (r: FakeRelay, b: ReturnType<typeof fakeBrowser>) => Promise<void> | void, string, number]>([
    ["6987 ключ не получен", (r) => void (r.handlers["push.key"] = () => ({ ok: false, error: "offline" })), "offline", 0],
    [
      "4041 браузер не подписал",
      async (_r, b) => {
        (await b.sw!.ready).pushManager.subscribe = async () => {
          throw new Error("AbortError: push service not available");
        };
      },
      "AbortError: push service not available",
      0,
    ],
    ["4041 push.subscribe отказал", (r) => void (r.handlers["push.subscribe"] = () => ({ ok: false, error: "bad_sub" })), "bad_sub", 1],
  ])("%s: «Не вышло: слово», «Ещё раз», причина в журнале браузера", async (_n, arrange, word, subscribes) => {
    const br = fakeBrowser();
    const relay = relayWithKey();
    await arrange(relay, br);
    const t = await stand(parts(br), { relay });
    await t.click(t.button("Включить"));
    expect(card(t)).toBe(`Включить уведомленияНе вышло: ${word}Ещё раз`);
    expect(said()).toContain(`switchboard: уведомления не включены — ${word}`);
    expect(relay.sent("push.subscribe")).toHaveLength(subscribes);
  });

  it("6988 · «Ещё раз» после сбоя: на время кнопка неактивна и показывает «…»; подписка прошла, полосы нет, тост", async () => {
    const relay = relayWithKey();
    relay.handlers["push.key"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(fakeBrowser()), { relay });
    await t.click(t.button("Включить"));
    relay.handlers["push.key"] = () => undefined;
    t.button("Ещё раз")!.click();
    await flush();
    const busy = t.$<HTMLButtonElement>(".al-on")!;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe("…");
    expect(card(t)).toBe("Включить уведомления…");
    relay.reply(relay.sent("push.key").at(-1)!.id!, { ok: true, result: { key: "AAAA" } });
    await flush(10);
    expect(t.$(".al-card")).toBeNull();
    expect(t.$(".sb-toast")!.textContent).toContain("Уведомления включены");
  });

  it("4043 · полоса по разрешению и подписке: нет API — нет; granted и подписка — нет; granted без подписки — «Включить»; denied — «запрещены»", async () => {
    expect(card(await stand(parts({})))).toBeNull();
    const sub = fakeBrowser("granted");
    await (await sub.sw!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(1) });
    expect(card(await stand(parts(sub)))).toBeNull();
    expect(card(await stand(parts(fakeBrowser("granted"))))).toContain("Включить уведомления");
    expect(card(await stand(parts(fakeBrowser("denied"))))).toContain("Уведомления запрещены");
  });

  it("браузер подписан, строки во флоте нет: полоса, нажатие подписывает заново; строка есть или запрос не прошёл — полосы нет", async () => {
    const subscribed = async () => {
      const b = fakeBrowser("granted");
      await (await b.sw!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(1) });
      return b;
    };
    const lost = relayWithKey();
    let asked: unknown;
    lost.handlers["push.subscribed"] = (f) => ((asked = f.endpoint), { ok: true, result: { subscribed: false } });
    const t = await stand(parts(await subscribed()), { relay: lost });
    await flush();
    expect(asked).toBe("https://web.push.apple.com/QF3");
    expect(card(t)).toContain("Включить уведомления");
    await t.click(t.button("Включить"));
    await flush();
    expect(lost.sent("push.subscribe")).toHaveLength(1);
    expect(card(t)).toBeNull();

    const held = relayWithKey();
    held.handlers["push.subscribed"] = () => ({ ok: true, result: { subscribed: true } });
    const on = await stand(parts(await subscribed()), { relay: held });
    await flush();
    expect(card(on)).toBeNull();

    const refused = relayWithKey();
    refused.handlers["push.subscribed"] = () => ({ ok: false, error: "push_unavailable" });
    const off = await stand(parts(await subscribed()), { relay: refused });
    await flush();
    expect(card(off)).toBeNull();
    expect(said()).toContain("push_unavailable");
  });

  it("4044 · обработчик не зарегистрирован — причина в журнале браузера, модуль работает", async () => {
    const b = fakeBrowser("default");
    b.sw!.register = async () => {
      throw new Error("SecurityError");
    };
    const t = await stand(parts(b));
    await flush();
    expect(errors).toHaveBeenCalledWith("switchboard: обработчик пушей не зарегистрирован", expect.any(Error));
    expect(t.run.failed).toEqual({});
    expect(card(t)).toContain("Включить уведомления");
  });
});

describe("пределы включения: ни одного вечного «…»", () => {
  it("7287 · браузер молчит на разрешение: кнопка снова доступна", async () => {
    const b = fakeBrowser("default");
    b.Notification!.requestPermission = () => new Promise(() => {});
    const t = await stand(parts(b));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.button("Включить")!.click();
    await turn();
    await vi.advanceTimersByTimeAsync(ASK_MS - 1);
    await turn();
    expect(t.$<HTMLButtonElement>(".al-on")!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await turn();
    expect(card(t)).toBe("Включить уведомленияВключить");
  });

  it("7287 · браузер молчит на подписку: отказ словом, push.subscribe нет", async () => {
    const b = answering("granted");
    (await b.sw!.ready).pushManager.subscribe = () => new Promise(() => {});
    const relay = relayWithKey();
    const t = await stand(parts(b), { relay });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.button("Включить")!.click();
    await turn(20);
    await vi.advanceTimersByTimeAsync(ASK_MS);
    await turn();
    expect(card(t)).toBe("Включить уведомленияНе вышло: браузер не подписал за пределЕщё раз");
    expect(relay.sent("push.subscribe")).toHaveLength(0);
  });

  it("6901 · обработчик не поднялся при включении: отказ словом, подписки нет", async () => {
    const b: BrowserPush & { Notification: { permission: string; requestPermission(): Promise<string> } } = {
      sw: { register: async () => undefined, ready: new Promise(() => {}), addEventListener: () => {} },
      Notification: { permission: "default", requestPermission: async () => "granted" },
    };
    const relay = relayWithKey();
    const t = await stand(parts(b), { relay });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.button("Включить")!.click();
    await turn(20);
    await vi.advanceTimersByTimeAsync(READY_MS - 1);
    await turn();
    expect(t.$<HTMLButtonElement>(".al-on")!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await turn();
    expect(card(t)).toBe("Включить уведомленияНе вышло: обработчик пушей не поднялсяЕщё раз");
    expect(relay.got.map((f) => f.type).filter((x) => x.startsWith("push"))).toEqual(["push.key"]);
  });

  it("6990 · старт: разрешение есть, обработчик не поднялся — старт не висит, метка ask", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = createAlerts({
      sw: { register: async () => undefined, ready: new Promise(() => {}), addEventListener: () => {} },
      Notification: { permission: "granted", requestPermission: async () => "granted" },
    })(coreApp());
    let done = false;
    void Promise.resolve(m.start!()).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(READY_MS + 1);
    await turn();
    expect(done).toBe(true);
    expect((m.marks as Record<string, () => string>)["alerts.state"]()).toBe("ask");
  });
});

describe("пуши из раздела pushes", () => {
  const session = (relay: FakeRelay) => {
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  };

  it("при старте — владельцу кадра; нажатый открывает свой экран; раздел пуст", async () => {
    const store = memoryStore({
      key: KEY,
      pushes: [{ id: "p1", type: "message", from: "poe-bot@pc", notify: { title: "poe-bot@pc", body: "Эталоны: 13 из 13. Катить в основную?" }, at: 1, clicked: true }],
    });
    const relay = new FakeRelay(homeRoster());
    session(relay);
    const t = await stand(parts(fakeBrowser("granted")), { store, relay });
    expect(store.data.pushes).toEqual([]);
    expect(location.hash).toBe("#chat?callsign=poe-bot%40pc");
    expect(t.$(".chat-in")!.textContent).toContain("из уведомления");
  });

  it("4042 · обработчик сообщил «pushes» открытому окну — пуш у владельца сразу, раздел пуст", async () => {
    const b = fakeBrowser("granted");
    const store = memoryStore({ key: KEY });
    const relay = new FakeRelay(homeRoster());
    session(relay);
    const t = await stand(parts(b), { store, relay });
    store.data.pushes = [{ id: "p1", type: "message", from: "poe-bot@pc", notify: { body: "Готово" }, at: 1, clicked: true }];
    b.post("pushes");
    await flush();
    expect(store.data.pushes).toEqual([]);
    expect(location.hash).toBe("#chat?callsign=poe-bot%40pc");
    expect(t.$(".chat-in")!.textContent).toContain("Готово");
    // чужое сообщение обработчика пушей не трогает
    store.data.pushes = [{ id: "p2", type: "message", from: "poe-bot@pc", notify: { body: "Ещё" }, at: 2 }];
    b.post("другое");
    await flush();
    expect(store.data.pushes).toHaveLength(1);
  });

  it("4045 · возвращение на экран — пуши, пришедшие в фоне, у владельцев; не нажатый экран не открывает", async () => {
    const store = memoryStore({ key: KEY });
    const relay = new FakeRelay(homeRoster());
    relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign !== "poe-bot@pc" ? [] : [{ question: "q9", kind: "ask", questions: [{ question: "Катим?", options: [{ label: "да" }, { label: "нет" }] }] }] });
    const t = await stand(parts(fakeBrowser("granted")), { store, relay });
    await t.run.hide();
    const before = location.hash;
    store.data.pushes = [{ id: "p2", type: "question", from: "poe-bot@pc", notify: { title: "poe-bot@pc спрашивает", body: "Катим?" }, at: 2 }];
    await t.run.show();
    await flush(10);
    expect(store.data.pushes).toEqual([]);
    expect(location.hash).toBe(before);
    expect(relay.sent("question.list").filter((x) => x.callsign === "poe-bot@pc")).toHaveLength(1);
    await t.expand();
    expect(t.$('[data-callsign="poe-bot@pc"]')!.textContent).toContain("Катим?");
  });
});

const notify = (n: number) => ({
  title: "profiles@laptop спрашивает",
  body: "Какую базу мигрировать первой?",
  tag: "toolu_01Hx",
  actions: ["прод", "стенд", "e2e"].slice(0, n).map((v) => ({
    title: v,
    frame: { type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": v } },
  })),
});
const pushData = (n: unknown, from: unknown = "profiles@laptop") => ({ data: { json: () => ({ type: "question", from, notify: n }) } });
const click = (scope: ReturnType<typeof fakeScope>, action = "0", at = 0) => scope.fire("notificationclick", { action, notification: { data: scope.shown[at].o.data, close: () => {} } });

function worker(o: { store?: ReturnType<typeof memoryStore>; relay?: FakeRelay; max?: () => number; url?: string | Promise<string> } = {}) {
  const scope = fakeScope();
  const store = o.store ?? memoryStore({ key: KEY });
  serviceWorker(scope, { relayUrl: o.url ?? "wss://relay.test", store, maxActions: o.max ?? (() => 2), WebSocket: o.relay?.WebSocket as never });
  return { scope, store };
}

describe("служебный обработчик: пуш", () => {
  it("установка и активация — сразу под управление", async () => {
    const { scope } = worker();
    const wait = vi.spyOn(scope, "skipWaiting");
    const claim = vi.spyOn(scope.clients, "claim");
    await scope.fire("install", {});
    await scope.fire("activate", {});
    expect(wait).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("пуш: заголовок, текст, tag и значок на экран; type, from и notify в раздел pushes; кнопки — только если все помещаются", async () => {
    let max = 2;
    const { scope, store } = worker({ max: () => max });
    await scope.fire("push", pushData(notify(2)));
    expect(scope.shown[0].title).toBe("profiles@laptop спрашивает");
    expect(scope.shown[0].o).toMatchObject({ body: "Какую базу мигрировать первой?", tag: "toolu_01Hx", icon: "icon-192.png", actions: [{ action: "0", title: "прод" }, { action: "1", title: "стенд" }] });
    const saved = store.data.pushes as Array<{ id: string; type: string; from: string; notify: unknown; at: number }>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ type: "question", from: "profiles@laptop", notify: notify(2) });
    expect(typeof saved[0].id).toBe("string");
    expect(typeof saved[0].at).toBe("number");
    await scope.fire("push", pushData(notify(3)));
    expect(scope.shown[1].o.actions).toEqual([]);
    max = 0; // Safari
    await scope.fire("push", pushData(notify(2)));
    expect(scope.shown[2].o.actions).toEqual([]);
    max = 2;
    await scope.fire("push", pushData({ ...notify(1), actions: [{ title: "открыть" }] }));
    expect(scope.shown[3].o.actions).toEqual([]);
  });

  it.each<[string, unknown, unknown, string]>([
    ["без title — from", { body: "b" }, "site@pc", "site@pc"],
    ["без title и from — Switchboard", {}, null, "Switchboard"],
    ["from не строка — Switchboard", {}, 5, "Switchboard"],
    ["без notify — Switchboard", undefined, null, "Switchboard"],
  ])("заголовок: %s", async (_n, n, from, title) => {
    const { scope } = worker();
    await scope.fire("push", pushData(n, from));
    expect(scope.shown[0].title).toBe(title);
  });

  it.each<[string, () => unknown]>([
    ["нет type", () => ({ from: "x@pc" })],
    ["не JSON", () => {
      throw new SyntaxError("not json");
    }],
  ])("4046 · пуш не по форме, %s: не показан, не записан, причина в журнале браузера", async (_n, json) => {
    const { scope, store } = worker();
    await scope.fire("push", { data: { json } });
    expect(scope.shown).toEqual([]);
    expect(store.data.pushes).toBeUndefined();
    expect(errors).toHaveBeenCalledWith("switchboard: пуш не по форме — нет type");
  });

  it("пуш без данных — не показан, причина в журнале браузера", async () => {
    const { scope } = worker();
    await scope.fire("push", { data: null });
    expect(scope.shown).toEqual([]);
    expect(errors).toHaveBeenCalledWith("switchboard: пуш не по форме — нет type");
  });
});

describe("служебный обработчик: нажатие", () => {
  it("без кнопки: уведомление закрыто, пуш помечен нажатым, окно открыто; открытое окно — «pushes» и фокус, нового нет", async () => {
    const { scope, store } = worker();
    await scope.fire("push", pushData(notify(2)));
    const close = vi.fn();
    await scope.fire("notificationclick", { action: "", notification: { data: scope.shown[0].o.data, close } });
    expect(close).toHaveBeenCalled();
    expect((store.data.pushes as Array<{ clicked?: boolean }>)[0].clicked).toBe(true);
    expect(scope.opened).toEqual(["https://switchboard-phone.test/"]);
    scope.setWins(1);
    await click(scope, "");
    expect(scope.focused).toEqual(["post pushes", "focus"]);
    expect(scope.opened).toHaveLength(1);
  });

  it("5136 · кнопка: адрес relay — из обещания списка сборки; кадр — relay машины адресата; ответ и закрытие 1000; новых уведомлений и окон нет", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => ({ ok: true });
    let give!: (u: string) => void;
    const { scope } = worker({ relay, url: new Promise<string>((r) => (give = r)) });
    await scope.fire("push", pushData(notify(2)));
    const clicking = click(scope);
    await flush();
    expect(relay.socks).toHaveLength(0);
    give("wss://relay.from-build/");
    await clicking;
    await flush();
    expect(relay.socks.map((s) => s.url)).toEqual(["wss://relay.from-build/m/laptop"]);
    expect(relay.hellos[0]).toMatchObject({ key: KEY });
    expect(relay.got.find((f) => f.type === "answer")).toMatchObject({ callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": "прод" } });
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "done" });
    expect(scope.shown).toHaveLength(1);
    expect(scope.opened).toEqual([]);
  });

  it.each<[string, { store?: Record<string, unknown>; frame?: object; arrange?: (r: FakeRelay) => void }, string, number]>([
    ["отказ relay", { arrange: (r) => void (r.handlers.answer = () => ({ ok: false, error: "already_answered" })) }, "already_answered", 1],
    ["4047 нет ключа в хранилище", { store: {} }, "no_key", 0],
    ["кадр без адреса машины", { frame: { type: "answer", v: 1, callsign: "profiles", question: "q" } }, "bad_frame", 0],
    ["relay отказал пропуску", { arrange: (r) => void r.refuse.push("revoked") }, "revoked", 1],
  ])("кнопка, %s: уведомление «Ответ не отправлен: слово» с прежним текстом и tag, причина в журнале, окно не открыто", async (_n, o, word, socks) => {
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => ({ ok: true });
    o.arrange?.(relay);
    const n = notify(2);
    const { scope } = worker({ relay, store: memoryStore(o.store ?? { key: KEY }) });
    await scope.fire("push", pushData(o.frame ? { ...n, actions: [{ title: "да", frame: o.frame }] } : n));
    await click(scope);
    await flush();
    expect(scope.shown[1].title).toBe(`Ответ не отправлен: ${word}`);
    expect(scope.shown[1].o).toMatchObject({ body: n.body, tag: "toolu_01Hx" });
    expect(said()).toContain(`switchboard: ответ из уведомления не отправлен — ${word}`);
    expect(relay.socks).toHaveLength(socks);
    expect(scope.opened).toEqual([]);
  });

  it("кнопка, relay молчит: за предел — «Ответ не отправлен: timeout», соединение закрыто", async () => {
    const relay = new FakeRelay(homeRoster());
    const { scope } = worker({ relay });
    await scope.fire("push", pushData(notify(2)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clicking = click(scope);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1);
      await turn(2);
    }
    expect(relay.got.map((f) => f.type)).toContain("answer");
    await vi.advanceTimersByTimeAsync(SEND_MS);
    await clicking;
    expect(scope.shown[1].title).toBe("Ответ не отправлен: timeout");
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "done" });
  });
});
