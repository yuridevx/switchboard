// Вторая итерация на моке флота: пара, вложения, итог вопроса, «Работа» и «Вам» — как их видит человек.
import type { Ask, SessionRow } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { usePending, useUi } from "../common.tsx";
import { getLocal, setLocal } from "../lib/local.ts";
import type { Mock } from "../mock/fleet.ts";
import { Work } from "../screens/Work.tsx";
import { useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Conversation, HEAD_DEFAULT, pairKey } from "./Conversation.tsx";
import { Diff, Pics, TodoList } from "./Feed.tsx";
import { HtmlFrame } from "./html.tsx";
import { Inspector } from "./Inspector.tsx";
import type { Talk } from "./talk.ts";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

const T = Date.now();
let mock: Mock;

function page(ui: ReactNode, at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter></QueryClientProvider></MantineProvider>);
}

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  usePending.setState({ items: {} });
  localStorage.clear();
  // настройки устройства — как у нового человека
  for (const [k, v] of [["work.filter", "mine"], ["work.view", "list"], ["work.closed", []], ["work.group", "project"], ["work.nested", true], ["head.parts", HEAD_DEFAULT], [pairKey("lead@laptop"), "lead"]] as const) setLocal(k, v as never);
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

const session = (c: string): SessionRow => mock.state.sessions[c]!;
const fakeTalk = (): Talk => ({ view: {} as never, events: [], loading: false, error: null, more: false, loadMore() {}, send: vi.fn(async () => true), cancel: vi.fn(async () => null), resend() {}, drop() {}, asides: [], aside: vi.fn(), dropAside() {} });

describe("ввод: вложения и возврат текста", () => {
  it("картинка до отправки видна превью, документ — именем; крестик убирает вложение", async () => {
    page(<Composer s={session("docs@laptop")} talk={fakeTalk()} />);
    const box = screen.getByLabelText("Сообщение сессии");
    const pic = new File([new Uint8Array([137, 80, 78, 71])], "снимок.png", { type: "image/png" });
    const doc = new File(["текст"], "заметки.txt", { type: "text/plain" });
    fireEvent.paste(box, { clipboardData: { files: [pic, doc] } });
    await waitFor(() => expect(screen.getByAltText("снимок.png")).toBeTruthy());
    expect((screen.getByAltText("снимок.png") as HTMLImageElement).src).toMatch(/^blob:/);
    expect(screen.getByText("заметки.txt")).toBeTruthy();
    expect(screen.queryByAltText("заметки.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Убрать снимок.png" }));
    expect(screen.queryByAltText("снимок.png")).toBeNull();
    expect(screen.getByText("заметки.txt")).toBeTruthy();
  });
  it("отменённое сообщение возвращается в поле, не затирая набранное; кнопки «/ команды» нет — хватает слеша в поле", async () => {
    const ref = createRef<ComposerHandle>();
    page(<Composer ref={ref} s={session("docs@laptop")} talk={fakeTalk()} />);
    const box = screen.getByLabelText("Сообщение сессии") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "уже пишу" } });
    flush(() => ref.current!.giveBack("проверь ссылки"));
    expect(box.value).toBe("уже пишу\nпроверь ссылки");
    expect(screen.queryByRole("button", { name: "Команды сессии" })).toBeNull();
  });
});

