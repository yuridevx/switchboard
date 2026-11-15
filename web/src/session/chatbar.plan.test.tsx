/// <reference types="node" />
// Эталоны страницы дизайна «Низ разговора»: пока идёт ход, срочностей две и обе — кнопками; ждущее сообщение помечено «в очереди»;
// значения сессии — ряд значков; панель сессии открывается кнопкой. Эталон ширин ряда (366, 417 и 736 px) держит сценарий docs/designs/v2-chatbar/shots.mjs в браузере.
import { message, Priority } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { useUi } from "../common.tsx";
import type { Mock } from "../mock/fleet.ts";
import { Steps } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";
import { Conversation } from "./Conversation.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

let mock: Mock;
function page(ui: ReactNode, at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><Notifications /><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
}
const sent = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === message).map((c) => c[1] as { to: string; text: string; priority?: string });
/** Открыть разговор и набрать текст в поле ввода. */
async function typed(callsign: string, text: string) {
  page(<Conversation callsign={callsign} />, `/work/${callsign}`);
  const box = await screen.findByLabelText("Сообщение сессии");
  fireEvent.change(box, { target: { value: text } });
  return box;
}

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  localStorage.clear();
  // панель — как у только что загруженной страницы
  useUi.setState({ inspector: false });
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

describe("эталоны страницы «Низ разговора»", () => {
  it("1 · идёт ход, текст, Enter — запрос «сообщение» без срочности; сообщение стоит в очереди", async () => {
    // чьё: слово пользователя — срочностей две, «следующим» — по умолчанию
    expect(mock.state.sessions["site@laptop"]!.state).toBe("busy");
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.keyDown(await typed("site@laptop", "И подвал тоже"), { key: "Enter" });
    await waitFor(() => expect(sent(spy)).toHaveLength(1));
    expect(sent(spy)[0]).toEqual({ to: "site@laptop", text: "И подвал тоже" });
    await waitFor(() => expect(screen.getAllByText("в очереди").length).toBeGreaterThan(0));
  });

  it("2 · идёт ход, текст, молния — запрос «сообщение» со срочностью now: ход прерван, сообщение взято", async () => {
    // чьё: слово пользователя — «сейчас» остаётся второй срочностью
    const spy = vi.spyOn(apiModule.api, "call");
    await typed("site@laptop", "Стоп, сначала подвал");
    fireEvent.click(screen.getByRole("button", { name: "Отправить сейчас" }));
    await waitFor(() => expect(sent(spy)).toHaveLength(1));
    expect(sent(spy)[0]).toEqual({ to: "site@laptop", text: "Стоп, сначала подвал", priority: "now" });
    // подделка флота отвечает как Host: занятая сессия — queued, и сразу «ход взял»; пометки «в очереди» не остаётся
    await waitFor(() => expect(screen.getByText("Стоп, сначала подвал")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("в очереди")).toBeNull());
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
  });

  it("3 · сообщение отправлено стрелкой и ждёт в ленте — пометка «в очереди» и «Отменить»; слов «после хода» в пометке нет", async () => {
    // чьё: слово пользователя — «слишком долго держит»: третьей срочности нет ни в договоре, ни в словах страницы
    await typed("site@laptop", "И подвал тоже");
    fireEvent.click(screen.getByRole("button", { name: "Отправить следующим" }));
    await waitFor(() => expect(screen.getAllByText("в очереди").length).toBeGreaterThan(0));
    const note = screen.getAllByText("в очереди")[0]!;
    expect(within(note).getByRole("button", { name: "Отменить" })).toBeTruthy();
    expect(note.textContent).not.toMatch(/после хода/);
    // набор срочностей объявлен один раз — в договоре: их две
    expect(Priority.options).toEqual(["now", "next"]);
  });

  it("5 · разговор открыт на широком экране — панели справа нет; кнопка открывает её, ещё раз — закрывает", async () => {
    // чьё: слово пользователя — «правая панель бесполезная в ежедневной работе, её не надо держать включённой»
    page(<Conversation callsign="docs@laptop" />, "/work/docs@laptop");
    const button = await within(await screen.findByRole("group", { name: "Действия" })).findByRole("button", { name: "Инспектор" });
    expect(screen.queryByRole("complementary", { name: "Инспектор" })).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Инспектор" })).toBeTruthy());
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Инспектор" })).toBeNull());
  });

  it("6 · сессия свободна — кнопка отправки одна, молнии и «Прервать ход» нет", async () => {
    // чьё: код
    expect(mock.state.sessions["docs@laptop"]!.state).toBe("idle");
    const spy = vi.spyOn(apiModule.api, "call");
    await typed("docs@laptop", "Допиши раздел");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeTruthy();
    for (const name of ["Отправить сейчас", "Отправить следующим", "Прервать ход"]) expect(screen.queryByRole("button", { name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(sent(spy)).toHaveLength(1));
    expect(sent(spy)[0]).toEqual({ to: "docs@laptop", text: "Допиши раздел" });
  });

  it("ряд под полем ввода — значки: режим, модель, усилие, кусочки, контекст и час кэша; настройки «Поля под вводом» нет; на телефоне значения меняются здесь же", async () => {
    // чьё: слово пользователя — «очень сжато, много текста перекрывает друг друга»; значение словом — в подсказке
    page(<Conversation callsign="site@laptop" />, "/work/site@laptop");
    const row = await screen.findByRole("group", { name: "Документ сессии" });
    expect(within(row).getByRole("button", { name: "Режим" }).getAttribute("title")).toBe("Режим: разрешено всё");
    expect(within(row).getByRole("button", { name: "Режим" }).textContent).toBe("");
    expect(within(row).getByRole("button", { name: "Усилие" }).getAttribute("title")).toMatch(/^Усилие: /);
    expect(within(row).getByRole("button", { name: "Усилие" }).querySelectorAll("svg.effort rect")).toHaveLength(5);
    expect(within(row).getByRole("button", { name: "Кусочки" }).getAttribute("title")).toMatch(/^Кусочки: /);
    await waitFor(() => expect(within(row).getByLabelText("Модель").textContent).toContain("Fable 5.2"));
    expect(await within(row).findByRole("button", { name: /^Контекст \d+% · сжать$/ })).toBeTruthy();
    expect(row.querySelector("[data-cache]")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Действия" })).getByRole("button", { name: "Ещё" }));
    await waitFor(() => expect(screen.getByText("Выгрузить разговор в Markdown")).toBeTruthy());
    expect(screen.queryByText("Поля под вводом")).toBeNull();
  });
});
