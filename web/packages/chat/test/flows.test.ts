// Флоу web-chat по плану цикла тестов (web): вопрос над вводом, отказ ленты, пустой ввод, подмена аккаунта,
// широкий ввод (подсказка, вложения, задачи) и откат файлов.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import type { Roster } from "@switchboard/web-core";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

/** Флот home, у машин — session.call и session.files. */
function roster(tweak: (r: Roster) => void = () => {}): Roster {
  const r = homeRoster();
  for (const m of r.machines) m.contract = { ...m.contract, "session.call": 1, "session.files": 1 };
  tweak(r);
  return r;
}

function relayFor(r = roster(), messages: unknown[] = []) {
  const relay = new FakeRelay(r);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages, more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
  return relay;
}

/** Открыть чат сессии: узко — на весь экран, широко — справа от списка. */
async function chat(callsign: string, o: { relay?: FakeRelay; wide?: boolean } = {}) {
  const relay = o.relay ?? relayFor();
  const t = await stand(parts(), { relay, wide: o.wide, options: o.wide ? { beside: { card: "board", chat: "board", ask: "board" } } : {} });
  history.pushState(null, "", `/#chat?callsign=${encodeURIComponent(callsign)}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await flush();
  const type = async (text: string) => {
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = text;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const btn = (scope: string, text: string) => [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
  return { ...t, relay, type, btn };
}

const user = (uuid: string, text: string) => ({ type: "user", uuid, message: { content: text } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("лента", () => {
  it("4100 · телефон: вопрос сессии — полоса над вводом, нажатие открывает экран вопроса", async () => {
    const relay = relayFor(roster());
    relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "profiles@laptop" ? [{ question: "q1", kind: "ask", questions: [{ question: "База?", options: [{ label: "a" }, { label: "b" }] }] }] : [] });
    const t = await chat("profiles@laptop", { relay });
    expect(t.$(".chat-askbar")!.textContent).toBe("?База?Ответить");
    await t.click(t.$(".chat-askbar"));
    expect(location.hash).toBe("#ask?callsign=profiles%40laptop");
  });

  it("4101 · session.watch и session.history отказали — отказ виден словом, а не «Сообщений пока нет»; ввод работает", async () => {
    const relay = relayFor();
    relay.handlers["session.watch"] = () => ({ ok: false, error: "stopped" });
    relay.handlers["session.history"] = () => ({ ok: false, error: "stopped" });
    const t = await chat("site@laptop", { relay });
    expect(t.root.textContent).toContain("stopped");
    expect(t.$(".chat-feed")!.textContent).not.toContain("Сообщений пока нет");
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(relay.sent("session.prompt")).toHaveLength(1);
    expect(t.run.failed).toEqual({});
  });

  it("4104 · сменился account сессии — строка «⇄ аккаунт: было → стало», кадров нет", async () => {
    const r = roster((x) => (x.sessions[0].account = "infirex"));
    const relay = relayFor(r);
    const t = await chat("site@laptop", { relay, wide: true });
    const before = relay.got.length;
    relay.setRoster(roster((x) => (x.sessions[0].account = "yurianrun")));
    await flush();
    expect(t.$(".chat-sys.swap")!.textContent).toBe("⇄ аккаунт: infirex → yurianrun");
    expect(relay.got.length).toBe(before);
  });
});

describe("ввод", () => {
  it("4102 · Tab в пустом поле — подсказка Claude в поле, полоса подсказки пропала, кадров нет", async () => {
    const t = await chat("site@laptop", { wide: true });
    t.relay.push({ type: "session.events", from: "site@laptop", seq: 1, events: [{ type: "prompt_suggestion", suggestion: "Запусти тесты" }] });
    await flush();
    expect(t.$(".chat-hint")!.textContent).toBe("Подсказка: «Запусти тесты» — Tab");
    const before = t.relay.got.length;
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true }));
    await flush();
    expect(inp.value).toBe("Запусти тесты");
    expect(t.relay.got.length).toBe(before);
  });

  it("4103 · пустое сообщение — ↑ недоступна, Enter ничего не шлёт", async () => {
    const t = await chat("site@laptop");
    await t.type("   ");
    expect(t.$<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
    t.$(".chat-inp")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }));
    await flush();
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".chat-me")).toBeNull();
  });
});

describe("широкий ввод", () => {
  it("4105 · «■ Стоп» задачи — session.call stopTask; отказ — тост «callsign: метод — слово»", async () => {
    const relay = relayFor(roster(), [{ type: "system", subtype: "task_started", uuid: "s1", task_id: "task1", description: "фоновая сборка" }]);
    relay.handlers["session.call"] = () => ({ ok: false, error: "no_task" });
    const t = await chat("poe-bot@pc", { relay, wide: true });
    await t.click(t.btn(".chat-feed", "■ Стоп"));
    expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", method: "stopTask", args: ["task1"] })]);
    expect(t.$(".sb-toast")!.textContent).toBe("poe-bot@pc: stopTask — no_task");
  });

  it("4106 · вложение убрано до отправки — в session.prompt только оставшееся", async () => {
    const t = await chat("poe-bot@pc", { wide: true });
    const picker = t.$<HTMLInputElement>('.chat input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.txt", { type: "text/plain" })], configurable: true });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(10);
    await t.click(t.$('[aria-label="убрать a.png"]'));
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["b.txt✕"]);
    await t.type("смотри");
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")[0]).toMatchObject({ text: "смотри", attachments: [{ name: "b.txt", media_type: "text/plain", data: "Yg==" }] });
  });
});

describe("откат файлов", () => {
  const relayRw = (rw: (f: { args?: unknown[] }) => { ok: true; result: unknown } | { ok: false; error: string }) => {
    const relay = relayFor(roster(), [user("m1", "Почини сборку")]);
    relay.handlers["session.call"] = (f) => rw(f as { args?: unknown[] });
    return relay;
  };

  it("4107 · откатить нельзя — «Откатить нельзя: слово», кнопки «Откатить» нет", async () => {
    const t = await chat("poe-bot@pc", { relay: relayRw(() => ({ ok: true, result: { canRewind: false, error: "no checkpoint" } })), wide: true });
    await t.click(t.btn(".chat-feed", "↶ откатить файлы"));
    expect(t.$(".chat-rwc")!.textContent).toBe("Откатить нельзя: no checkpoint");
    expect(t.btn(".chat-rwc", "Откатить")).toBeNull();
    expect(t.relay.sent("session.call")).toHaveLength(1);
  });

  it("4108 · откат отказал — «Не откатилось: слово»", async () => {
    const t = await chat("poe-bot@pc", {
      relay: relayRw((f) => ((f.args as unknown[]).length === 2 ? { ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } } : { ok: false, error: "offline" })),
      wide: true,
    });
    await t.click(t.btn(".chat-feed", "↶ откатить файлы"));
    await t.click(t.btn(".chat-rwc", "Откатить"));
    expect(t.$(".chat-rwc")!.textContent).toBe("Не откатилось: offline");
  });

  it("4109 · «Отмена» после пробы — строка пробы убрана, отката нет", async () => {
    const t = await chat("poe-bot@pc", { relay: relayRw(() => ({ ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } })), wide: true });
    await t.click(t.btn(".chat-feed", "↶ откатить файлы"));
    await t.click(t.btn(".chat-rwc", "Отмена"));
    expect(t.$(".chat-rwc")).toBeNull();
    expect(t.relay.sent("session.call")).toHaveLength(1);
  });
});
