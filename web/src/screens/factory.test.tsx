/// <reference types="node" />
// Экран «Фабрика» на моке флота: тикет стоит на своём шаге конвейера, вердикт человека двигает его дальше, пауза видна после перечитывания;
// загрузку и доступные действия экран берёт из ответа служб, а не считает сам.
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
import { atStep, doerOf, ruleWord, waitWord } from "../lib/factory.ts";
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
const stepBox = (line: string, step: string) => within(within(screen.getByLabelText(`Конвейер ${line}`)).getByLabelText(`Шаг ${step}`));

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
  it("конвейер показывает тикет на его шаге, а загрузку — числом из ответа служб", async () => {
    open("/factory");
    // без проекта в адресе экран сам встаёт на проект с определением: их называет служба одним ответом
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra"));
    const agree = await waitFor(() => stepBox("Изменение службы", "согласие"));
    await waitFor(() => expect(agree.getByText("Перенос журналов в архив")).toBeTruthy());
    expect(stepBox("Изменение службы", "ревью").getByText("Права доступа служб выгрузки")).toBeTruthy();
    expect(stepBox("Изменение службы", "слияние").getByText(/ждёт: PR слит · #212/)).toBeTruthy();
    const load = (await waitFor(() => apiModule.api.call(factoryGet, { project: "infra" }))).factory!.load.lines.change!;
    expect(within(screen.getByLabelText("Конвейер Изменение службы")).getByLabelText(`идёт ${load.work} из 2`)).toBeTruthy();
    expect(load.work).toBe(2);
    // вставший тикет — и на шаге, и первым блоком «Нужен человек», с причиной
    expect(within(screen.getByLabelText("Нужен человек")).getByText("стоп: срок вышел")).toBeTruthy();
    // тикет сессии по позывному и отложенный — дорожкой этой сессии
    expect(within(screen.getByLabelText("Сессия deploy@server")).getByText("Проверить выкладку статики")).toBeTruthy();
    expect(document.querySelector(".banner.bad")).toBeNull();
    // входы — своей вкладкой: срок правила — из ответа служб
    cleanup();
    open("/factory/infra/inputs");
    await waitFor(() => expect(within(screen.getByLabelText("Входы")).getByText("каждые 10m")).toBeTruthy());
  });

  it("«Принять» у шага человека двигает тикет на следующий шаг; потолок занят — он встаёт в очередь", async () => {
    open("/factory/infra/t/infra-41");
    fireEvent.click(await screen.findByRole("button", { name: "Принять" }));
    await waitFor(() => expect(document.querySelector('.fpath [aria-current="step"]')?.textContent).toBe("правка"));
    const t = await waitFor(() => ticket("infra-41"));
    expect([t.step, t.state, t.notes!.at(-1)?.verdict]).toEqual([2, "ready", "done"]);
    // тикет в очереди: вердикт давать нечему — кнопки берутся из ответа служб
    expect(t.acts).toEqual(["drop", "assign"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Принять" })).toBeNull());
    cleanup();
    open("/factory/infra");
    await waitFor(() => expect(stepBox("Изменение службы", "правка").getByText("Перенос журналов в архив")).toBeTruthy());
  });

  it("кнопки тикета — по действиям, которые назвали службы: вставший возвращают в очередь, закрытому ничего не предлагают", async () => {
    open("/factory/infra/t/infra-39");
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть в очередь" }));
    expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
    await waitFor(async () => expect((await ticket("infra-39")).state).not.toBe("stop"));
    cleanup();
    open("/factory/infra/t/infra-35");
    await screen.findByText(/example\/sb-ops#207 слит/);
    expect((await waitFor(() => ticket("infra-35"))).acts).toEqual([]);
    for (const name of ["Принять", "Вернуть", "Вернуть в очередь", "Назначить", "Снять"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByLabelText("Заметка")).toBeNull();
  });

  it("пауза видна после перечитывания, и на паузе новый шаг не запускается", async () => {
    open("/factory/infra");
    const sw = (await screen.findByRole("switch", { name: "Пауза" })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Пауза" }) as HTMLInputElement).checked).toBe(true));
    expect((await waitFor(() => apiModule.api.call(factoryGet, { project: "infra" }))).factory!.paused).toBe(true);
    // место на «Разборе сбоя» есть (1 из 2), но на паузе вердикт не запускает следующий шаг
    expect(await waitFor(() => apiModule.api.call(ticketSet, { ticket: "infra-44", verdict: "done" }))).toMatchObject({ step: 1, state: "ready" });
  });

  it("новый тикет: заголовок, текст и «Куда» — в бэклог или на конвейер; экран возвращается к фабрике", async () => {
    open("/factory/infra/new");
    fireEvent.change(await screen.findByLabelText("Заголовок"), { target: { value: "Сверить права архива" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    // тикет без исполнителя виден во вкладке «Бэклог» — туда экран и возвращается
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/backlog"));
    const made = (await waitFor(() => apiModule.api.call(ticketList, { project: "infra" }))).tickets[0]!;
    expect(made).toMatchObject({ id: "infra-53", title: "Сверить права архива", state: "ready" });
    expect(made.to).toBeUndefined();
    await waitFor(() => expect(within(screen.getByLabelText("Бэклог")).getByText("Сверить права архива")).toBeTruthy());
  });

  it("слова экрана: исполнитель шага, порядок на шаге, вход правила, чего ждёт тикет", async () => {
    const f = (await waitFor(() => apiModule.api.call(factoryGet, { project: "infra" }))).factory!;
    const all = (await waitFor(() => apiModule.api.call(ticketList, { project: "infra" }))).tickets;
    expect(f.def.lines.change!.steps.map((s) => doerOf(s).kind)).toEqual(["post", "human", "same", "new", "event"]);
    // на шаге сначала идущие, потом очередь
    expect(atStep("change", 0, all).map((t) => t.state)).toEqual(["work", "ready"]);
    expect(f.def.on.map(ruleWord)).toEqual(["каждые 10m", "0 9 * * 1 · Europe/Kyiv", "адрес с секретом", "GitHub · апстрим сдвинулся · каждые 5m", "по имени"]);
    const by = (id: string) => all.find((t) => t.id === id)!;
    expect(waitWord(f.def, by("infra-41"))).toBe("ждёт человека");
    expect(waitWord(f.def, by("infra-36"))).toBe("ждёт: PR слит · #212");
    // список тикетов действий не несёт: их называют службы у тикета, спрошенного по номеру
    expect(all.every((t) => t.acts === undefined && t.notes === undefined)).toBe(true);
    expect((await waitFor(() => ticket("infra-41"))).acts).toEqual(["verdict", "drop", "assign"]);
  });

  /** Номера тикетов внутри части экрана — в порядке показа. */
  const ids = (el: Element) => [...el.querySelectorAll("[data-ticket]")].map((x) => x.getAttribute("data-ticket"));

  it("тикеты, которые ждут человека, стоят первым блоком цеха: стоп и шаг человека, старые первыми; ждущий события — нет", async () => {
    open("/factory/infra");
    const call = await waitFor(() => screen.getByLabelText("Нужен человек"));
    // чьё: договор — у проекта одно поле «кого звать, когда тикет ждёт человека или встал»
    expect(ids(call)).toEqual(["infra-39", "infra-41"]);
    expect(within(call).getByText("стоп: срок вышел")).toBeTruthy();
    // блок — первый: выше него тикетов на экране нет
    expect(document.querySelector(".page.factory [data-ticket]")).toBe(call.querySelector("[data-ticket]"));
    // тот же тикет стоит на своей станции жёлтой плашкой; ждущий события — тихой: человеку там делать нечего
    const tile = (step: string, title: string) => stepBox("Изменение службы", step).getByText(title).closest("[data-ticket]")!;
    expect(tile("согласие", "Перенос журналов в архив").classList.contains("human")).toBe(true);
    expect(tile("слияние", "Сжатие резервных копий").classList.contains("human")).toBe(false);
  });

  it("до и после работы тикет лежит во вкладке «Бэклог»: в цехе его нет", async () => {
    open("/factory/infra");
    await waitFor(() => expect(stepBox("Изменение службы", "план").getByText("Предел запросов на входе")).toBeTruthy());
    // чьё: слово пользователя 20 нояб. — входы и бэклог с закрытыми — отдельные вкладки
    for (const id of ["infra-50", "infra-51", "infra-35", "infra-33"]) expect(document.querySelector(`[data-ticket="${id}"]`)).toBeNull();
    expect(screen.queryByLabelText("Входы")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Бэклог" }));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/backlog"));
    // без исполнителя — старые первыми
    await waitFor(() => expect(ids(screen.getByLabelText("Бэклог"))).toEqual(["infra-50", "infra-51"]));
    // закрытые — по дням, свежие выше; снятый без работы назван
    const closed = screen.getByLabelText("Закрытые");
    expect(ids(closed)).toEqual(["infra-35", "infra-33"]);
    expect(within(closed).getByText("Вчера")).toBeTruthy();
    expect(within(closed).getByText("Изменение службы · снят")).toBeTruthy();
    // тикет в работе на вкладке не стоит
    expect(document.querySelector('[data-ticket="infra-43"]')).toBeNull();
  });

  it("пустых разделов в цехе нет: без ждущих человека блока нет, пустых списков экран не рисует", async () => {
    open("/factory/research");
    await waitFor(() => expect(screen.getByLabelText("Конвейер Ревью отчёта")).toBeTruthy());
    // чьё: правило пользователя 2 нояб. — в интерфейсе только то, что несёт информацию
    expect(screen.queryByLabelText("Нужен человек")).toBeNull();
    expect(document.querySelector(".fnone")).toBeNull();
    // конвейер без тикетов — одна строка названия: коробки под тикеты у него нет
    expect(ids(screen.getByLabelText("Конвейер Цикл руководителя"))).toEqual([]);
    expect(ids(screen.getByLabelText("Конвейер Ревью отчёта"))).toEqual(["research-1"]);
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

  it("пост, занятый шагом конвейера, показывает этот шаг: причина очереди видна", async () => {
    open("/factory/infra");
    const post = await waitFor(() => screen.getByLabelText("Пост Оператор"));
    // чьё: код — пост берёт тикеты по одному и занят шагом конвейера, который ведёт его сессия
    const step = within(post).getByRole("button", { name: /шаг конвейера infra-43/ });
    expect(ids(post)).toEqual(["infra-49"]);
    expect(post.querySelector('[data-ticket="infra-49"]')!.classList.contains("ready")).toBe(true);
    fireEvent.click(step);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra/t/infra-43"));
  });

  it("пауза видна шапкой на любой вкладке, и на паузе у входов нет срока; вход показывает тикет, который держит открытым", async () => {
    open("/factory/infra/inputs");
    const disk = () => within(screen.getByLabelText("Входы")).getByText("Место на дисках").closest("[data-on]")!;
    // чьё: код — на паузе входы не срабатывают и новые шаги не запускаются
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
});
