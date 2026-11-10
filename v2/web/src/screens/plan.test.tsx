/// <reference types="node" />
// Сценарии плана тестов страницы — экраны: очереди аккаунтов, «Новая сессия», ClickHouse, нажатие на уведомление.
import { accountList, analyticsState, ledgerRead, profileList, sessionOpen } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import type { Mock } from "../mock/fleet.ts";
import { NewForm } from "../shell/NewSession.tsx";
import { Steps } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";
import { Accounts } from "./fleet/Accounts.tsx";
import { Analytics } from "./Observe.tsx";
import { worker } from "./sw-harness.ts";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

let mock: Mock;
const At = () => { const l = useLocation(); return <output data-testid="at">{l.pathname}</output>; };
function page(ui: ReactNode, at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><At /><Steps /><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
}
const slotsOf = async (m: string) => (await apiModule.api.call(accountList, { to: "@" + m })).slots ?? [];
/** Подменить ответ одного запроса; остальное идёт в мок. */
function stub(name: string, reply: (input: any) => unknown) {
  const real = apiModule.api.call.bind(apiModule.api);
  return vi.spyOn(apiModule.api, "call").mockImplementation(((def: any, input: any) => (def.name === name ? Promise.resolve().then(() => reply(input)) : real(def, input))) as never);
}
const opened = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === sessionOpen).map((c) => c[1] as any);

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  localStorage.clear();
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

describe("очереди аккаунтов", () => {
  it("1 · «+ очередь» — страница шага; имя и отмеченный вход заводят новую очередь машины", async () => {
    // источник: слово пользователя «несколько очередей (слотов)»; шаг страницей — «против попапов»
    const before = (await slotsOf("laptop")).map((q) => q.name);
    page(<Accounts />);
    await screen.findAllByRole("button", { name: "+ очередь" });
    // кнопка доступна, когда на машине есть вошедший аккаунт
    await waitFor(() => expect(screen.getAllByRole("button", { name: "+ очередь" }).some((b) => !(b as HTMLButtonElement).disabled)).toBe(true));
    fireEvent.click(screen.getAllByRole("button", { name: "+ очередь" }).find((b) => !(b as HTMLButtonElement).disabled)!);
    const head = await screen.findByRole("heading", { name: /^Новая очередь на / });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const machine = head.textContent!.replace("Новая очередь на ", "");
    const step = head.closest("section") as HTMLElement;
    fireEvent.change(within(step).getByLabelText("Имя очереди"), { target: { value: "night" } });
    const box = within(step).getAllByRole("checkbox").find((b) => !(b as HTMLInputElement).disabled)!;
    fireEvent.click(box);
    fireEvent.click(within(step).getByRole("button", { name: "Завести очередь" }));
    await waitFor(async () => expect((await slotsOf(machine)).map((q) => q.name)).toContain("night"));
    expect(before).not.toContain("night");
  });

  it("2 · очередь, на которой идут сессии, не удаляется: кнопка недоступна и называет причину", async () => {
    // источник: договор v1 «пустой order удаляет слот без сессий» — слово пользователя «как в старой»
    const busy = (await slotsOf("laptop")).find((q) => q.sessions > 0)!;
    expect(busy).toBeTruthy();
    page(<Accounts />);
    const del = (await screen.findAllByRole("button", { name: `Удалить очередь ${busy.name}` }))[0] as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("На очереди идут сессии");
  });
});

