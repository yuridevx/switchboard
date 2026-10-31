// web-chat на стенде: лента (watch + history, склейка по uuid, разрыв seq), ввод, переписка, черновики.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";
import { memoryStore } from "@switchboard/web-core";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

const hist = (messages: unknown[]) => () => ({ ok: true as const, result: { messages, more: false } });
const user = (uuid: string, text: string) => ({ type: "user", uuid, message: { role: "user", content: text } });
const asst = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, message: { content } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function feed(callsign = "site@laptop", relay = new FakeRelay(homeRoster()), store?: ReturnType<typeof memoryStore>) {
  relay.handlers["session.watch"] ??= () => ({ ok: true });
  relay.handlers["session.unwatch"] ??= () => ({ ok: true });
  relay.handlers["session.history"] ??= hist([]);
  const t = await stand(parts(), { relay, store });
  await t.click(t.$(`[data-callsign="${callsign}"]`));
  return t;
}

describe("лента сессии", () => {
  it("открытие: session.watch, потом session.history; события рисуются; итог инструмента — ✓", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.handlers["session.history"] = hist([user("u1", "Почини сборку на CI — падает с утра"), asst("a1", [{ type: "text", text: "Смотрю лог CI." }])]);
    const t = await feed("site@laptop", relay);
    const own = relay.got.filter((f) => f.type.startsWith("session."));
    expect(own.map((f) => f.type)).toEqual(["session.watch", "session.history"]);
    expect(own[1]).toMatchObject({ v: 1, callsign: "site@laptop", before: null, limit: 50 });
    relay.push({
      type: "session.events",
      from: "site@laptop",
      seq: 42,
      events: [
        asst("a1", [{ type: "text", text: "Смотрю лог CI." }]), // уже есть из истории — одно по uuid
        asst("a2", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
        { type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", elapsed_time_seconds: 18 },
        { type: "stream_event", event: {} },
      ],
    });
    await flush();
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["Смотрю лог CI."]);
    expect(t.$(".chat-tool")!.textContent).toBe("Bashnpm test18 с");
    relay.push({
      type: "session.events",
      from: "site@laptop",
      seq: 43,
      events: [
        { type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
        { type: "result", uuid: "z1", subtype: "success", duration_ms: 134_000 },
      ],
    });
    await flush();
    expect(t.$(".chat-tool")!.textContent).toBe("Bashnpm test✓");
    expect(t.$(".chat-res")!.textContent).toBe("ход закончен · 2 мин 14 с");
    expect(relay.sent("session.history")).toHaveLength(1);
  });

  it("seq не следующий — снова session.history", async () => {
    const t = await feed();
    t.relay.push({ type: "session.events", from: "site@laptop", seq: 7, events: [] });
    t.relay.push({ type: "session.events", from: "site@laptop", seq: 8, events: [] });
    await flush();
    expect(t.relay.sent("session.history")).toHaveLength(1);
    t.relay.push({ type: "session.events", from: "site@laptop", seq: 1, events: [] });
    await flush();
    expect(t.relay.sent("session.history")).toHaveLength(2);
  });

  it("ввод: session.prompt с uuid → «доставлено»", async () => {
    const t = await feed();
    t.relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = "Задеплой на стенд";
    inp.dispatchEvent(new Event("input"));
    await t.click(t.$(".chat-send"));
    const p = t.relay.sent("session.prompt")[0];
    expect(p).toMatchObject({ v: 1, callsign: "site@laptop", text: "Задеплой на стенд" });
    expect(typeof p.uuid).toBe("string");
    expect(t.$(".chat-me")!.textContent).toMatch(/^Задеплой на стенд\d\d:\d\d · доставлено$/);
    expect(inp.value).toBe("");
  });

  it("offline — пузыря нет, черновик цел, строка «не доставлено — pc не на связи»", async () => {
    const t = await feed("poe-bot@pc");
    t.relay.handlers["session.prompt"] = () => ({ ok: false, error: "offline" });
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = "Катим";
    inp.dispatchEvent(new Event("input"));
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me")).toBeNull();
    expect(inp.value).toBe("Катим");
    expect(t.text()).toContain("poe-bot@pc: не доставлено — pc не на связи. Черновик цел.");
  });

  it("уход с ленты — session.unwatch; черновик — в раздел drafts", async () => {
    const store = memoryStore({ key: KEY });
    const t = await feed("site@laptop", new FakeRelay(homeRoster()), store);
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = "недописанное";
    inp.dispatchEvent(new Event("input"));
    await t.click(t.button("‹"));
    expect(t.relay.sent("session.unwatch")[0]).toMatchObject({ callsign: "site@laptop" });
    expect(store.data.drafts).toEqual({ "site@laptop": "недописанное" });
  });
});

describe("переписка", () => {
  it("message сессии: метка unread в списке; открыли — сообщение «→ вам», метка снята", async () => {
    const t = await stand(parts(), { relay: Object.assign(new FakeRelay(homeRoster()), {}) });
    t.relay.handlers["session.watch"] = () => ({ ok: true });
    t.relay.handlers["session.history"] = hist([]);
    t.relay.push({ type: "message", from: "poe-bot@pc", to: "phone", text: "Эталоны: 13 из 13. Катить в основную?" });
    await flush();
    const row = t.$('[data-callsign="poe-bot@pc"]')!;
    expect(row.textContent).toContain("Эталоны: 13 из 13. Катить в основную?");
    expect(row.querySelector(".sb-badge")!.textContent).toBe("1");
    await t.click(row);
    expect(t.$(".chat-in")!.textContent).toMatch(/^poe-bot@pc → вамЭталоны: 13 из 13\. Катить в основную\?\d\d:\d\d$/);
    await t.click(t.button("‹"));
    expect(t.$('[data-callsign="poe-bot@pc"] .sb-badge')).toBeNull();
  });
});
