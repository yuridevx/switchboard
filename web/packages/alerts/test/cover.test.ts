// Покрытие плана action-alerts-enable: причина в журнале, повтор после сбоя, старт без обработчика.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createAlerts, manifest as alertsM, type BrowserPush } from "../contract.ts";
import { createAlertsStore, READY_MS } from "../src/store.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";
import { fakeBrowser } from "../stand/fakes.ts";

const parts = (browser: BrowserPush) => [
  { manifest: boardM, module: createBoard },
  { manifest: cardM, module: createCard },
  { manifest: chatM, module: createChat },
  { manifest: askM, module: createAsk },
  { manifest: alertsM, module: createAlerts(browser) },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("включение", () => {
  it("6987 · ключ не получен: причина в журнале; подписки нет", async () => {
    // источник: устав — система ловит: отказ словом и журнал
    const fails = vi.spyOn(console, "error").mockImplementation(() => {});
    const br = fakeBrowser();
    const relay = new FakeRelay(homeRoster());
    relay.handlers["push.key"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(br), { relay });
    await t.click(t.button("Включить"));
    expect(fails.mock.calls.flat().join(" ")).toContain("offline");
    expect(br.calls.filter((c) => c.startsWith("subscribe"))).toEqual([]);
  });

  it("6988 · «Ещё раз» после сбоя: на время кнопка неактивна; подписка прошла, полосы нет, тост", async () => {
    // источник: чьё: код
    vi.spyOn(console, "error").mockImplementation(() => {});
    const br = fakeBrowser();
    const relay = new FakeRelay(homeRoster());
    relay.handlers["push.key"] = () => ({ ok: false, error: "offline" });
    relay.handlers["push.subscribe"] = () => ({ ok: true });
    const t = await stand(parts(br), { relay });
    await t.click(t.button("Включить"));
    relay.handlers["push.key"] = () => undefined;
    const again = t.button("Ещё раз")!;
    again.click();
    await flush();
    expect(t.$<HTMLButtonElement>(".al-on")!.disabled).toBe(true);
    const f = relay.sent("push.key").at(-1)!;
    relay.reply(f.id!, { ok: true, result: { key: "AAAA" } });
    await flush(10);
    expect(t.$(".al-card")).toBeNull();
    expect(t.$(".sb-toast")!.textContent).toContain("Уведомления включены");
  });

  it("6990 · старт: разрешение есть, обработчик не поднялся — старт не висит, полоса «Включить»", async () => {
    // источник: устав — у всех операций лимит
    vi.useFakeTimers();
    const browser: BrowserPush = {
      sw: { register: async () => undefined, ready: new Promise(() => {}), addEventListener: () => {} },
      Notification: { permission: "granted", requestPermission: async () => "granted" },
    };
    const store = createAlertsStore({ changed: () => {}, store: () => ({ update: async () => [] }), deliver: () => {}, toast: () => {} } as never, browser);
    const started = store.start();
    let done = false;
    void Promise.resolve(started).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(READY_MS + 1);
    expect(done).toBe(true);
    expect(store.state()).toBe("ask");
  });
});