describe("новая сессия", () => {
  const AT = "/new?machine=laptop&cwd=" + encodeURIComponent("~/projects/site");

  it("3 · имя и Enter — сессия открыта с этим именем, страница уходит в её разговор", async () => {
    // источник: слово пользователя «имя самое важное и 1 поле»
    page(<NewForm />, AT);
    const spy = vi.spyOn(apiModule.api, "call");
    const name = screen.getByLabelText("Имя");
    await waitFor(() => expect((screen.getByRole("button", { name: /Открыть сессию|Продолжить|Открыть и отправить/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(name, { target: { value: "menu-fix" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/menu-fix@laptop"));
    expect(opened(spy)).toMatchObject([{ to: "@laptop", spec: { name: "menu-fix", cwd: "~/projects/site" } }]);
    expect(mock.state.sessions["menu-fix@laptop"]).toBeTruthy();
  });

  it("4 · кусочки показывают, что ставят; кусочка, которого на машине нет, в документе новой сессии не будет", async () => {
    // источник: слово пользователя «видеть пре выбранные поля»; находка «base: такой папки нет в клонах»
    const real = (await apiModule.api.call(profileList, { to: "@laptop" })).pieces;
    const neighbour = mock.state.sessions["site@laptop"]!.spec.pieces ?? [];
    expect(neighbour.length).toBeGreaterThan(1);
    const gone = neighbour.at(-1)!;
    const spy = stub("profile.list", () => ({ pieces: real.filter((p) => p.id !== gone) }));
    page(<NewForm />, AT);
    await waitFor(() => expect(document.querySelector('[aria-label="Что ставят кусочки"]')?.textContent?.length ?? 0).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole("button", { name: "Открыть сессию" }));
    await waitFor(() => expect(opened(spy)).toHaveLength(1));
    expect(opened(spy)[0].spec.pieces).toEqual(neighbour.filter((id) => id !== gone));
  });

  it("5 · разговор, который держит живая сессия, продолжается только копией: «Копией» включена и не снимается", async () => {
    // источник: дизайн «Откат и ведомый», находка критика принята
    page(<NewForm />, AT);
    const spy = vi.spyOn(apiModule.api, "call");
    const list = await screen.findByRole("listbox", { name: "Разговоры папки" });
    const held = within(list).getAllByRole("option").find((o) => /занят/.test(o.textContent ?? ""))!;
    expect(held.textContent).toContain("копией");
    fireEvent.click(held);
    const copy = screen.getByLabelText("Копией") as HTMLInputElement;
    expect(copy.checked).toBe(true);
    expect(copy.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "site-copy" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить разговор" }));
    await waitFor(() => expect(opened(spy)).toHaveLength(1));
    expect(opened(spy)[0]).toMatchObject({ fork: true });
    expect(opened(spy)[0].resume).toBeTruthy();
  });

  it("6 · на машине нет ни очереди, ни ключа флота — открыть нельзя, причина словом", async () => {
    // источник: чьё: код
    stub("account.list", () => ({ accounts: [], slots: [] }));
    page(<NewForm />, AT);
    expect((await screen.findByRole("alert")).textContent).toBe("На машине laptop нет очереди аккаунтов и ключа флота: войдите в аккаунт во «Флоте».");
    expect((screen.getByRole("button", { name: /Открыть сессию/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("7 · папки нет — кнопка «Создать папку и открыть», запрос уходит с mkdir", async () => {
    // источник: чьё: код
    page(<NewForm />, "/new?machine=laptop&cwd=" + encodeURIComponent("~/projects/brand-new"));
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.click(await screen.findByRole("button", { name: "Создать папку и открыть" }));
    await waitFor(() => expect(opened(spy)).toHaveLength(1));
    expect(opened(spy)[0]).toMatchObject({ mkdir: true, spec: { cwd: "~/projects/brand-new" } });
  });
});

describe("ClickHouse в наблюдении", () => {
  it("8 · ClickHouse не подключён к флоту — «не подключён», долива и таблицы нет", async () => {
    // источник: чьё: код
    stub("analytics.state", () => ({ on: false, ok: false, machines: [] }));
    page(<Analytics />);
    expect(await screen.findByText("не подключён")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Долить пропущенное" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("9 · ClickHouse не принял строки — причины списком из журнала флота", async () => {
    // источник: слово пользователя «видеть состояние клик хауса и синк в него»
    const real = apiModule.api.call.bind(apiModule.api);
    vi.spyOn(apiModule.api, "call").mockImplementation(((def: any, input: any) => (def === ledgerRead && input.what === "analytics.failed"
      ? Promise.resolve({ more: false, events: [{ id: "e1", at: Date.now(), what: "analytics.failed", who: ".analytics", machine: "laptop", text: "ClickHouse ответил 503: down" }] })
      : real(def, input))) as never);
    page(<Analytics />);
    expect(await screen.findByText("ClickHouse не принял")).toBeTruthy();
    expect(screen.getByText("ClickHouse ответил 503: down")).toBeTruthy();
    void analyticsState;
  });
});

describe("нажатие на уведомление", () => {
  const note = { title: "site@laptop закончила", text: "Готово", callsign: "site@laptop", kind: "done" };
  it("10 · страница уже открыта — она выходит вперёд и переходит к сессии; новой вкладки нет", async () => {
    // источник: слово пользователя «при тапе на уведомление сразу открывать сессию»
    const said: unknown[] = [];
    let focused = 0;
    const win = { url: "https://fleet.example/#/fleet", focus: async () => void focused++, postMessage: (m: unknown) => void said.push(m) };
    const w = worker({}, [win]);
    await w.fire("notificationclick", { action: "", notification: { data: note, close() {} } });
    expect(focused).toBe(1);
    expect(said).toEqual([{ type: "open", hash: "/work/site@laptop" }]);
    expect(w.calls.filter((c) => c.url.startsWith("open:"))).toEqual([]);
  });

  it("11 · уведомление тревоги открывает «Наблюдение», обращения — «Инциденты», прочее без сессии — «Работу»", async () => {
    // источник: чьё: код
    const w = worker({});
    for (const kind of ["alert", "incident", "fleet"]) await w.fire("notificationclick", { action: "", notification: { data: { title: "т", text: "т", kind }, close() {} } });
    expect(w.calls.map((c) => c.url)).toEqual(["open:/#/observe", "open:/#/fleet/incidents", "open:/#/work"]);
  });
});
