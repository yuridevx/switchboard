// Покрытие плана frame-question-ask: форма MCP целиком и сверка с Host после обрыва.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createAsk, manifest as askM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];
const CS = "profiles@laptop";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function relayWith() {
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  relay.handlers.answer = () => ({ ok: true });
  return relay;
}

async function form(body: Record<string, unknown>) {
  const relay = relayWith();
  const q = { question: "f1", kind: "form", message: "Данные", ...body };
  relay.handlers["question.list"] = () => ({ ok: true, result: [q] });
  const t = await stand(parts(), { relay, url: `/#ask?callsign=${encodeURIComponent(CS)}` });
  relay.push({ type: "question", from: CS, to: ["phone"], ...q });
  await flush(5);
  return t;
}

describe("форма MCP", () => {
  it("6985 · число уходит числом, выбор — значением", async () => {
    // источник: чьё: код
    const t = await form({ schema: { type: "object", properties: { points: { type: "integer" }, tag: { type: "string", enum: ["a", "b"] } } } });
    const num = t.$<HTMLInputElement>('.ask-field input[type="number"]')!;
    num.value = "5";
    num.dispatchEvent(new Event("input", { bubbles: true }));
    const sel = t.$<HTMLSelectElement>(".ask-field select");
    if (sel) {
      sel.value = "b";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } else await t.click(t.button("b"));
    await flush();
    await t.click(t.button("Отправить"));
    expect(t.relay.sent("answer")[0]).toMatchObject({ action: "accept", content: { points: 5, tag: "b" } });
  });

});

describe("снова на связи", () => {
  it("6986 · сверка с Host: A убран, B на месте без дубля, C добавлен", async () => {
    // источник: устав — соединение оборвалось, клиенты переподключаются
    const pending = (id: string) => ({ question: id, kind: "ask", questions: [{ question: `Вопрос ${id}?`, options: [{ label: "да" }] }] });
    const relay = relayWith();
    let known = [pending("A"), pending("B")];
    relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === CS ? known : [] });
    const t = await stand(parts(), { relay, url: `/#ask?callsign=${encodeURIComponent(CS)}` });
    relay.push({ type: "question", from: CS, to: ["phone"], ...pending("A") });
    relay.push({ type: "question", from: CS, to: ["phone"], ...pending("B") });
    await flush(5);
    expect(t.text()).toContain("Вопрос A?");
    known = [pending("B"), pending("C")];
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(t.text()).not.toContain("Вопрос A?");
    expect(t.text()).toContain("Вопрос B?");
    await t.click(t.$(".ask-opt"));
    await t.click(t.button("Ответить"));
    await flush(5);
    relay.push({ type: "answered", from: CS, question: "B", by: "phone", answers: {} });
    await flush(5);
    expect(t.text()).toContain("Вопрос C?");
    expect(relay.sent("answer").map((f) => f.question)).toEqual(["B"]);
  });
});
