/// <reference types="node" />
// Сценарии плана тестов страницы — разговор: шаг отката, очистка, машина без связи, отложенный ответ на вопрос.
import { answer, CallError, sessionHistory, sessionRewind, sessionUpdate } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { UNDO_MS, usePending } from "../common.tsx";
import { setLocal } from "../lib/local.ts";
import type { Mock } from "../mock/fleet.ts";
import { Steps } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Conversation, HEAD_DEFAULT } from "./Conversation.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

let mock: Mock;
// экран — тот же путь; чистку «?do=» из адреса делает оболочка по настоящему адресу окна — её держит живой сценарий live-talk
const At = () => <output data-testid="at">{useLocation().pathname}</output>;
function talkAt(callsign: string, extra?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/work/${callsign}`]}>
      <At /><Steps />{extra}
      <Routes><Route path="/work/:c" element={<Conversation callsign={callsign} />} /></Routes>
    </MemoryRouter></QueryClientProvider></MantineProvider>,
  );
}
const history = async (c: string) => (await apiModule.api.call(sessionHistory, { to: c, limit: 200 })).events;
const box = () => screen.getByLabelText("Сообщение сессии") as HTMLTextAreaElement;
/** Открыть шаг отката у последнего сообщения человека в ленте. */
async function openRewind() {
  const links = await screen.findAllByRole("button", { name: /^Откатить сюда/ });
  fireEvent.click(links.at(-1)!);
  await screen.findByRole("radiogroup", { name: "Что откатить" });
}
/** Подменить ответ на session.rewind: пробу (dry) или сам откат; остальное идёт в мок. */
function stubRewind(on: "dry" | "real", reply: () => unknown) {
  const real = apiModule.api.call.bind(apiModule.api);
  return vi.spyOn(apiModule.api, "call").mockImplementation(((def: any, input: any) => (def === sessionRewind && !!input.dry === (on === "dry") ? Promise.resolve().then(reply) : real(def, input))) as never);
}

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  usePending.setState({ items: {} });
  localStorage.clear();
  setLocal("head.parts", HEAD_DEFAULT as never);
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), vi.useRealTimers(), mock.stop()));

describe("шаг отката", () => {
  it("1 · откат идёт в том же окне: адрес прежний, записей после выбранного сообщения нет, в ленте строка отката, текст — в поле ввода", async () => {
    // источник: слово пользователя «тут важно чтобы то же окно откатилось до сообщения»
    talkAt("docs@laptop");
    const before = await history("docs@laptop");
    await openRewind();
    await screen.findByText(/Из разговора уйдёт записей/);
    fireEvent.click(screen.getByRole("button", { name: "Откатить" }));
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Что откатить" })).toBeNull());
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/docs@laptop"));
    await waitFor(() => expect(box().value.length).toBeGreaterThan(0));
    const after = await history("docs@laptop");
    expect(after.length).toBeLessThan(before.length);
    // текст вернувшегося сообщения в разговоре больше не стоит: оно и всё после него ушло
    expect(after.some((e: any) => e.message?.content === box().value)).toBe(false);
    await waitFor(() => expect(screen.getByText(/^Откат к «/)).toBeTruthy());
  });

  it("2 · шаг показывает, что уйдёт, до нажатия: текст сообщения, число записей, при «Разговор и файлы» — файлы и строки; разговор цел", async () => {
    // источник: слово пользователя «видеть превью»
    talkAt("docs@laptop");
    const before = (await history("docs@laptop")).length;
    await openRewind();
    const cut = await screen.findByText(/Из разговора уйдёт записей/);
    expect(Number(within(cut).getByText(/^\d+$/).textContent)).toBeGreaterThan(0);
    expect(screen.queryByText("src/components/Header.tsx")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Разговор и файлы" }));
    expect(await screen.findByText("src/components/Header.tsx")).toBeTruthy();
    expect(screen.getByText("+41")).toBeTruthy();
    expect(screen.getByText("−17")).toBeTruthy();
    expect((await history("docs@laptop")).length).toBe(before);
  });

  it("3 · вариантов два — «Только разговор» и «Разговор и файлы»; «только файлы» нет", async () => {
    // источник: слово пользователя «Вариант “только файлы” … убрать»
    talkAt("docs@laptop");
    await openRewind();
    const group = screen.getByRole("radiogroup", { name: "Что откатить" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).labels?.[0]?.textContent ?? r.getAttribute("aria-label"))).toEqual(["Только разговор", "Разговор и файлы"]);
  });

  it("4 · «Разговор и файлы»: откат уходит с files: true, строка отката в ленте называет число возвращённых файлов", async () => {
    // источник: слово пользователя «откатить файл и чат»
    talkAt("docs@laptop");
    await openRewind();
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.click(screen.getByRole("radio", { name: "Разговор и файлы" }));
    await screen.findByText("src/components/Header.tsx");
    fireEvent.click(screen.getByRole("button", { name: "Откатить" }));
    await waitFor(() => expect(screen.getByText(/файлы возвращены: 3/)).toBeTruthy());
    const sent = spy.mock.calls.filter(([def, input]) => def === sessionRewind && !(input as any).dry).map(([, input]) => input);
    expect(sent).toMatchObject([{ to: "docs@laptop", files: true }]);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/docs@laptop"));
  });

  it("5 · откат посреди хода предупреждает, что ход прервётся; у свободной сессии строки нет", async () => {
    // источник: дизайн «Откат и ведомый», находка критика принята
    talkAt("site@laptop");
    await openRewind();
    await screen.findByText(/Из разговора уйдёт записей/);
    expect(screen.getByText("Текущий ход прервётся")).toBeTruthy();
    cleanup();
    talkAt("docs@laptop");
    await openRewind();
    await screen.findByText(/Из разговора уйдёт записей/);
    expect(screen.queryByText("Текущий ход прервётся")).toBeNull();
  });

  it("6 · снимка файлов нет — вариант «Разговор и файлы» недоступен, причина названа", async () => {
    // источник: устав «система ловит»: отказать и назвать причину
    stubRewind("dry", () => ({ cut: 3, text: "проверь ссылки", nofiles: "снимка файлов у этого сообщения нет" }));
    talkAt("docs@laptop");
    await openRewind();
    expect(await screen.findByText("Файлы к этому сообщению не вернуть: снимка файлов у этого сообщения нет")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Разговор и файлы" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Только разговор" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("7 · откат отклонён — шаг остаётся открытым, разговор и поле ввода прежние", async () => {
    // источник: чьё: код (act вернул пусто — onDone не зовётся)
    talkAt("docs@laptop");
    const before = (await history("docs@laptop")).length;
    await openRewind();
    await screen.findByText(/Из разговора уйдёт записей/);
    stubRewind("real", () => { throw new CallError("busy", "ход не прервался за 30 с"); });
    fireEvent.click(screen.getByRole("button", { name: "Откатить" }));
    await flush(() => new Promise((r) => setTimeout(r, 60)));
    expect(screen.getByRole("radiogroup", { name: "Что откатить" })).toBeTruthy();
    expect(box().value).toBe("");
    expect((await history("docs@laptop")).length).toBe(before);
  });
});

describe("ряд под полем ввода", () => {
  it("8 · «Очистить» — страница подтверждения; до подтверждения разговор цел, после — в ленте «Разговор очищен»", async () => {
    // источник: слово пользователя «возможностью очистить»; подтверждение страницей — «против попапов»
    talkAt("docs@laptop");
    const before = (await history("docs@laptop")).length;
    fireEvent.click(await screen.findByRole("button", { name: "Очистить" }));
    const head = await screen.findByRole("heading", { name: "Очистить разговор docs@laptop?" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect((await history("docs@laptop")).length).toBe(before);
    const step = head.closest("section") ?? document.body;
    fireEvent.click(within(step as HTMLElement).getByRole("button", { name: /^Очистить/ }));
    await waitFor(() => expect(screen.getByText("Разговор очищен")).toBeTruthy());
  });

  it("9 · машина без связи — поля ввода нет, «Инспектор» и «Ещё» на месте", async () => {
    // источник: чьё: код
    talkAt("crawler@base2");
    const acts = await screen.findByRole("group", { name: "Действия" });
    expect(screen.queryByLabelText("Сообщение сессии")).toBeNull();
    for (const name of ["Инспектор", "Ещё"]) expect(within(acts).getByRole("button", { name })).toBeTruthy();
    expect(screen.getByText(/без связи с/)).toBeTruthy();
  });
});

describe("ведомый значком в ряду", () => {
  it("11 · «Открыть ведомого» открывает пару одним запросом; «Убрать ведомого» — страницей подтверждения, до неё ведомый на месте", async () => {
    // источник: слово пользователя «все значки действий — в одном месте»; подтверждение страницей — «против попапов»
    // соединение остаётся открытым: строка сессии с ведомым доходит до страницы
    const link = mock.transport.open("page", { onFrame: (f) => useFleet.getState().apply(f) });
    talkAt("docs@laptop");
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть ведомого" }));
    const drop = await screen.findByRole("button", { name: "Убрать ведомого" });
    expect(spy.mock.calls.filter(([def]) => def === sessionUpdate).map(([, input]) => input)).toMatchObject([{ to: "docs@laptop", pair: true }]);
    const wing = mock.state.sessions["docs@laptop"]!.spec.wing!;
    expect(mock.state.sessions[wing]).toBeTruthy();
    fireEvent.click(drop);
    const head = await screen.findByRole("heading", { name: `Убрать ведомого ${wing}?` });
    expect(mock.state.sessions["docs@laptop"]!.spec.wing).toBe(wing);
    fireEvent.click(within(head.closest("section") as HTMLElement).getByRole("button", { name: /^Убрать/ }));
    await waitFor(() => expect(mock.state.sessions["docs@laptop"]!.spec.wing).toBeUndefined());
    await screen.findByRole("button", { name: "Открыть ведомого" });
    link.close();
  });
});

describe("карточка вопроса", () => {
  it("12 · вопросы сессии стоят карточками в прокрутке ленты, а не над полем ввода", async () => {
    // источник: слово пользователя «вопросы должны быть карточками чата… раньше вылазило за экран без скролла»; высоту держит живой сценарий
    talkAt("survey@laptop");
    await waitFor(() => expect(document.querySelectorAll(".feed .askcard").length).toBeGreaterThan(1));
    expect(document.querySelectorAll(".dock .askcard")).toHaveLength(0);
  });

  it("13 · на вопрос уже ответили в другом месте — отказ словом на странице", async () => {
    // источник: устав «первый ответ выигрывает», «ошибки — словами»
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const real = apiModule.api.call.bind(apiModule.api);
    vi.spyOn(apiModule.api, "call").mockImplementation(((def: any, input: any) => (def === answer ? Promise.reject(new CallError("already_answered", "на вопрос ответил phone~yuri")) : real(def, input))) as never);
    const ask = mock.state.sessions["site-tests@laptop"]!.ask!;
    render(<MantineProvider><Notifications /><AskCard callsign="site-tests@laptop" ask={ask} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^main/ }));
    await flush(() => vi.advanceTimersByTimeAsync(UNDO_MS + 200));
    await waitFor(() => expect(screen.getByText(/на вопрос ответил phone~yuri/)).toBeTruthy());
  });

  it("10 · ответ уходит не сразу: до срока его отменяют — запрос не ушёл; без отмены уходит по сроку", async () => {
    // источник: чьё: код (UNDO_MS)
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(apiModule.api, "call");
    const answers = () => spy.mock.calls.filter(([def]) => (def as { name: string }).name === "answer");
    const ask = mock.state.sessions["site-tests@laptop"]!.ask!;
    const view = render(<MantineProvider><Notifications /><AskCard callsign="site-tests@laptop" ask={ask} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^main/ }));
    expect(Object.keys(usePending.getState().items)).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Отменить" }));
    await flush(() => vi.advanceTimersByTimeAsync(UNDO_MS + 100));
    expect(answers()).toHaveLength(0);
    expect(Object.keys(usePending.getState().items)).toHaveLength(0);
    // второй раз — без отмены
    view.rerender(<MantineProvider><Notifications /><AskCard callsign="site-tests@laptop" ask={ask} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^main/ }));
    await flush(() => vi.advanceTimersByTimeAsync(UNDO_MS - 500));
    expect(answers()).toHaveLength(0);
    await flush(() => vi.advanceTimersByTimeAsync(600));
    expect(answers().map(([, input]) => input)).toMatchObject([{ to: "site-tests@laptop", ask: ask.id }]);
  });
});
