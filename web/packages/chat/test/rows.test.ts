// Строка ленты: новое сообщение рисует одну строку. ItemView подменён на счётчик без memo: преграда только у FeedRow.
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const renders = vi.hoisted(() => ({}) as Record<string, number>);
vi.mock("../src/cards/ItemView.tsx", async (orig) => {
  const real = await orig<typeof import("../src/cards/ItemView.tsx")>();
  return {
    ...real,
    ItemView({ it }: { it: { id: string } }) {
      renders[it.id] = (renders[it.id] ?? 0) + 1;
      return createElement(real.ItemView, { it } as never);
    },
  };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("6242 · новое сообщение рисует одну строку: прежние не рисуются заново", async () => {
  // источник: контракт web-chat «новое сообщение рисует одну карточку»
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [{ type: "user", uuid: "u1", message: { content: "Почини" } }] } });
  const parts = [
    { manifest: boardM, module: createBoard() },
    { manifest: cardM, module: createCard() },
    { manifest: chatM, module: createChat() },
    { manifest: askM, module: createAsk() },
    { manifest: alertsM, module: createAlerts({}) },
  ];
  await stand(parts, { relay, url: `/#chat?callsign=${encodeURIComponent("poe-bot@pc")}` });
  await flush();
  const before = renders.u1;
  expect(before).toBeGreaterThan(0);
  relay.push({ type: "session.events", from: "poe-bot@pc", seq: 1, events: [{ type: "user", uuid: "u2", message: { content: "Ещё" } }] });
  await flush();
  expect(renders.u2).toBeGreaterThan(0);
  expect(renders.u1).toBe(before);
});
