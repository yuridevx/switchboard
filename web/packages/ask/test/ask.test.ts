// web-ask на стенде: кадры question и answered, экран вопроса, answer и question.list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts } from "@switchboard/web-alerts";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

const Q1 = {
  question: "Какую базу мигрировать первой?",
  header: "База",
  multiSelect: false,
  options: [
    { label: "прод", description: "Боевая база, 2,1 млн строк. Окно — ночью, с 02:00." },
    { label: "стенд", description: "Копия недельной давности. Можно сразу." },
  ],
};
const question = (over: Record<string, unknown> = {}) => ({
  type: "question",
  from: "profiles@laptop",
  to: ["phone", "panel-desk"],
  question: "toolu_01Hx",
  kind: "ask",
  questions: [Q1],
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function opened(over: Record<string, unknown> = {}) {
  const t = await stand(parts());
  const q = question(over);
  // Host отдаёт ждущий вопрос и в question.list
  t.relay.handlers["question.list"] = () => ({ ok: true, result: [{ ...q, type: undefined, from: undefined, to: undefined }] });
  t.relay.push(q);
  await flush();
  await t.click(t.$('[data-callsign="profiles@laptop"]'));
  return t;
}

describe("вопрос сессии", () => {
  it("метка asked в строке списка: «?» и текст вопроса", async () => {
    const t = await stand(parts());
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push(question());
    await flush();
    const row = t.$('[data-callsign="profiles@laptop"]')!;
    expect(row.textContent).toContain("Какую базу мигрировать первой?");
    expect(row.querySelector(".sb-badge")!.textContent).toBe("?");
  });

  it("экран: чип, варианты с описаниями и «Свой ответ»; ответ — answer с текстом вопроса → вариант", async () => {
    const t = await opened();
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.$(".ask-chip")!.textContent).toBe("База");
    expect(t.$$(".ask-opt").map((b) => b.querySelector("b")!.textContent)).toEqual(["прод", "стенд", "Свой ответ"]);
    expect(t.text()).toContain("Копия недельной давности");
    expect(t.button("Ответить")!.disabled).toBe(true);
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    expect(t.relay.sent("answer")).toEqual([
      expect.objectContaining({ type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": "стенд" } }),
    ]);
    expect(t.text()).toContain("Ответ «стенд» принят.");
    expect(t.text()).toContain("Вопрос видят: вы и panel-desk");
  });

  it("свой ответ и галочки: ответы через запятую; пока не на все вопросы — «Ответить» недоступна", async () => {
    const Q2 = { question: "Что прогнать?", header: "Проверки", multiSelect: true, options: [{ label: "юнит" }, { label: "e2e" }] };
    const t = await opened({ questions: [Q1, Q2] });
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.$$(".ask-qn").map((x) => x.textContent)).toEqual(["вопрос 1 из 2", "вопрос 2 из 2"]);
    const opts = t.$$(".ask-opt");
    await t.click(opts[0]);
    expect(t.button("Ответить")!.disabled).toBe(true);
    await t.click(t.$$(".ask-opt")[3]);
    await t.click(t.$$(".ask-opt")[4]);
    await t.click(t.$$(".ask-opt")[5]); // свой ответ ко второму
    const inp = t.$<HTMLInputElement>("input.ask-own")!;
    inp.value = "линт";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await t.click(t.button("Ответить"));
    expect(t.relay.sent("answer")[0].answers).toEqual({ "Какую базу мигрировать первой?": "прод", "Что прогнать?": "юнит, e2e, линт" });
  });

  it("already_answered: «уже ответили с panel-desk», варианты недоступны, повтора нет", async () => {
    const t = await opened();
    t.relay.handlers.answer = () => ({ ok: false, error: "already_answered" });
    t.relay.push({ type: "answered", from: "profiles@laptop", question: "toolu_01Hx", by: "panel-desk", answers: { "Какую базу мигрировать первой?": "прод" } });
    await flush();
    expect(t.text()).toContain("Уже ответили с panel-desk: «прод».");
    expect(t.$$<HTMLButtonElement>(".ask-opt").every((b) => b.disabled)).toBe(true);
    expect(t.button("Ответить")).toBeNull();
    expect(t.relay.sent("answer")).toHaveLength(0);
  });

  it("отказ offline — карточка со словом, можно отправить ещё раз", async () => {
    const t = await opened();
    t.relay.handlers.answer = () => ({ ok: false, error: "offline" });
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.button("Ответить"));
    expect(t.text()).toContain("Не отправлено: offline");
    expect(t.button("Ответить")!.disabled).toBe(false);
  });

  it("ход прервали: answered с cancelled — «Вопрос снят», метка снята", async () => {
    const t = await opened();
    t.relay.push({ type: "answered", from: "profiles@laptop", question: "toolu_01Hx", cancelled: true });
    await flush();
    expect(t.text()).toContain("Вопрос снят.");
    t.button("‹")!.click();
    await flush();
    expect(t.$('[data-callsign="profiles@laptop"] .sb-badge')).toBeNull();
  });

  it("ждущая сессия в roster — question.list; ответ Host — вопросы на экране", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: "toolu_01Hx", kind: "ask", questions: [Q1] }] });
    const t = await stand(parts(), { relay });
    expect(t.relay.sent("question.list")[0]).toMatchObject({ v: 1, callsign: "profiles@laptop" });
    await flush();
    expect(t.$('[data-callsign="profiles@laptop"]')!.textContent).toContain("Какую базу мигрировать первой?");
  });

  it("форма MCP: поля схемы → answer с content; «Отклонить» → action decline", async () => {
    const t = await opened({
      kind: "form",
      questions: undefined,
      message: "Данные для новой задачи",
      schema: { type: "object", properties: { project: { type: "string" } } },
    });
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.text()).toContain("Данные для новой задачи");
    const inp = t.$<HTMLInputElement>(".ask-field input")!;
    inp.value = "WEB";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await t.click(t.button("Отправить"));
    expect(t.relay.sent("answer")[0]).toMatchObject({ question: "toolu_01Hx", action: "accept", content: { project: "WEB" } });

    // вторая форма — «Отклонить»; форма со ссылкой — «Перешёл»
    const t2 = await opened({ kind: "form", questions: undefined, message: "Данные", schema: { type: "object", properties: { project: { type: "string" } } } });
    t2.relay.handlers.answer = () => ({ ok: true });
    await t2.click(t2.button("Отклонить"));
    expect(t2.relay.sent("answer")[0]).toMatchObject({ question: "toolu_01Hx", action: "decline" });
    expect(t2.relay.sent("answer")[0]).not.toHaveProperty("content");
    const t3 = await opened({ kind: "form", questions: undefined, message: "Войдите в GitHub", url: "https://github.com/login/device" });
    t3.relay.handlers.answer = () => ({ ok: true });
    expect(t3.$<HTMLAnchorElement>(".ask-url")!.href).toBe("https://github.com/login/device");
    await t3.click(t3.button("Перешёл"));
    expect(t3.relay.sent("answer")[0]).toMatchObject({ action: "accept" });
    expect(t3.relay.sent("answer")[0]).not.toHaveProperty("content");
  });
});
