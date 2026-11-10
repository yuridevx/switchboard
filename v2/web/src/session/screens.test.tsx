// Разговор с сессией на моке флота: вопрос, ввод, лента и шапка — как их видит человек.
import type { Ask, SessionRow } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { usePending } from "../common.tsx";
import type { Mock } from "../mock/fleet.ts";
import { useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { draft, type Talk } from "./talk.ts";

// страница без адреса флота говорит с моком; ?still — мок без своего таймера
vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  // поле ввода Mantine слушает загрузку шрифтов: в тестовой среде документа шрифтов нет
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

const T = Date.now();
let mock: Mock;

function page(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider></MantineProvider>);
}

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  usePending.setState({ items: {} });
  localStorage.clear();
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

const ask = (a: Partial<Ask>): Ask => ({ id: "q1", kind: "question", text: "Какую ветку?", at: T, ...a });
const pending = () => Object.values(usePending.getState().items);

describe("вопрос сессии", () => {
  it("несколько вопросов — карточка на каждый, все видны сразу; выбор нескольких — флажками; ответ собран по всем и уходит, когда отвечены все", () => {
    page(<AskCard callsign="site@laptop" ask={ask({ input: { questions: [{ question: "Ветка?", options: [{ label: "main" }, { label: "release" }] }, { question: "Что проверить?", multiSelect: true, options: [{ label: "тесты" }, { label: "снимки" }] }] } })} />);
    expect(screen.getByRole("group", { name: "Вопрос 1 из 2" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Вопрос 2 из 2" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ответить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "main" }));
    expect(pending()).toEqual([]);
    expect(screen.getByText("Отвечено 1 из 2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("тесты"));
    fireEvent.click(screen.getByLabelText("снимки"));
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    expect(pending()).toEqual(["site@laptop: отвечено «main; тесты, снимки»"]);
  });
  it("один вопрос с одним выбором уходит нажатием варианта; свой ответ — полем", () => {
    const { unmount } = page(<AskCard callsign="site@laptop" ask={ask({ options: [{ label: "main", about: "зелёный коммит" }, { label: "release" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "main" }));
    expect(pending()).toEqual(["site@laptop: отвечено «main»"]);
    unmount();
    usePending.setState({ items: {} });
    page(<AskCard callsign="site@laptop" ask={ask({ id: "q9", options: [{ label: "main" }] })} />);
    fireEvent.change(screen.getByLabelText("Свой ответ"), { target: { value: "hotfix" } });
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    expect(pending()).toEqual(["site@laptop: отвечено «hotfix»"]);
  });
  it("разрешение: слова для человека; отказ — с причиной; «Весь ввод» раскрывает ввод инструмента", () => {
    page(<AskCard callsign="deploy@server" ask={ask({ kind: "permission", text: "rm -rf dist", tool: "Bash", input: { command: "rm -rf dist", timeout: 5 }, options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }] })} />);
    expect(screen.getByRole("button", { name: "Разрешить" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Разрешать всегда" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Весь ввод" }));
    expect(screen.getByText(/"timeout": 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отклонить" }));
    fireEvent.change(screen.getByLabelText("Причина"), { target: { value: "не трогай dist" } });
    fireEvent.click(screen.getByRole("button", { name: "Отклонить" }));
    expect(pending()).toEqual(["deploy@server: отвечено «Отклонить: не трогай dist»"]);
  });
  it("план: «Одобрить и разрешать правки»", () => {
    page(<AskCard callsign="api@server" ask={ask({ kind: "plan", text: "## План\n\n1. Шаг", options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Одобрить и разрешать правки" }));
    expect(pending()).toEqual(["api@server: отвечено «Одобрить и разрешать правки»"]);
  });
});

describe("ввод", () => {
  const session = (): SessionRow => mock.state.sessions["docs@laptop"];
  const fake = (): Talk => ({ view: {} as never, events: [], loading: false, error: null, more: false, loadMore() {}, send: vi.fn(async () => true), cancel: vi.fn(async () => null), resend() {}, drop() {}, asides: [], aside: vi.fn(), dropAside() {} });
  it("«/» показывает команды сессии из списка SDK; черновик переживает уход; Enter отправляет; «/btw» спрашивает сбоку", async () => {
    const talk = fake();
    const { unmount } = page(<Composer s={session()} talk={talk} />);
    const box = screen.getByLabelText("Сообщение сессии") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/re" } });
    await waitFor(() => expect(screen.getByText("/review")).toBeTruthy());
    fireEvent.change(box, { target: { value: "Допиши раздел" } });
    expect(draft.get("docs@laptop")).toBe("Допиши раздел");
    unmount();
    page(<Composer s={session()} talk={talk} />);
    const again = screen.getByLabelText("Сообщение сессии") as HTMLTextAreaElement;
    expect(again.value).toBe("Допиши раздел");
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(talk.send).toHaveBeenCalledWith("Допиши раздел", undefined, undefined));
    expect(draft.get("docs@laptop")).toBe("");
    fireEvent.change(again, { target: { value: "/btw а ссылки проверены?" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(talk.aside).toHaveBeenCalledWith("а ссылки проверены?"));
  });
  it("подсказка следующего сообщения берётся кликом; у занятой сессии — срочность и «Прервать»", () => {
    const { unmount } = page(<Composer s={session()} talk={fake()} hint="Покажи, что изменилось" />);
    fireEvent.click(screen.getByText("Покажи, что изменилось"));
    expect((screen.getByLabelText("Сообщение сессии") as HTMLTextAreaElement).value).toBe("Покажи, что изменилось");
    unmount();
    page(<Composer s={mock.state.sessions["site@laptop"]} talk={fake()} />);
    expect(screen.getByLabelText("Когда взять сообщение")).toBeTruthy();
    expect(screen.getAllByText("Прервать").length).toBeGreaterThan(0);
  });
});

describe("разговор на моке", () => {
  it("лента, действующая модель в шапке, список дел и своё сообщение со статусом «в очереди» и отменой", async () => {
    page(<Conversation callsign="site@laptop" />);
    await waitFor(() => expect(screen.getByText(/Шапка больше не ломается/)).toBeTruthy(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByLabelText("Модель").textContent).toContain("Fable 5.2"));
    const box = screen.getByLabelText("Сообщение сессии");
    fireEvent.change(box, { target: { value: "И подвал тоже" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/в очереди, уйдёт после хода/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(screen.getByText(/снято с очереди/)).toBeTruthy());
  });
  it("сессия со сбоем: карточка «не запустилась» с «Почему» открывает журнал сессии", async () => {
    page(<Conversation callsign="hotfix@laptop" />);
    await waitFor(() => expect(screen.getByText("Сессия не запустилась")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Почему" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Журнал" }).getAttribute("aria-selected")).toBe("true"));
  });
});
