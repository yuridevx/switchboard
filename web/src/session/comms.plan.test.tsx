/// <reference types="node" />
// Эталоны страницы дизайна «Связь сессий и знание о флоте»: входящее от флота рисуется из поля peer — отправитель и вид словом;
// заполнение контекста берётся из строки сессии, запросов по таймеру у страницы сессии нет; в окне подъёма точки поле модели есть всегда.
import { notice, pointsList, pointsRaise, sessionCall, type ArchSession } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { useUi } from "../common.tsx";
import type { Mock } from "../mock/fleet.ts";
import { Raise } from "../screens/archive/Raise.tsx";
import { Steps } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";
import { Conversation } from "./Conversation.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

let mock: Mock;
// Mantine в режиме тестов (его штатный способ): без переходов; выпадающий список не прячется оттого, что в DOM без раскладки опорная кнопка «не видна»
function page(ui: ReactNode, at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider env="test"><Notifications /><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
}
/** Строка сессии в картине страницы: как её прислала бы машина. */
const setRow = (callsign: string, patch: object) => flush(() => useFleet.getState().apply({ type: "roster.delta", rev: 1e6 + Math.random(), sessions: [{ callsign, row: { ...useFleet.getState().sessions[callsign]!, ...patch } }] } as never));
const calls = (spy: { mock: { calls: unknown[][] } }, name: string, method?: string) => spy.mock.calls.filter(([def, input]) => (def as { name: string }).name === name && (!method || (input as { method?: string }).method === method));

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  // первый кадр мока: waitFor двигает часы теста, пока он не придёт
  await waitFor(() => new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  }));
  localStorage.clear();
  useUi.setState({ inspector: false });
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

