/// <reference types="node" />
// Экран «Фабрика» на моке флота: работа идёт постам и сессиям по позывному, вердикт человека двигает тикет, пауза видна после перечитывания;
// очереди постов и доступные действия экран берёт из ответа служб, а не считает сам.
import { MantineProvider } from "@mantine/core";
import { factoryGet, ticketList, ticketSet, type Ticket } from "@sb/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

import * as apiModule from "../api.ts";
import { ofDoer, ruleWord, sleepWord } from "../lib/factory.ts";
import type { Mock } from "../mock/fleet.ts";
import { useFleet } from "../store/fleet.ts";
import { Factory, NewTicket, TicketPage } from "./Factory.tsx";

let mock: Mock;
let link: { close(): void } | null = null;
const At = () => <output data-testid="at">{useLocation().pathname}</output>;
function open(at: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><At />
      <Routes>
        <Route path="/factory/:project?/:tab?" element={<Factory />} />
        <Route path="/factory/:project/new" element={<NewTicket />} />
        <Route path="/factory/:project/t/:id" element={<TicketPage />} />
        <Route path="/work/:callsign?" element={null} />
      </Routes>
    </MemoryRouter></QueryClientProvider></MantineProvider>,
  );
}
const ticket = async (id: string): Promise<Ticket> => (await apiModule.api.call(ticketList, { ticket: id })).tickets[0]!;
const lane = (label: string) => screen.getByLabelText(label);
/** Номера тикетов внутри части экрана — в порядке показа. */
const ids = (el: Element) => [...el.querySelectorAll("[data-ticket]")].map((x) => x.getAttribute("data-ticket"));
/** Строка состояния на странице тикета. */
const stateOf = () => document.querySelector<HTMLElement>(".fstate [data-state]");
const tileOf = (id: string) => document.querySelector<HTMLElement>(`.ftile[data-ticket="${id}"]`)!;

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  // первый кадр мока: waitFor двигает часы теста, пока он не придёт
  await waitFor(() => new Promise<void>((done) => {
    link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), done()) });
  }));
  localStorage.clear();
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), link?.close(), mock.stop()));