describe("лента: картинки, правка, документ, список дел", () => {
  it("картинка ленты открывается в новой вкладке своим адресом страницы, а не адресом с данными", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    page(<Pics pics={["data:image/png;base64,iVBORw0KGgo="]} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть картинку в новой вкладке" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toMatch(/^blob:/);
  });
  it("правка: общий кусок свёрнут строкой с числом; нажатие раскрывает правку целиком", () => {
    const before = Array.from({ length: 12 }, (_, i) => `строка ${i}`).join("\n");
    page(<Diff before={before} after={before.replace("строка 11", "новая 11")} />);
    expect(screen.getByRole("button", { name: /9 строк без изменений/ })).toBeTruthy();
    expect(screen.queryByText(/строка 3/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /9 строк без изменений/ }));
    expect(screen.getByText(/строка 3/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /без изменений/ })).toBeNull();
  });
  it("документ HTML, ушедший на другую страницу, снимается; «Показать снова» возвращает его", () => {
    page(<HtmlFrame html="<p>привет</p>" title="док" />);
    const frame = () => document.querySelector("iframe");
    fireEvent.load(frame()!);
    expect(frame()).toBeTruthy();
    fireEvent.load(frame()!);
    expect(frame()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Показать снова" }));
    expect(frame()).toBeTruthy();
  });
  it("список дел над вводом свёрнут до «N из M» и текущего дела; раскрывается списком и сворачивается обратно", () => {
    const todos = [{ content: "прочитать", status: "completed" }, { content: "править", activeForm: "Правлю шапку", status: "in_progress" }, { content: "проверить", status: "pending" }];
    page(<TodoList todos={todos} fold />);
    expect(screen.getByRole("button", { name: "Список дел" }).textContent).toContain("1 из 3");
    expect(screen.getByText(/Правлю шапку/)).toBeTruthy();
    expect(screen.queryByText(/проверить/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Список дел" }));
    expect(screen.getByText(/проверить/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /свернуть/ }));
    expect(screen.queryByText(/проверить/)).toBeNull();
  });
});

describe("вопрос: кто видит и кто ответил", () => {
  const ask = (a: Partial<Ask>): Ask => ({ id: "q1", kind: "question", text: "Какую ветку?", at: T, options: [{ label: "main" }], ...a });
  it("под вопросом — «Вопрос видят: …»", () => {
    page(<AskCard callsign="site@laptop" ask={ask({ to: "~yuri@example.com", seen: ["pult~yuri@example.com", "pult~anya@example.com"] })} />);
    expect(screen.getByText("Вопрос видят: вы (pult), pult anya")).toBeTruthy();
  });
  it("отвеченный вопрос остаётся в ленте карточкой: вопрос, варианты, выбранный выделен, кто ответил", async () => {
    page(<Conversation callsign="site-tests@laptop" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "main" })).toBeTruthy());
    const id = session("site-tests@laptop").ask!.id;
    await flush(async () => void (await mock.transport.call({ type: "answer", id: "r1", to: "site-tests@laptop", ask: id, answer: { answers: { "Какую ветку выкладывать на тестовый стенд?": "main" } } })));
    const card = await screen.findByRole("group", { name: "Отвеченный вопрос" });
    expect(card.textContent).toContain("Какую ветку выкладывать на тестовый стенд?");
    const chosen = [...card.querySelectorAll(".asked-opt[aria-current]")].map((e) => e.textContent);
    expect(chosen).toEqual(["main"]);
    expect(card.querySelectorAll(".asked-opt").length).toBeGreaterThan(1);
    expect(within(card).getByText(/^ответил /)).toBeTruthy();
    expect(screen.queryByText(/отвечено: main/)).toBeNull();
  });
});

