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
        <Route path="/factory/:project?" element={<Factory />} />
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
    expect(within(screen.getByLabelText("Конвейер Изменение службы")).getByText(`${load.work} из 2`)).toBeTruthy();
    expect(load.work).toBe(2);
    // вставший тикет — и на шаге, и в списке «Стоп», с причиной
    expect(within(screen.getByLabelText("Стоп")).getByText("срок вышел")).toBeTruthy();
    // тикет сессии по позывному и отложенный — в своём списке
    expect(within(screen.getByLabelText("У сессий")).getByText("Проверить выкладку статики")).toBeTruthy();
    // входы: срок правила — из ответа служб
    expect(within(screen.getByLabelText("Входы")).getByText("каждые 10m")).toBeTruthy();
    expect(document.querySelector(".banner.bad")).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/factory/infra"));
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
});
