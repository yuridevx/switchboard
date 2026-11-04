// Черновик вне снимка: буква ввода не будит экраны, текст по-прежнему сохраняется.
import { describe, expect, it, vi } from "vitest";
import type { App } from "@switchboard/web-core";
import { flush, KEY } from "../../core/stand/app.ts";
import { createChatStore } from "../src/state/chat.ts";
import { chat, relayFor } from "./stand.ts";
import { memoryStore } from "@switchboard/web-core";

const CS = "site@laptop";

describe("черновик", () => {
  it("7290 · буква ввода — ни одного уведомления шины: выборки экранов не пересчитываются", async () => {
    // источник: отчёт архитектора, лишняя коммуникация 1; выборок на черновик нет
    const changed = vi.fn();
    const store = createChatStore({ changed, store: () => ({ get: async () => null, set: async () => {} }) } as unknown as App);
    store.setDraft(CS, "п");
    store.setDraft(CS, "пр");
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(0);
    expect(store.draft(CS)).toBe("пр");
  });

  it("7296 · черновик переживает уход с экрана и новый запуск страницы", async () => {
    // источник: чьё: код — раздел хранилища drafts
    const store = memoryStore({ key: KEY });
    const first = await chat(CS, { relay: relayFor(), store });
    await first.type("недописанное");
    history.pushState(null, "", "/#inbox");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(store.data.drafts).toEqual({ [CS]: "недописанное" });
    history.pushState(null, "", `/#chat?callsign=${encodeURIComponent(CS)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(first.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("недописанное");
  });
});
