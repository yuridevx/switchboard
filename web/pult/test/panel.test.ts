// Эталоны вида «Пульт: сессии и чат». Стенд — страница happy-dom с поддельным relay; код пульта настоящий.
// Номер эталона — номер теста.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, HOST, KEY, pult } from "./stand.ts";

const QUESTION = {
  type: "question",
  from: "profiles@laptop",
  to: ["phone", "panel-desk"],
  question: "toolu_01Hq",
  kind: "ask",
  questions: [
    {
      question: "Какую базу мигрировать первой?",
      header: "База",
      multiSelect: false,
      options: [
        { label: "прод", description: "Боевая база, 2,1 млн строк. Окно — ночью, с 02:00." },
        { label: "стенд", description: "Копия недельной давности. Можно сразу." },
      ],
    },
  ],
};

const sendText = async (t: Awaited<ReturnType<typeof pult>>, text: string) => {
  await t.type(t.$(".chat-inp"), text);
  await t.click(t.$(".chat-send"));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны пульта: сессии и чат", () => {
  it("182 · чат: session.watch, потом session.history; общий uuid в ленте один; seq 44 после 42 — снова история, без дыр и двойников", async () => {
    const relay = fleetRelay();
    const user = { type: "user", uuid: "u1", message: { content: "Почини сборку на CI — падает с утра" } };
    const a1 = { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Смотрю лог CI." }] } };
    const a2 = { type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Падает test/worker.test.ts." }] } };
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [user, a1], more: false } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(relay.got.filter((f) => f.type.startsWith("session.")).map((f) => f.type).slice(0, 2)).toEqual(["session.watch", "session.history"]);
    relay.push({ type: "session.events", from: "site@laptop", to: ["panel-desk"], seq: 41, events: [a1] });
    relay.push({ type: "session.events", from: "site@laptop", to: ["panel-desk"], seq: 42, events: [a2] });
    await flush();
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["Смотрю лог CI.", "Падает test/worker.test.ts."]);
    expect(relay.sent("session.history")).toHaveLength(1);
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [user, a1, a2, { type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "Пропавшее в 43." }] } }], more: false } });
    relay.push({ type: "session.events", from: "site@laptop", to: ["panel-desk"], seq: 44, events: [{ type: "assistant", uuid: "a4", message: { content: [{ type: "text", text: "Сорок четвёртое." }] } }] });
    await flush();
    expect(relay.sent("session.history")).toHaveLength(2);
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["Смотрю лог CI.", "Падает test/worker.test.ts.", "Пропавшее в 43.", "Сорок четвёртое."]);
    expect(t.$$(".chat-me")).toHaveLength(1);
  });

  it("183 · в занятую: «в очереди · ✓», после uuid в ленте ✓✓; обрыв до reply — «не подтверждено», после hello по истории ✓✓ без повтора; нет — «ещё раз» тем же uuid", async () => {
    const relay = fleetRelay();
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await sendText(t, "И обнови README по итогам");
    const p1 = relay.sent("session.prompt")[0];
    expect(t.$(".chat-me small")!.textContent).toBe("в очереди · ✓");
    relay.push({ type: "session.events", from: "site@laptop", seq: 1, events: [{ type: "user", uuid: p1.uuid, message: { content: "И обнови README по итогам" } }] });
    await flush();
    expect(t.$(".chat-me small")!.textContent).toMatch(/^\d\d:\d\d · ✓✓$/);

    // второе: связь оборвалась до reply
    relay.handlers["session.prompt"] = () => undefined;
    await sendText(t, "Задеплой на стенд");
    const p2 = relay.sent("session.prompt")[1];
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
    relay.drop();
    await flush();
    expect(t.$(".chat-me.pend")!.textContent).toBe("Задеплой на стендсвязь оборвалась до ответа — не подтверждено · отправить ещё раз");
    await new Promise((r) => setTimeout(r, 20));
    await flush(10);
    expect(relay.hellos.length).toBeGreaterThanOrEqual(2);
    expect(relay.sent("session.history").length).toBeGreaterThanOrEqual(2);
    expect(relay.sent("session.prompt")).toHaveLength(2);
    expect(t.$(".chat-me.pend")).not.toBeNull();
    // нет в истории — «ещё раз» шлёт тот же uuid
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    await t.click(t.btn(null, "отправить ещё раз"));
    expect(relay.sent("session.prompt")).toHaveLength(3);
    expect(relay.sent("session.prompt")[2].uuid).toBe(p2.uuid);

    // второй прогон: uuid нашёлся в истории после hello — ✓✓ без повтора
    const relay2 = fleetRelay();
    relay2.handlers["session.prompt"] = () => undefined;
    const t2 = await pult({ relay: relay2 });
    await t2.click(t2.$('[data-callsign="site@laptop"]'));
    await sendText(t2, "Задеплой на стенд");
    const q = relay2.sent("session.prompt")[0];
    relay2.handlers["session.history"] = () => ({ ok: true, result: { messages: [{ type: "user", uuid: q.uuid, message: { content: "Задеплой на стенд" } }], more: false } });
    relay2.drop();
    await new Promise((r) => setTimeout(r, 20));
    await flush(10);
    expect(t2.$(".chat-me.pend")).toBeNull();
    expect(t2.$(".chat-me small")!.textContent).toMatch(/✓✓$/);
    expect(relay2.sent("session.prompt")).toHaveLength(1);
  });

  it("184 · вопрос пульту и phone: «стенд» → answer с id вопроса → «Ответ принят»; второй прогон: раньше ответил phone — answer не уходит, «Уже ответили с phone: прод»", async () => {
    const relay = fleetRelay();
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: QUESTION.question, kind: "ask", questions: QUESTION.questions }] });
    relay.handlers.answer = () => ({ ok: true });
    const t = await pult({ relay });
    relay.push(QUESTION);
    await flush();
    expect(t.$('[data-callsign="profiles@laptop"] .bd-t2')!.textContent).toBe("? Какую базу мигрировать первой?");
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    expect(t.$(".chat-ask")!.textContent).toContain("Какую базу мигрировать первой?");
    await t.click(t.btn(t.$(".chat-ask"), /^стенд/));
    await t.click(t.btn(t.$(".chat-ask"), "Ответить"));
    expect(relay.sent("answer")).toEqual([expect.objectContaining({ v: 1, callsign: "profiles@laptop", question: "toolu_01Hq", answers: { "Какую базу мигрировать первой?": "стенд" } })]);
    expect(t.$(".chat-ask")!.textContent).toContain("Ответ «стенд» принят.");
    expect(t.$$(".chat-ask .ask-opt").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    const relay2 = fleetRelay();
    relay2.handlers["question.list"] = relay.handlers["question.list"];
    const t2 = await pult({ relay: relay2 });
    relay2.push(QUESTION);
    await flush();
    await t2.click(t2.$('[data-callsign="profiles@laptop"]'));
    relay2.push({ type: "answered", from: "profiles@laptop", to: ["phone", "panel-desk"], question: "toolu_01Hq", by: "phone", answers: { "Какую базу мигрировать первой?": "прод" } });
    await flush();
    expect(t2.$(".chat-ask")!.textContent).toContain("Уже ответили с phone: «прод».");
    expect(relay2.sent("answer")).toHaveLength(0);
  });

  it("187 · обрыв: ждущий — disconnected сразу, полоса «нет связи», снова hello, потом watch и history", async () => {
    const relay = fleetRelay();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await sendText(t, "Почини");
    relay.drop();
    await flush(1);
    expect(t.$(".chat-me.pend")).not.toBeNull();
    expect(t.$(".sb-off")!.hidden).toBe(false);
    expect(t.$(".sb-off")!.textContent).toMatch(/^Нет связи с relay · данные на \d\d:\d\d/);
    const watches = relay.sent("session.watch").length;
    await new Promise((r) => setTimeout(r, 20));
    await flush(10);
    expect(relay.hellos.length).toBeGreaterThanOrEqual(2);
    expect(relay.sent("session.watch").length).toBe(watches + 1);
    expect(relay.got.filter((f) => f.type === "session.watch" || f.type === "session.history").slice(-2).map((f) => f.type)).toEqual(["session.watch", "session.history"]);

  });

  it("188 · у pc нет session.files и session.call: у poe-bot нет «@», «/», сведений и «Прервать», запросов к pc нет; у site — есть, session.files ушёл", async () => {
    const r = fleetRoster();
    const pc = { ...HOST };
    delete pc["session.files"];
    delete pc["session.call"];
    r.machines[1].contract = pc;
    const relay = fleetRelay(r);
    relay.handlers["session.files"] = () => ({ ok: true, result: ["src/worker.ts", "test/worker.test.ts"] });
    const t = await pult({ relay });
    await t.expand();
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    await t.type(t.$(".chat-inp"), "@");
    expect(t.$('[aria-label="Файл папки"]')).toBeNull();
    expect(t.$('[aria-label="Команда"]')).toBeNull();
    expect(t.btn(null, "Прервать")).toBeNull();
    await t.click(t.$('.cw-tabs [data-tab="set"]'));
    expect(t.$('[data-sec="call"]')).toBeNull();
    expect(t.btn(null, "Прервать")).toBeNull();
    expect(relay.got.filter((f) => (f.type === "session.files" || f.type === "session.call") && String(f.callsign).endsWith("@pc"))).toEqual([]);

    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$('[aria-label="Файл папки"]')).not.toBeNull();
    expect(t.$('[aria-label="Команда"]')).not.toBeNull();
    expect(t.btn(null, "Прервать")).not.toBeNull();
    await t.type(t.$(".chat-inp"), "Сравни с @wor");
    expect(relay.sent("session.files")).toEqual([expect.objectContaining({ callsign: "site@laptop", query: "wor", limit: 20 })]);
    expect(t.$$(".chat-sugi").map((b) => b.textContent)).toEqual(["src/worker.ts", "test/worker.test.ts"]);
    await t.click(t.$(".chat-sugi"));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Сравни с @src/worker.ts ");
  });

});
