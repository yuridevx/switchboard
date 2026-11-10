// Комментарии к странице: клавиша, режим, черновик, пачка в журнал флота.
import { afterEach, describe, expect, it, vi } from "vitest";
import { drafts, isHotkey, nameOf, startComments } from "./comments.ts";

const key = (over: Partial<{ code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ code: "KeyC", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, ...over });

describe("клавиша комментариев", () => {
  it("Ctrl+C физической клавишей без выделения — режим; с выделением — копирование", () => {
    expect(isHotkey(key(), false)).toBe(true);
    expect(isHotkey(key(), true)).toBe(false);
    expect(isHotkey(key({ ctrlKey: false }), false)).toBe(false);
    expect(isHotkey(key({ code: "KeyV" }), false)).toBe(false);
    expect(isHotkey(key({ shiftKey: true }), false)).toBe(false);
  });
});

describe("имя элемента", () => {
  it("значок без текста называется подписью или адресом ссылки-предка", () => {
    document.body.innerHTML = `<a href="#/inbox" aria-label="Входящие"><svg id="i"></svg></a><a href="#/work"><svg id="j"></svg></a>`;
    expect(nameOf(document.querySelector("#i")!)).toBe("Входящие");
    expect(nameOf(document.querySelector("#j")!)).toBe("#/work");
    document.body.innerHTML = "";
  });
});

describe("пачка комментариев", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("Ctrl+С в русской раскладке, клик по элементу, текст — черновик; «Передать Claude» шлёт пачку и чистит черновики", async () => {
    document.body.innerHTML = `<main><button data-testid="target">Остановить</button></main>`;
    const send = vi.fn(async () => ({}));
    startComments(send);
    const target = document.querySelector("[data-testid=target]")!;
    const clicked = vi.fn();
    target.addEventListener("click", clicked);

    // русская раскладка: key — «с», code — KeyC
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "с", code: "KeyC", ctrlKey: true, bubbles: true }));
    expect(document.body.classList.contains("pc-on")).toBe(true);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).not.toHaveBeenCalled();

    const ta = document.querySelector<HTMLTextAreaElement>(".pc-pop textarea")!;
    ta.value = "кнопка слишком мелкая";
    document.querySelector<HTMLElement>('.pc-pop [data-a="ok"]')!.click();
    expect(drafts.read().map((n) => [n.text, n.where.element, n.where.selector])).toEqual([["кнопка слишком мелкая", "Остановить", 'main > button[data-testid="target"]']]);
    expect(document.body.classList.contains("pc-on")).toBe(false);

    document.querySelector<HTMLElement>('.pc-bar [data-pc="send"]')!.click();
    await vi.waitFor(() => expect(drafts.read()).toEqual([]));
    expect(send).toHaveBeenCalledTimes(1);
    const [, input] = send.mock.calls[0] as unknown as [unknown, { what: string; data: { comments: { text: string }[] } }];
    expect(input.what).toBe("comments");
    expect(input.data.comments.map((n) => n.text)).toEqual(["кнопка слишком мелкая"]);
  });

  it("отправка не удалась — черновики остаются", async () => {
    document.body.innerHTML = `<main><p>текст</p></main>`;
    drafts.write([{ id: "a", at: 1, text: "раз", where: { hash: "", selector: "main > p", element: "текст", w: 1, h: 1, theme: "", agent: "" } }]);
    const send = vi.fn(async () => { throw new Error("нет связи"); });
    startComments(send);
    document.querySelector<HTMLElement>('.pc-bar [data-pc="send"]')!.click();
    await vi.waitFor(() => expect(document.querySelector(".pc-list")?.textContent).toContain("нет связи"));
    expect(drafts.read()).toHaveLength(1);
  });
});
