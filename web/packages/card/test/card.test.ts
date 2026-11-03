// web-card на стенде: шапка из roster, чат в месте карточки, сведения и действия по contract машины.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createCard, manifest as cardM } from "../contract.ts";
import { FakeRelay, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function card(callsign: string, roster = homeRoster()) {
  const relay = new FakeRelay(roster);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  // карточка — по адресу: список сессий board в эти эталоны не входит
  const t = await stand(parts(), { relay, url: `/#card?callsign=${encodeURIComponent(callsign)}` });
  return t;
}

describe("карточка сессии", () => {
  it("шапка: имя, машина и папка; состояние — лампой без слов; вкладка «Чат» — лента в месте карточки", async () => {
    const t = await card("site@laptop");
    expect(t.$(".sb-bt")!.textContent).toBe("site@laptop@laptop · папка switchboard");
    expect(t.$(".sb-pill")).toBeNull();
    expect(t.$(".sb-bar .sb-dot.busy")).not.toBeNull();
    expect(t.$(".card-place .chat-comp")).not.toBeNull();
    expect(t.relay.sent("session.watch")[0]).toMatchObject({ callsign: "site@laptop" });
  });

  it("«Ещё»: поля roster; модель и усилие — session.update; «Остановить» — session.stop, отказ — словом", async () => {
    const r = homeRoster();
    r.machines[0].contract = { ...r.machines[0].contract, "session.update": 1 };
    const t = await card("site@laptop", r);
    t.relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
    await t.click(t.button("Ещё"));
    expect(t.relay.sent("session.unwatch")).toHaveLength(1);
    expect(t.$(".card-info")!.textContent).toBe("адресsite@laptopпапка~/Projects/switchboardслотmainаккаунтy0902");
    // прототип «Пульт и телефон»: модель и усилие меняются из сессии и на телефоне
    t.relay.handlers["session.update"] = () => ({ ok: true });
    expect(t.$('[data-pick="model"] [aria-pressed="true"]')!.textContent).toBe("opus");
    await t.click(t.$('[data-pick="effort"] button'));
    expect(t.relay.sent("session.update")[0]).toMatchObject({ callsign: "site@laptop", effort: "low" });
    await t.click(t.button("Остановить"));
    expect(t.relay.sent("session.stop")[0]).toMatchObject({ v: 1, callsign: "site@laptop" });
    expect(t.text()).toContain("session.stop: stopping");
  });

  it("остановленная — «Запустить»; нет session.start в contract машины — кнопки нет", async () => {
    const t = await card("wiki@pc");
    await t.click(t.button("Ещё"));
    expect(t.button("Запустить")).not.toBeNull();
    const r = homeRoster();
    delete r.machines[1].contract!["session.start"];
    const t2 = await card("wiki@pc", r);
    await t2.click(t2.button("Ещё"));
    expect(t2.button("Запустить")).toBeNull();
  });
});
