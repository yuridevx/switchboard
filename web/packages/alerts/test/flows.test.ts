// Флоу web-alerts по плану цикла тестов (web): полоса уведомлений, пуши из раздела, служебный обработчик.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM, serviceWorker, type BrowserPush } from "../contract.ts";
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

/** Браузер, который отвечает на разрешение словом answer. */
function browserAnswering(answer: string) {
  const b = fakeBrowser("default");
  b.Notification!.requestPermission = async function () {
    b.calls.push("requestPermission");
    this.permission = answer;
    return answer;
  };
  return b;
}

const card = (t: Awaited<ReturnType<typeof stand>>) => t.$(".al-card")?.textContent ?? null;

describe("полоса «Включить уведомления»", () => {
  it("4040 · разрешение не дано: denied — «запрещены», default — снова «Включить»; запросов к push нет", async () => {
    const relay = new FakeRelay(homeRoster());
    const t = await stand(parts(browserAnswering("denied")), { relay });
    await t.click(t.button("Включить"));
    expect(card(t)).toContain("Уведомления запрещены");
    expect(t.button("Включить")).toBeNull();
    const relay2 = new FakeRelay(homeRoster());
    const t2 = await stand(parts(browserAnswering("default")), { relay: relay2 });
    await t2.click(t2.button("Включить"));
    expect(t2.button("Включить")).not.toBeNull();
    expect([...relay.got, ...relay2.got].filter((f) => f.type.startsWith("push"))).toEqual([]);
  });

  it("4041 · браузер не подписал или push.subscribe отказал — «Не вышло: слово», «Ещё раз»", async () => {
    const b = fakeBrowser("default");
    const reg = await b.sw!.ready;
    reg.pushManager.subscribe = async () => {
      throw new Error("AbortError: push service not available");
    };
    const relay = new FakeRelay(homeRoster());
    relay.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl6" } });
    const t = await stand(parts(b), { relay });
    await t.click(t.button("Включить"));
    expect(card(t)).toBe("Включить уведомленияНе вышло: AbortError: push service not availableЕщё раз");
    expect(relay.sent("push.subscribe")).toHaveLength(0);

    const relay2 = new FakeRelay(homeRoster());
    relay2.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl6" } });
    relay2.handlers["push.subscribe"] = () => ({ ok: false, error: "bad_sub" });
    const t2 = await stand(parts(fakeBrowser("default")), { relay: relay2 });
    await t2.click(t2.button("Включить"));
    expect(card(t2)).toBe("Включить уведомленияНе вышло: bad_subЕщё раз");
  });
});

describe("пуши из раздела pushes", () => {
  it("4042 · обработчик сообщил «pushes» открытому окну — пуш у владельца сразу, раздел пуст", async () => {
    const b = fakeBrowser("granted");
    const store = memoryStore({ key: KEY });
    const relay = new FakeRelay(homeRoster());
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const t = await stand(parts(b), { store, relay });
    store.data.pushes = [{ id: "p1", type: "message", from: "poe-bot@pc", notify: { body: "Готово" }, at: 1, clicked: true }];
    b.post("pushes");
    await flush();
    expect(store.data.pushes).toEqual([]);
    expect(location.hash).toBe("#chat?callsign=poe-bot%40pc");
    expect(t.$(".chat-in")!.textContent).toContain("Готово");
  });

  it("4043 · полоса по разрешению и подписке: нет API — нет; granted и подписка — нет; granted без подписки — «Включить»; denied — «запрещены»", async () => {
    const t1 = await stand(parts({}));
    expect(card(t1)).toBeNull();
    const sub = fakeBrowser("granted");
    await (await sub.sw!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(1) });
    const t2 = await stand(parts(sub));
    expect(card(t2)).toBeNull();
    const t3 = await stand(parts(fakeBrowser("granted")));
    expect(card(t3)).toContain("Включить уведомления");
    const t4 = await stand(parts(fakeBrowser("denied")));
    expect(card(t4)).toContain("Уведомления запрещены");
  });

  it("4044 · обработчик не зарегистрирован — причина в консоли, модуль работает", async () => {
    const err = vi.spyOn(console, "error");
    const b = fakeBrowser("default");
    b.sw!.register = async () => {
      throw new Error("SecurityError");
    };
    const t = await stand(parts(b));
    await flush();
    expect(err).toHaveBeenCalledWith("switchboard: обработчик пушей не зарегистрирован", expect.any(Error));
    expect(t.run.failed).toEqual({});
    expect(card(t)).toContain("Включить уведомления");
  });

  it("4045 · возвращение на экран — пуши, пришедшие в фоне, у владельцев", async () => {
    const store = memoryStore({ key: KEY });
    const relay = new FakeRelay(homeRoster());
    relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign !== "poe-bot@pc" ? [] : [{ question: "q9", kind: "ask", questions: [{ question: "Катим?", options: [{ label: "да" }, { label: "нет" }] }] }] });
    const t = await stand(parts(fakeBrowser("granted")), { store, relay });
    await t.run.hide();
    store.data.pushes = [{ id: "p2", type: "question", from: "poe-bot@pc", notify: { title: "poe-bot@pc спрашивает", body: "Катим?" }, at: 2 }];
    await t.run.show();
    await flush(10);
    expect(store.data.pushes).toEqual([]);
    expect(relay.sent("question.list").filter((x) => x.callsign === "poe-bot@pc")).toHaveLength(1);
    expect(t.$('[data-callsign="poe-bot@pc"]')!.textContent).toContain("Катим?");
  });
});

describe("служебный обработчик", () => {
  it("4046 · пуш не по форме — не показан, не записан, причина в консоли", async () => {
    const err = vi.spyOn(console, "error");
    const scope = fakeScope();
    const store = memoryStore({ key: KEY });
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2 });
    await scope.fire("push", { data: { json: () => ({ from: "x@pc" }) } });
    await scope.fire("push", {
      data: {
        json: () => {
          throw new SyntaxError("not json");
        },
      },
    });
    expect(scope.shown).toEqual([]);
    expect(store.data.pushes).toBeUndefined();
    expect(err).toHaveBeenCalledWith("switchboard: пуш не по форме — нет type");
  });

  it("4047 · кнопка без ключа в хранилище — «Ответ не отправлен: no_key», соединения нет", async () => {
    const scope = fakeScope();
    const relay = new FakeRelay(homeRoster());
    const store = memoryStore({});
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2, WebSocket: relay.WebSocket as never });
    const frame = { type: "answer", v: 1, callsign: "profiles@laptop", question: "q1", answers: { "Q?": "да" } };
    await scope.fire("push", { data: { json: () => ({ type: "question", from: "profiles@laptop", notify: { title: "?", body: "Q?", tag: "q1", actions: [{ title: "да", frame }] } }) } });
    await scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
    await flush();
    expect(scope.shown[1].title).toBe("Ответ не отправлен: no_key");
    expect(scope.shown[1].o.tag).toBe("q1");
    expect(relay.socks).toHaveLength(0);
  });
});
