// Что видно сверх лесов границы: найдено сверкой нового кода со старым (чьё: код до сноса).
import { afterEach, expect, it, vi } from "vitest";
import { memoryStore, type App } from "@switchboard/web-core";
import { createAlerts, serviceWorker } from "../contract.ts";
import { FakeRelay, homeRoster, KEY } from "../../core/stand/app.ts";
import { fakeScope } from "../stand/fakes.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("браузер без PushManager: обработчик всё равно ставится и пуши забираются, уведомлений нет", async () => {
  const register = vi.fn(async () => undefined);
  const listen = vi.fn();
  vi.stubGlobal("Notification", { permission: "default", requestPermission: async () => "default" });
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: { register, ready: new Promise(() => {}), addEventListener: listen } });
  const m = createAlerts()({ changed() {}, deliver() {}, store: () => ({ update: async () => [] }) } as unknown as App);
  await m.start!();
  expect(register).toHaveBeenCalledWith("sw.js");
  expect(listen).toHaveBeenCalledWith("message", expect.any(Function));
  expect((m.marks as Record<string, () => string>)["alerts.state"]()).toBe("off");
});

it.each<[string, string, string]>([
  ["со словом закрытия", "сеть", "Ответ не отправлен: сеть"],
  ["без слова — код закрытия", "", "Ответ не отправлен: 1006"],
])("кнопка уведомления, связь оборвалась до ответа, %s: отказ сразу, соединение одно", async (_n, reason, title) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = new FakeRelay(homeRoster());
  class Dropping extends relay.WebSocket {
    constructor(url: string) {
      super(url);
      setTimeout(() => this.serverClose(1006, reason), 1);
    }
  }
  const scope = fakeScope();
  serviceWorker(scope, { relayUrl: "wss://relay.test", store: memoryStore({ key: KEY }), maxActions: () => 2, WebSocket: Dropping as never });
  const notify = { title: "t", body: "b", tag: "x", actions: [{ title: "да", frame: { type: "answer", v: 1, callsign: "profiles@laptop", question: "q", answers: {} } }] };
  await scope.fire("push", { data: { json: () => ({ type: "question", from: "profiles@laptop", notify }) } });
  await scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
  expect(scope.shown[1].title).toBe(title);
  expect(relay.socks).toHaveLength(1);
});
