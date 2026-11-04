// Вкладка широкой карточки считается при рисовании: вставка места пропала — чужой экран не остаётся.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import type { AppPart } from "@switchboard/web-core";
import { createCard, manifest as cardM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("вкладка широкой карточки", () => {
  it("7290 · вставка места пропала, пока открыта — вкладка «Настройки», чужого экрана нет", async () => {
    // источник: чьё: код — без вкладки нет и её экрана; запасная вкладка широкого вида — «Настройки» (6929)
    let shown = true;
    let changed = () => {};
    const tabPart: AppPart = {
      manifest: { name: "t-tab", type: "web", version: "1.0.0", provides: { "t.tab": 1 }, uses: { "card.tab@web-card": 1 } },
      module: (app) => {
        changed = app.changed;
        return { screens: { "t.tab": { label: "Вставка", place: "card.tab", show: () => shown, view: () => createElement("div", { className: "t-tab" }) } } };
      },
    };
    const r = homeRoster();
    r.sessions[0].state = "idle";
    const callsign = r.sessions[0].callsign;
    const relay = new FakeRelay(r);
    for (const n of ["session.watch", "session.unwatch"]) relay.handlers[n] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const parts: AppPart[] = [{ manifest: boardM, module: createBoard }, { manifest: cardM, module: createCard }, { manifest: chatM, module: createChat }, { manifest: askM, module: createAsk }, { manifest: alertsM, module: createAlerts({}) }, tabPart];
    const t = await stand(parts, { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", `/#card?callsign=${encodeURIComponent(callsign)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    await t.click(t.$('.cw-tabs [data-tab="t.tab"]'));
    await flush();
    expect(t.$(".t-tab")).not.toBeNull();
    shown = false;
    changed();
    await flush();
    expect(t.$('.cw-tabs [data-tab="t.tab"]')).toBeNull();
    expect(t.$(".t-tab")).toBeNull();
    expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
  });
});
