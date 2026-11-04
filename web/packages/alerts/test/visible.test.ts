// Что видно сверх лесов границы: найдено сверкой нового кода со старым (чьё: код до сноса).
import { afterEach, expect, it, vi } from "vitest";
import type { App } from "@switchboard/web-core";
import { createAlerts } from "../contract.ts";

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
