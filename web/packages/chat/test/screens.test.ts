// Экраны чата в настоящем приложении на поддельном relay: галерея и запись не той формы.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];
const SECTIONS = ["Сообщения", "Ответ Claude", "Инструменты", "Служебные строки"];
const SESSION_FRAMES = /^session\.|^answer$/;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("галерея", () => {
  for (const [number, app, wide] of [["6750", "пульт", true], ["6752", "телефон", false]] as const) {
    it(`${number} · ${app}: четыре раздела, кадров сессиям нет`, async () => {
      const t = await stand(parts(), { url: "/#gallery", wide });
      await flush();
      expect(t.$$(".chat-gals h3").map((x) => x.textContent)).toEqual(SECTIONS);
      expect(t.relay.got.filter((f) => SESSION_FRAMES.test(f.type)).map((f) => f.type)).toEqual([]);
    });
  }

  it("6751 · каждый образец рисуется: в каждой строке есть карточка, экрана «выключена» нет", async () => {
    const t = await stand(parts(), { url: "/#gallery", wide: true });
    await flush();
    const rows = t.$$(".chat-galr");
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect(r.querySelector(".chat-galc")!.children.length, r.getAttribute("data-sample") ?? "").toBeGreaterThan(0);
    expect(t.run.failed).toEqual({});
    expect(t.root.textContent).not.toContain("выключена");
  });

  it("6753 · кнопки образцов молчат: кадров не прибавилось, карточки прежние", async () => {
    const t = await stand(parts(), { url: "/#gallery", wide: true });
    await flush();
    const before = t.relay.got.length;
    const row = t.$$(".chat-galr").length;
    const press = async (sample: string, text: string) => {
      const b = [...t.$(`[data-sample="${sample}"]`)!.querySelectorAll("button")].find((x) => x.textContent === text);
      await t.click(b ?? null);
    };
    await press("Команда идёт", "В фон");
    await press("Субагент идёт", "Стоп");
    await press("Ваше сообщение", "откатить файлы");
    expect(t.relay.got.length).toBe(before);
    expect(t.$$(".chat-galr").length).toBe(row);
    expect(t.run.failed).toEqual({});
  });

  it("6754 · до roster — экран подключения, образцов нет; после roster — галерея", async () => {
    const relay = new FakeRelay(homeRoster());
    const started = stand(parts(), { url: "/#gallery", wide: true, relay });
    // первый же такт, пока roster в пути: приложение знает только «подключаюсь»
    await Promise.resolve();
    const seen = document.body.textContent ?? "";
    expect(document.querySelector(".chat-gals")).toBeNull();
    const t = await started;
    await flush();
    expect(seen).not.toContain("Сообщения");
    expect(t.$$(".chat-gals h3")).toHaveLength(4);
  });
});

describe("запись не той формы", () => {
  it("6717 · вопрос и правки с входом не того вида: «Лента выключена» с причиной, другие экраны работают", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({
      ok: true,
      result: { more: false, messages: [{ type: "assistant", uuid: "a", message: { id: "a", content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: "строка" } }] } }] },
    });
    const t = await stand(parts(), { relay, url: "/#chat?callsign=site%40laptop" });
    await flush();
    expect(t.root.textContent).toContain("Лента выключена");
    expect(t.root.textContent).toContain("Перезапустить приложение");
    expect(t.run.failed["web-chat"]).toContain("экране chat");
    await t.go("#ask?callsign=site%40laptop");
    expect(t.run.failed["web-ask"]).toBeUndefined();
    expect(t.root.textContent).not.toContain("выключена");
  });
});