describe("эталоны страницы «Связь сессий»", () => {
  it("входящее от флота — карточка своего вида: слово вида, отправитель-ссылка на его разговор; у тикета — номер и правило входа; у вопроса видно, чем на него ответили", async () => {
    // чьё: слово пользователя 16 нояб. — «нарисуй фронтенд карточки для всех новых форматов сообщения»; вид ставит машина, страница получает его полем
    page(<Conversation callsign="lead@laptop" />, "/work/lead@laptop");
    await screen.findByText(/старый клиент вызывается из/);
    const card = (name: string) => screen.getAllByRole("group", { name });
    const result = card("Итог от wing@laptop")[0]!;
    expect(result.className).toBe("pcard pk-result");
    expect(within(result).getByText("Итог").tagName).toBe("B");
    expect(within(result).getByRole("link", { name: "wing@laptop" }).getAttribute("href")).toBe("#/work/wing@laptop");
    expect(within(result).getByText(/старый клиент вызывается из/)).toBeTruthy();
    // сообщение соседа — без слова вида: отправителя достаточно
    const message = card("Сообщение от docs@laptop")[0]!;
    expect(message.className).toBe("pcard pk-message");
    expect(message.querySelector(".pcard-head b")).toBeNull();
    expect(card("Весть от wing@laptop")[0]!.className).toBe("pcard pk-news");
    // тикет от службы «Фабрика», заведённый событием правила входа: отправитель — служба, не ссылка; номер и правило — в шапке
    const ticket = card("Тикет от .factory")[0]!;
    expect(ticket.className).toBe("pcard pk-ticket");
    expect(within(ticket).queryByRole("link")).toBeNull();
    expect(ticket.querySelector(".pcard-ref")!.textContent).toBe("billing-12 · disk");
    // два вопроса ведомого: на первый эта сессия ответила инструментом answer, второй ещё ждёт; номер вопроса человеку не показываем
    const [answered, waiting] = card("Вопрос от wing@laptop");
    expect(answered!.querySelector(".pcard-answer")!.textContent).toBe("отвечено: оставить");
    expect(waiting!.querySelector(".pcard-answer")).toBeNull();
    expect(waiting!.textContent).not.toContain("q7");
    // строки вопроса стоят как пришли: варианты — каждый со своей строки
    expect(waiting!.querySelector(".pcard-plain")!.textContent).toBe("От какой ветки делать правку вызовов?\n· main — свежая, без обёртки\n· payments-wrap — с обёрткой");
    // тега в ленте нет: текст входящего — без обёртки
    expect(document.querySelector(".feed, body")!.textContent).not.toContain("<fleet");
  });

  it("весть о дочери приходит служебным запросом машины и встаёт в ленту словом «весть»", async () => {
    // чьё: дизайн — итог, вопрос и весть шлёт машина отправителя запросом notice; у инструмента message поля вида нет
    page(<Conversation callsign="lead@laptop" />, "/work/lead@laptop");
    await screen.findByText(/старый клиент вызывается из/);
    await waitFor(() => apiModule.api.call(notice, { to: "lead@laptop", kind: "news", text: "Ждёт ответа человека: разрешение — Bash: git push origin main." }));
    const news = (await screen.findByText(/git push origin main/)).closest(".pcard") as HTMLElement;
    expect(news.className).toBe("pcard pk-news");
    expect(news.getAttribute("aria-label")).toBe("Весть от @laptop");
  });

  it("заполнение контекста — из строки сессии; запросов сессии по таймеру нет", async () => {
    // чьё: факт журнала прода — 3 772 запроса за двое суток; гейт — опрос там, где есть событие
    const spy = vi.spyOn(apiModule.api, "call");
    page(<Conversation callsign="site@laptop" />, "/work/site@laptop");
    const row = await screen.findByRole("group", { name: "Документ сессии" });
    // окно модели — из каталога провайдера: 42% от миллиона токенов Fable
    const ring = await within(row).findByRole("button", { name: "Контекст 42% · сжать" });
    // модель ответила — машина прислала новую строку: кольцо следует за ней
    setRow("site@laptop", { cache: { ...useFleet.getState().sessions["site@laptop"]!.cache!, size: 870_000 } });
    await waitFor(() => expect(ring.getAttribute("aria-label")).toBe("Контекст 87% · сжать"));
    expect(ring.className).toContain("bad");
    // две минуты страница открыта: о занятости контекста у сессии она не спросила ни разу
    await flush(() => vi.advanceTimersByTimeAsync(120_000));
    expect(calls(spy, "session.call", "contextUsage")).toHaveLength(0);
    // нажатие по-прежнему сжимает разговор
    fireEvent.click(ring);
    await waitFor(() => expect(calls(spy, sessionCall.name, "compact")).toHaveLength(1));
  });

  it("окно подъёма: поле модели есть всегда; у точки без провайдера и модели оно пустое, с выбранной моделью подъём называет key и model", async () => {
    // чьё: факт — перенос 15 нояб., подъём такой точки отказывает key_required; устав — поля формы не прячутся
    const sessions = (await waitFor(() => apiModule.api.call(pointsList, {}))).sessions as ArchSession[];
    const fresh = sessions.find((s) => s.key && s.model)!, old = sessions.find((s) => !s.key)!;
    const spy = vi.spyOn(apiModule.api, "call");
    const first = page(<Raise kind="copy" s={fresh} onDone={() => {}} onClose={() => {}} />);
    // точка нового вида: поле заполнено из её документа
    await waitFor(() => expect(screen.getByRole("button", { name: /Модель/ }).textContent).toContain("Fable 5.2"));
    first.unmount();
    let raised = "";
    page(<Raise kind="copy" s={old} onDone={(c) => (raised = c)} onClose={() => {}} />);
    const field = screen.getByRole("button", { name: /Модель/ });
    expect(field.textContent).toContain("модель не выбрана");
    // без модели машина отказывает словом: причина видна в окне
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию" }));
    expect(await screen.findByText(/Назовите провайдера/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: /Модель/ }));
    // каталог моделей страница читает у службы ключей: список встаёт, когда он ответил
    fireEvent.click(await within(await screen.findByRole("listbox", { name: "Модели" })).findByText("Opus 5.5"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Модель/ }).textContent).toContain("Opus 5.5"));
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию" }));
    await waitFor(() => expect(raised).not.toBe(""));
    const sent = calls(spy, pointsRaise.name).map((c) => c[1] as { key?: string; model?: string });
    expect(sent.at(-1)).toMatchObject({ key: "claude", model: expect.stringMatching(/^claude-opus-5-5/) });
    expect(mock.state.sessions[raised]!.spec).toMatchObject({ key: "claude", model: expect.stringMatching(/^claude-opus-5-5/) });
  });
});