describe("«Фабрика»", () => {
  it("цех показывает тикеты в дорожках постов и сессий по позывному; вставший — и блоком «Нужен человек»; входы — своей вкладкой", async () => {
    open("/factory");
    // без проекта в адресе экран сам встаёт на проект с определением: их называет служба одним ответом
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra"));
    await waitFor(() => expect(within(lane("Пост Кодеры служб")).getByText("Вход: отказ 429 сверх 200 запросов в секунду")).toBeTruthy());
    expect(within(lane("Пост Разбор сбоев")).getByText("Ночная выгрузка упала 3 раза из 10")).toBeTruthy();
    // вставший тикет — и в дорожке поста, и первым блоком «Нужен человек», с причиной
    expect(within(lane("Нужен человек")).getByText("стоп: срок вышел")).toBeTruthy();
    expect(ids(lane("Пост Кодеры служб"))).toContain("infra-39");
    // тикет сессии по позывному — дорожкой этой сессии
    expect(within(lane("Сессия deploy@server")).getByText("Проверить выкладку статики")).toBeTruthy();
    expect(document.querySelector(".banner.bad")).toBeNull();
    // входы — своей вкладкой: срок правила — из ответа служб
    cleanup();
    open("/factory/infra/inputs");
    await waitFor(() => expect(within(screen.getByLabelText("Входы")).getByText("каждые 10m")).toBeTruthy());
  });

  it("кнопки тикета — по действиям, которые назвали службы: вставший возвращают в очередь, закрытому ничего не предлагают", async () => {
    open("/factory/infra/t/infra-39");
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть в очередь" }));
    expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
    await waitFor(async () => expect((await ticket("infra-39")).state).not.toBe("stop"));
    cleanup();
    open("/factory/infra/t/infra-35");
    await screen.findByText("Ключ сменён; проверка gate 41 из 41.");
    expect((await waitFor(() => ticket("infra-35"))).acts).toEqual([]);
    for (const name of ["Принять", "Вернуть", "Вернуть в очередь", "Разбудить", "Назначить", "Снять"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByLabelText("Заметка")).toBeNull();
  });

  it("пауза видна после перечитывания, и на паузе тикет не выдаётся", async () => {
    open("/factory/infra");
    const sw = (await screen.findByRole("switch", { name: "Пауза" })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Пауза" }) as HTMLInputElement).checked).toBe(true));
    expect((await waitFor(() => apiModule.api.call(factoryGet, { project: "infra" }))).factory!.paused).toBe(true);
    // сессия поста освободилась, но на паузе срочный тикет из очереди она не берёт
    expect(await waitFor(() => apiModule.api.call(ticketSet, { ticket: "infra-53", verdict: "done" }))).toEqual({ id: "infra-53", state: "done" });
    const t = await waitFor(() => ticket("infra-59"));
    expect([t.state, t.session]).toEqual(["ready", undefined]);
  });

  it("новый тикет: заголовок, текст и «Куда» — в бэклог или посту; экран возвращается к фабрике", async () => {
    open("/factory/infra/new");
    fireEvent.change(await screen.findByLabelText("Заголовок"), { target: { value: "Сверить права архива" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    // тикет без исполнителя виден во вкладке «Бэклог» — туда экран и возвращается
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/backlog"));
    const made = (await waitFor(() => apiModule.api.call(ticketList, { project: "infra" }))).tickets[0]!;
    expect(made).toMatchObject({ id: "infra-60", title: "Сверить права архива", state: "ready" });
    expect(made.to).toBeUndefined();
    await waitFor(() => expect(within(screen.getByLabelText("Бэклог")).getByText("Сверить права архива")).toBeTruthy());
  });

  it("слова экрана: порядок тикетов исполнителя, вход правила, чего ждёт спящий", async () => {
    const f = (await waitFor(() => apiModule.api.call(factoryGet, { project: "infra" }))).factory!;
    const all = (await waitFor(() => apiModule.api.call(ticketList, { project: "infra" }))).tickets;
    // у исполнителя сначала в работе, потом вставший, потом очередь, как её раздают службы: срочный, потом старшие; спящие — последними
    expect(ofDoer("coders", all).map((t) => t.id)).toEqual(["infra-53", "infra-54", "infra-39", "infra-59", "infra-38", "infra-58", "infra-55"]);
    expect(f.def.on.map(ruleWord)).toEqual(["каждые 10m", "0 9 * * 1 · Europe/Kyiv", "адрес с секретом", "по имени", "по имени"]);
    const by = (id: string) => all.find((t) => t.id === id)!;
    expect(sleepWord(by("infra-55"))).toBe("ждёт #57");
    expect(sleepWord(by("infra-52"), "20м")).toBe("спит ещё 20м");
    // список тикетов действий, заметок и текста не несёт: их называют службы у тикета, спрошенного по номеру
    expect(all.every((t) => t.acts === undefined && t.notes === undefined && t.text === undefined)).toBe(true);
    expect((await waitFor(() => ticket("infra-55"))).acts).toEqual(["resume", "drop", "assign"]);
    // у тикета в работе поста с проверкой — её команда с номером тикета
    expect((await waitFor(() => ticket("infra-53"))).check).toEqual({ run: "sh checks/gate.sh infra-53", for: "20m" });
  });

  it("тикеты, которые ждут человека, стоят первым блоком цеха: только вставшие, старые первыми; спящий — нет", async () => {
    open("/factory/infra");
    const call = await waitFor(() => screen.getByLabelText("Нужен человек"));
    // чьё: договор — у проекта одно поле «кого звать, когда тикет встал»
    expect(ids(call)).toEqual(["infra-39", "infra-41"]);
    expect(within(call).getByText("стоп: срок вышел")).toBeTruthy();
    // блок — первый: выше него тикетов на экране нет
    expect(document.querySelector(".page.factory [data-ticket]")).toBe(call.querySelector("[data-ticket]"));
    // тот же тикет стоит в дорожке поста красной плашкой; спящий — своей: человеку там делать нечего
    expect(tileOf("infra-39").classList.contains("stop")).toBe(true);
    expect(tileOf("infra-55").classList.contains("wait")).toBe(true);
    expect(ids(call)).not.toContain("infra-55");
  });

  // чьё: факт — полоса показывала каждый «стоп»: за неделю 29 «стопов» платформы встали бы в неё рядом с 16 по слову сессии
  it("в полосе «Нужен человек» — только тикеты, которые ждут человека по своей строке: вставший, которым занят надзиратель, стоит лишь в дорожке поста", async () => {
    open("/factory/infra");
    const call = await waitFor(() => screen.getByLabelText("Нужен человек"));
    // встали три тикета — три красные плашки в дорожках; infra-31 разбирает надзиратель: тикет правила stop стоит в его очереди
    await waitFor(() => expect(tileOf("infra-31")).toBeTruthy());
    expect([...document.querySelectorAll(".ftile.stop")].map((x) => x.getAttribute("data-ticket")).sort()).toEqual(["infra-31", "infra-39", "infra-41"]);
    expect(ids(lane("Пост Оператор"))).toContain("infra-32");
    // в полосе — только те, кого строка тикета называет ждущими человека
    expect(ids(call)).toEqual(["infra-39", "infra-41"]);
  });

  it("до и после работы тикет лежит во вкладке «Бэклог»: в цехе его нет", async () => {
    open("/factory/infra");
    await waitFor(() => expect(within(lane("Пост Кодеры служб")).getByText("Архив: поиск по перенесённым журналам")).toBeTruthy());
    // чьё: слово пользователя 20 нояб. — входы и бэклог с закрытыми — отдельные вкладки
    for (const id of ["infra-50", "infra-51", "infra-35", "infra-34", "infra-33"]) expect(document.querySelector(`[data-ticket="${id}"]`)).toBeNull();
    expect(screen.queryByLabelText("Входы")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Бэклог" }));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/backlog"));
    // без исполнителя — старые первыми
    await waitFor(() => expect(ids(screen.getByLabelText("Бэклог"))).toEqual(["infra-50", "infra-51"]));
    // закрытые — по дням, свежие выше; снятый без работы назван
    const closed = screen.getByLabelText("Закрытые");
    expect(ids(closed)).toEqual(["infra-35", "infra-34", "infra-33"]);
    expect(within(closed).getByText("Вчера")).toBeTruthy();
    expect(within(closed).getByText("Оператор · снят")).toBeTruthy();
    // тикет в работе на вкладке не стоит
    expect(document.querySelector('[data-ticket="infra-43"]')).toBeNull();
  });

  it("пустых разделов в цехе нет: без вставших блока нет, пустых списков экран не рисует", async () => {
    open("/factory/research");
    await waitFor(() => expect(screen.getByLabelText(/^Пост Аналитик цен/)).toBeTruthy());
    // чьё: правило пользователя 2 нояб. — в интерфейсе только то, что несёт информацию
    expect(screen.queryByLabelText("Нужен человек")).toBeNull();
    expect(document.querySelector(".fnone")).toBeNull();
    // дорожка — одна, у поста с работой; тикет бэклога в цехе не стоит
    expect(document.querySelectorAll(".flane")).toHaveLength(1);
    expect(document.querySelector('[data-ticket="research-1"]')).toBeNull();
  });

  it("свободные посты стоят одним рядом меток; дорожка — только у поста с работой", async () => {
    open("/factory/research");
    const idle = await waitFor(() => screen.getByLabelText("Свободные посты"));
    // чьё: слово пользователя 20 нояб. — меньше места статичному, больше тому, на что смотрят каждый день
    expect([...idle.querySelectorAll("[data-post]")].map((x) => x.getAttribute("data-post"))).toEqual(["lead", "wing", "crawler", "sources", "stats", "editor", "charts"]);
    expect(ids(screen.getByLabelText(/^Пост Аналитик цен/))).toEqual(["research-2"]);
    expect(screen.queryByLabelText(/^Пост Руководитель/)).toBeNull();
    // метка свободного поста открывает разговор его сессии
    fireEvent.click(idle.querySelector('[data-post="lead"]')!);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/lead@laptop"));
  });

  it("пост, сессия которого занята тикетом по позывному, показывает этот тикет: причина очереди видна", async () => {
    open("/factory/infra");
    const post = await waitFor(() => screen.getByLabelText("Пост Оператор"));
    // чьё: код — у сессии один тикет в работе; сессия поста занята тикетом, отданным ей по позывному
    const busy = within(post).getByRole("button", { name: /занят infra-43/ });
    expect(ids(post)).toEqual(["infra-41", "infra-32", "infra-49"]);
    expect(post.querySelector('[data-ticket="infra-49"]')!.classList.contains("ready")).toBe(true);
    fireEvent.click(busy);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/t/infra-43"));
  });

  // чьё: дизайн «Пост — очередь роли», принят словом пользователя 21 нояб. («делай»)
  it("пост на несколько сессий — одна дорожка: лампа на каждую сессию, на плашке в работе — имя сессии; лампа открывает её разговор", async () => {
    open("/factory/infra");
    const coders = await waitFor(() => lane("Пост Кодеры служб"));
    expect(screen.getAllByLabelText("Пост Кодеры служб")).toHaveLength(1);
    expect([...coders.querySelectorAll("button[aria-label]")].map((x) => x.getAttribute("aria-label"))).toEqual(["coders@server", "coders-2@server"]);
    // плашка тикета в работе называет сессию, которая его ведёт
    const tile = (id: string) => within(coders.querySelector<HTMLElement>(`[data-ticket="${id}"]`)!);
    expect(tile("infra-53").getByText("coders")).toBeTruthy();
    expect(tile("infra-54").getByText("coders-2")).toBeTruthy();
    fireEvent.click(within(coders).getByRole("button", { name: "coders-2@server" }));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/coders-2@server"));
  });

  // чьё: дизайн «Пост — очередь роли»: итог тикета ложится заметкой в тикет, с шага которого он заведён
  it("итог идёт заведшему: «Принять» закрывает тикет, у тикета-родителя — заметка «… сдан: …», и он больше не спит", async () => {
    open("/factory/infra/t/infra-57");
    await waitFor(() => expect(document.querySelector('[data-parent="infra-55"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Заметка"), { target: { value: "не больше трёх" } });
    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    await waitFor(async () => expect((await ticket("infra-57")).state).toBe("done"));
    // переход к тикету-родителю: итог лёг туда заметкой; родитель ждал этот тикет — проснулся и ждёт свою сессию в очереди
    fireEvent.click(document.querySelector<HTMLElement>('[data-parent="infra-55"]')!);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/t/infra-55"));
    await waitFor(() => expect(within(screen.getByLabelText("Заметки")).getByText("infra-57 сдан: не больше трёх")).toBeTruthy());
    expect(stateOf()!.getAttribute("data-state")).toBe("ready");
    expect(document.querySelector("[data-after]")).toBeNull();
  });

  it("пауза видна шапкой на любой вкладке, и на паузе у входов нет срока; вход показывает тикет, который держит открытым", async () => {
    open("/factory/infra/inputs");
    const disk = () => within(screen.getByLabelText("Входы")).getByText("Место на дисках").closest("[data-on]")!;
    // чьё: код — на паузе входы не срабатывают и тикеты не выдаются
    await waitFor(() => expect(disk().textContent).toContain("через 4м"));
    expect(document.querySelector(".fhead.paused")).toBeNull();
    expect(ids(disk())).toEqual(["infra-49"]);
    fireEvent.click(screen.getByRole("switch", { name: "Пауза" }));
    await waitFor(() => expect(document.querySelector(".fhead.paused")).toBeTruthy());
    expect(disk().textContent).not.toContain("через");
    // шапка та же на вкладке «Цех»
    fireEvent.click(screen.getByRole("tab", { name: "Цех" }));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra"));
    expect(document.querySelector(".fhead.paused")).toBeTruthy();
  });

  // чьё: слово СТО проекта, принятое дизайном «Фабрика: неделя PoE2» (слово пользователя «делай» 26 нояб.): видимость вместо потолка
  it("У поста с очередью — числа служб: ждёт, старший, срочных; пустая очередь чисел не показывает", async () => {
    // службы отвечают числами, которые с тикетами мока не сходятся: экран показывает их, а не свой счёт
    const real = apiModule.api.call.bind(apiModule.api);
    vi.spyOn(apiModule.api, "call").mockImplementation((async (def: any, input: any) => {
      const r: any = await real(def, input);
      if (def === factoryGet && r.factory) r.factory.load.coders = { work: 2, ready: 7, first: 3, oldest: 2 * 3_600_000 };
      return r;
    }) as never);
    open("/factory/infra");
    const coders = await waitFor(() => lane("Пост Кодеры служб"));
    await waitFor(() => expect(coders.querySelector("[data-load]")!.textContent).toBe("ждёт 7 · старший 2 ч · срочных 3"));
    // у «Разбора сбоев» тикет в работе, а очередь пуста — чисел нет
    expect(lane("Пост Разбор сбоев").querySelector("[data-load]")).toBeNull();
    // числа мока — свои: в очереди кодеров три тикета, один срочный; спящий не в счёт
    expect((await waitFor(() => real(factoryGet, { project: "infra" }))).factory!.load.coders).toMatchObject({ work: 2, ready: 3, first: 1 });
  });

  // чьё: тот же дизайн — «Фабрика: неделя PoE2» (слово пользователя «делай» 26 нояб.)
  it("Спящий тикет показывает, кого ждёт", async () => {
    open("/factory/infra");
    await waitFor(() => expect(tileOf("infra-55").querySelector("[data-sleep]")!.textContent).toBe("ждёт #57"));
    // спящий по сроку — сколько ему ещё спать
    expect(tileOf("infra-52").querySelector("[data-sleep]")!.textContent).toMatch(/^спит ещё \d+м$/);
    cleanup();
    open("/factory/infra/t/infra-55");
    const after = await waitFor(() => { const b = document.querySelector<HTMLElement>('[data-after="infra-57"]'); if (!b) throw new Error("нет кнопки"); return b; });
    fireEvent.click(after);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/t/infra-57"));
    cleanup();
    // «Разбудить» шлёт resume: тикет в очереди, ожиданий нет
    const spy = vi.spyOn(apiModule.api, "call");
    open("/factory/infra/t/infra-55");
    fireEvent.click(await screen.findByRole("button", { name: "Разбудить" }));
    await waitFor(() => expect(spy.mock.calls.some(([def, input]) => def === ticketSet && (input as any).resume === true)).toBe(true));
    const t = await waitFor(() => ticket("infra-55"));
    expect([t.state, t.after]).toEqual(["ready", undefined]);
  });

  // чьё: тот же дизайн — «Фабрика: неделя PoE2» (слово пользователя «делай» 26 нояб.)
  it("Срочный тикет стоит в дорожке перед старшими и помечен", async () => {
    open("/factory/infra");
    const coders = await waitFor(() => lane("Пост Кодеры служб"));
    const order = ids(coders);
    expect(order.indexOf("infra-59")).toBeLessThan(order.indexOf("infra-38"));
    expect(order.indexOf("infra-59")).toBeLessThan(order.indexOf("infra-58"));
    expect(tileOf("infra-59").querySelector("[data-first]")).toBeTruthy();
    expect(tileOf("infra-58").querySelector("[data-first]")).toBeNull();
    cleanup();
    // переключатель на странице тикета шлёт first
    const spy = vi.spyOn(apiModule.api, "call");
    open("/factory/infra/t/infra-58");
    fireEvent.click(await screen.findByRole("switch", { name: "Срочный" }));
    await waitFor(async () => expect((await ticket("infra-58")).first).toBe(true));
    expect(spy.mock.calls.some(([def, input]) => def === ticketSet && (input as any).ticket === "infra-58" && (input as any).first === true)).toBe(true);
    cleanup();
    // и в новом тикете
    open("/factory/infra/new");
    fireEvent.change(await screen.findByLabelText("Заголовок"), { target: { value: "Срочно: вход молчит" } });
    fireEvent.click(screen.getByRole("switch", { name: "Срочный" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/backlog"));
    expect((await waitFor(() => ticket("infra-60"))).first).toBe(true);
  });

  // чьё: слово пользователя 26 нояб. («делай» по развилке «заметка не будит»)
  it("Заметка не будит спящий тикет", async () => {
    open("/factory/infra/t/infra-55");
    await waitFor(() => expect(stateOf()!.textContent).toBe("спит"));
    const write = screen.getByRole("button", { name: "Написать" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Заметка"), { target: { value: "Допустимо три повтора за ночь" } });
    expect(write.disabled).toBe(false);
    fireEvent.click(write);
    await waitFor(() => expect(within(screen.getByLabelText("Заметки")).getByText("Допустимо три повтора за ночь")).toBeTruthy());
    // тикет спит дальше: ждёт того же тикета
    expect(stateOf()!.textContent).toBe("спит");
    const t = await waitFor(() => ticket("infra-55"));
    expect([t.state, t.after]).toEqual(["wait", ["infra-57"]]);
    // спящий по сроку заметкой тоже не просыпается: срок на месте
    expect(await waitFor(() => apiModule.api.call(ticketSet, { ticket: "infra-52", note: "выкладка сдвинулась" }))).toEqual({ id: "infra-52", state: "wait" });
    expect((await waitFor(() => ticket("infra-52"))).start).toBeGreaterThan(Date.now());
  });
});
