// Запрос разрешения и одобрение плана на экране вопроса. Источник: цель пользователя 4 нояб. «чат со всеми фичами Claude»;
// форма кадра — модуль questions на Host, поля — настоящий процесс claude 0.3.311.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createInbox, manifest as inboxM } from "@switchboard/web-inbox";
import { createAsk, manifest as askM } from "../contract.ts";
import { flush, stand } from "../../core/stand/app.ts";

const CS = "profiles@laptop";
const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
const perm = (over: Record<string, unknown> = {}) => ({
  type: "question",
  from: CS,
  to: ["phone", "panel-desk"],
  question: "toolu_p1",
  kind: "perm",
  tool: "Bash",
  input: { command: "npm test", description: "Прогон" },
  title: "Claude хочет выполнить npm test",
  suggestions: SUGGEST,
  ...over,
});
const plan = (over: Record<string, unknown> = {}) => perm({ question: "toolu_e1", tool: "ExitPlanMode", input: { plan: "## Шаги\n\n1. **Найти** формулу" }, title: undefined, suggestions: undefined, ...over });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function opened(q: Record<string, unknown>) {
  const t = await stand(parts());
  t.relay.handlers["question.list"] = () => ({ ok: true, result: [{ ...q, type: undefined, from: undefined, to: undefined }] });
  const sent: Array<Record<string, unknown>> = [];
  t.relay.handlers.answer = (f) => (sent.push(f), { ok: true });
  t.relay.push(q);
  await flush();
  await t.click(t.$(`[data-callsign="${CS}"]`));
  const button = (text: string) => t.$$<HTMLButtonElement>(".ask button").find((b) => b.textContent === text);
  const press = async (text: string) => {
    await t.click(button(text)!);
    await flush();
  };
  const reason = async (text: string) => {
    const el = t.$<HTMLTextAreaElement>(".ask textarea")!;
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  return { ...t, sent, button, press, reason };
}

describe("запрос разрешения на экране", () => {
  it("7130 · кадр без списка: строка списка показывает его как ждущий вопрос — «?» и заголовок; без заголовка — инструмент и суть", async () => {
    const t = await stand(parts());
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push(perm());
    await flush();
    const row = t.$(`[data-callsign="${CS}"]`)!;
    expect(row.textContent).toContain("Claude хочет выполнить npm test");
    expect(row.querySelector(".sb-badge")!.textContent).toBe("?");
    const u = await stand(parts());
    u.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    u.relay.push(perm({ title: undefined }));
    await flush();
    expect(u.$(`[data-callsign="${CS}"]`)!.textContent).toContain("Bash: npm test");
  });

  it("7138 · в «Вам» — ждущий вопрос: экран запроса прямо в карточке", async () => {
    const t = await stand([...parts(), { manifest: inboxM, module: createInbox() }]);
    t.relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === CS ? [{ ...perm(), type: undefined, from: undefined, to: undefined }] : [] });
    t.relay.push(perm());
    await flush();
    await t.go("#inbox");
    expect(t.$(`[data-kind="q"][data-callsign="${CS}"]`)!.textContent).toContain("Claude просит разрешения");
  });

  it("7131 · заголовок, инструмент, суть, заголовок SDK, причина и путь; кнопки — что можно ответить", async () => {
    const t = await opened(perm({ reason: "нет правила", blockedPath: "C:/x" }));
    const text = t.$(".ask")!.textContent!;
    expect(text).toContain("Claude просит разрешения");
    expect(t.$(".ask-chip")!.textContent).toBe("Bash");
    expect(t.$(".ask-subject")!.textContent).toBe("npm test");
    for (const s of ["Claude хочет выполнить npm test", "нет правила", "C:/x"]) expect(text).toContain(s);
    expect(t.$$(".ask button").map((b) => b.textContent)).toEqual(["Разрешить", "Разрешать всегда", "Отклонить"]);
  });

  it("7132 · без suggestions «Разрешать всегда» нет: разрешить навсегда можно только то, что предложил SDK", async () => {
    const t = await opened(perm({ suggestions: [] }));
    expect(t.$$(".ask button").map((b) => b.textContent)).toEqual(["Разрешить", "Отклонить"]);
  });

  it("7133 · «Разрешить» — answer allow; итог показан, кнопок больше нет", async () => {
    const t = await opened(perm());
    await t.press("Разрешить");
    expect(t.sent[0]).toMatchObject({ callsign: CS, question: "toolu_p1", action: "allow" });
    expect(t.sent[0].always).toBeUndefined();
    expect(t.$(".ask")!.textContent).toContain("Разрешить");
    expect(t.button("Разрешать всегда")).toBeUndefined();
  });

  it("7134 · «Разрешать всегда» — answer allow с always; своих правил клиент не шлёт", async () => {
    const t = await opened(perm());
    await t.press("Разрешать всегда");
    expect(t.sent[0]).toMatchObject({ action: "allow", always: true });
    expect(t.sent[0].updatedPermissions).toBeUndefined();
  });

  it("7135 · «Отклонить» открывает причину; с причиной — deny с message, без причины — deny без message; «Назад» возвращает кнопки", async () => {
    const t = await opened(perm());
    await t.press("Отклонить");
    expect(t.sent).toHaveLength(0);
    await t.press("Назад");
    expect(t.button("Разрешить")).toBeDefined();
    await t.press("Отклонить");
    await t.reason("не трогай");
    await t.press("Отклонить");
    expect(t.sent[0]).toMatchObject({ action: "deny", message: "не трогай" });
    const u = await opened(perm());
    await u.press("Отклонить");
    await u.press("Отклонить");
    expect(u.sent[0]).toMatchObject({ action: "deny" });
    expect(u.sent[0].message).toBeUndefined();
  });

  it("7136 · ответили с другого устройства: первый выигрывает, кнопок нет; ход прервали — вопрос снят", async () => {
    const t = await opened(perm());
    t.relay.push({ type: "answered", from: CS, question: "toolu_p1", by: "phone", action: "allow" });
    await flush();
    expect(t.$(".ask")!.textContent).toContain("Уже ответили с phone");
    expect(t.button("Разрешить")).toBeUndefined();
    const u = await opened(perm());
    u.relay.push({ type: "answered", from: CS, question: "toolu_p1", cancelled: true });
    await flush();
    expect(u.$(".ask")!.textContent).toContain("Вопрос снят");
  });

  it("7137 · отказ сети: слово на экране, кнопки остаются — можно ответить ещё раз", async () => {
    const t = await opened(perm());
    t.relay.handlers.answer = () => ({ ok: false, error: "offline" });
    await t.press("Разрешить");
    expect(t.$(".ask")!.textContent).toContain("Не отправлено: offline");
    expect(t.button("Разрешить")).toBeDefined();
  });
});