describe("пара", () => {
  it("шапка пары одна на обоих: два участника с лампой, именем и делом; показанный ещё раз — обе стороны, ведущий слева; инспектор при «обе» открывается у одной стороны и закрытие возвращает обе", async () => {
    page(<Routes><Route path="/work/:c" element={<Conversation callsign="lead@laptop" />} /></Routes>, "/work/lead@laptop");
    const bar = await screen.findByRole("group", { name: "Пара" });
    expect(document.querySelectorAll(".conv")).toHaveLength(1);
    // своей шапки у колонки нет — участники не повторяются
    expect(document.querySelector(".conv .conv-head")).toBeNull();
    const lead = within(bar).getByRole("button", { name: "Ведущий lead@laptop" }), wing = within(bar).getByRole("button", { name: "Ведомый wing@laptop" });
    expect(lead.getAttribute("aria-pressed")).toBe("true");
    expect(wing.getAttribute("aria-pressed")).toBe("false");
    // скрытая сторона видна в шапке: кто и чем занят
    expect(wing.textContent).toContain("Читает src/jobs/renew.ts");
    useUi.setState({ inspector: false });
    fireEvent.click(lead);
    await waitFor(() => expect(document.querySelectorAll(".conv")).toHaveLength(2));
    expect(getLocal(pairKey("lead@laptop"), "lead")).toBe("both");
    expect([...document.querySelectorAll(".conv")].map((e) => e.getAttribute("data-conv"))).toEqual(["lead@laptop", "wing@laptop"]);
    expect(wing.getAttribute("aria-pressed")).toBe("true");
    // инспектор стороны ведомого: остаётся её разговор и инспектор; закрытие — снова обе
    const insp = () => within(document.querySelector('[data-conv="wing@laptop"]') as HTMLElement).getByRole("button", { name: "Инспектор" });
    fireEvent.click(insp());
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Инспектор" })).toBeTruthy());
    expect([...document.querySelectorAll(".conv")].map((e) => e.getAttribute("data-conv"))).toEqual(["wing@laptop"]);
    expect(lead.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(insp());
    await waitFor(() => expect(document.querySelectorAll(".conv")).toHaveLength(2));
    expect(screen.queryByRole("complementary", { name: "Инспектор" })).toBeNull();
  });
  it("все действия разговора — в ряду под полем ввода; в шапке их нет; фокус — значком, сжатие — кольцом занятости контекста", async () => {
    page(<Conversation callsign="site@laptop" />);
    const acts = await screen.findByRole("group", { name: "Действия" });
    for (const name of ["Фокус", "Инспектор", "Ещё", "Очистить"]) expect(within(acts).getByRole("button", { name })).toBeTruthy();
    expect(document.querySelector(".conv-head")!.querySelectorAll("button:not(.namebtn)")).toHaveLength(0);
    const ring = await within(acts).findByRole("button", { name: /^Контекст \d+% · сжать$/ });
    expect(ring.textContent).toMatch(/^\d+%$/);
    const focus = within(acts).getByRole("button", { name: "Фокус" });
    expect(focus.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(focus);
    expect(focus.getAttribute("aria-pressed")).toBe("true");
  });
  it("«Обзор» и «Журнал» инспектора у пары — в две колонки: ведущий и ведомый", async () => {
    page(<Inspector s={session("lead@laptop")} other={session("wing@laptop")} tab="doc" />);
    const kv = await screen.findByLabelText("Пара");
    expect(within(kv).getByText("ведущий")).toBeTruthy();
    expect(within(kv).getByText("▸ ведомый")).toBeTruthy();
    expect(within(kv).getByText("Состояние")).toBeTruthy();
    cleanup();
    page(<Inspector s={session("lead@laptop")} other={session("wing@laptop")} tab="log" />);
    await waitFor(() => expect(document.querySelectorAll(".pairlog > div")).toHaveLength(2));
    expect(document.querySelector(".pairlog")!.textContent).toContain("▸ wing@laptop");
  });
  it("в «Работе» пара — одной строкой «ведущий ▸ ведомый»; своей строки у ведомого нет; строка объясняет, почему она моя", async () => {
    setLocal("work.filter", "all");
    page(<Routes><Route path="*" element={<Work />} /></Routes>, "/work");
    const list = within(await screen.findByLabelText("Работа"));
    await waitFor(() => expect(list.getByText("Замена клиента оплаты")).toBeTruthy());
    const lead = document.querySelector('[aria-label="Работа"] [data-call="lead@laptop"]')!;
    expect(lead.textContent).toContain("▸");
    expect(lead.textContent).toContain("Поиск вызовов старого клиента");
    expect(document.querySelector('[aria-label="Работа"] [data-call="wing@laptop"]')).toBeNull();
    expect(lead.getAttribute("title")).toBe("вы открыли");
  });
});