describe("план на одобрение", () => {
  it("7140 · текст плана разметкой и три кнопки; метка строки — план на одобрение", async () => {
    const t = await opened(plan());
    expect(t.$(".ask-plan h2")!.textContent).toBe("Шаги");
    expect(t.$(".ask-plan strong")!.textContent).toBe("Найти");
    expect(t.$$(".ask button").map((b) => b.textContent)).toEqual(["Одобрить", "Одобрить и разрешать правки", "Вернуть с замечаниями"]);
  });

  it("7141 · «Одобрить» — allow; «Одобрить и разрешать правки» — allow с always", async () => {
    const t = await opened(plan());
    await t.press("Одобрить");
    expect(t.sent[0]).toMatchObject({ question: "toolu_e1", action: "allow" });
    expect(t.sent[0].always).toBeUndefined();
    const u = await opened(plan());
    await u.press("Одобрить и разрешать правки");
    expect(u.sent[0]).toMatchObject({ action: "allow", always: true });
  });

  it("7142 · «Вернуть с замечаниями» — поле и deny с замечаниями", async () => {
    const t = await opened(plan());
    await t.press("Вернуть с замечаниями");
    await t.reason("добавь тест");
    await t.press("Вернуть");
    expect(t.sent[0]).toMatchObject({ action: "deny", message: "добавь тест" });
  });
});
