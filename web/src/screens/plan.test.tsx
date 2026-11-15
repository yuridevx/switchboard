/// <reference types="node" />
// Сценарии плана тестов страницы — экраны: аккаунты Claude и провайдеры, «Новая сессия», ClickHouse, нажатие на уведомление.
import { analyticsState, CLAUDE, keysList, keysSet, ledgerRead, profileList, sessionOpen } from "@sb/protocol";
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
const called = (spy: { mock: { calls: unknown[][] } }, def: unknown) => spy.mock.calls.filter((c) => c[0] === def).map((c) => c[1] as any);
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

describe("аккаунты Claude", () => {
  it("1 · один аккаунт на двух машинах — один столбец; очередей, входов по ссылке и коду на экране нет", async () => {
    // источник: слово пользователя 15 нояб. — «убрать слоты и всё сделать через прокси»; «систему аккаунтов и страницу переделать полностью»
    page(<Accounts />);
    await waitFor(() => expect(document.querySelectorAll("[data-account]").length).toBeGreaterThan(0));
    const names = [...document.querySelectorAll("[data-account]")].map((el) => el.getAttribute("data-account"));
    expect(names.filter((n) => n === "yuri@example.com")).toHaveLength(1);
    expect(new Set(names)).toEqual(new Set((await apiModule.api.call(keysList, {})).keys.filter((k) => k.protocol === CLAUDE).map((k) => k.name)));
    expect(screen.queryByRole("button", { name: "+ очередь" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Получить ссылку входа|Войти/ })).toBeNull();
  });

  it("2 · флаг «Беречь запас Fable» — один запрос keys.set с protocol claude и keep; штрих запаса со столбика уходит", async () => {
    // источник: слово пользователя 15 нояб. — «флаги на аккаунте: Fable хранить или нет (если нет — не сохранять)»
    page(<Accounts />);
    const col = () => document.querySelector('[data-account="yuri@example.com"]') as HTMLElement;
    await waitFor(() => expect(col()?.querySelector(".vbar .hold")).toBeTruthy());
    const spy = vi.spyOn(apiModule.api, "call");
    const flag = within(col()).getByRole("button", { name: "Беречь запас Fable" });
    expect(flag.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(flag);
    await waitFor(() => expect(called(spy, keysSet)).toEqual([{ name: "yuri@example.com", protocol: CLAUDE, keep: false }]));
    await waitFor(() => expect(col().querySelector(".vbar .hold")).toBeNull());
    expect(within(col()).getByRole("button", { name: "Беречь запас Fable" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("2а · новый аккаунт — почта и токен одной страницей шага: уходит ключом флота с протоколом claude", async () => {
    // источник: дизайн «Аккаунты и модели» — аккаунт заводится один раз на флот годовым токеном; шаг страницей — «против попапов»
    page(<Accounts />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
    await screen.findByRole("heading", { name: "Новый аккаунт Claude" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.change(screen.getByLabelText("Почта аккаунта"), { target: { value: "New@Example.com" } });
    fireEvent.change(screen.getByLabelText("Токен"), { target: { value: "sk-ant-oat01-" + "x".repeat(40) } });
    const step = screen.getByRole("heading", { name: "Новый аккаунт Claude" }).closest("section") as HTMLElement;
    fireEvent.click(within(step).getByRole("button", { name: "Добавить аккаунт" }));
    await waitFor(() => expect(called(spy, keysSet)).toHaveLength(1));
    expect(called(spy, keysSet)[0]).toMatchObject({ name: "new@example.com", protocol: CLAUDE });
    await waitFor(() => expect(document.querySelector('[data-account="new@example.com"]')).toBeTruthy());
  });

  it("2б · эталон: сессия перешла на другой аккаунт — в ленте переходов строка с причиной и аккаунтами, прочитанная из log.query", async () => {
    // источник: слово пользователя 15 нояб. — «вся история и весь лог должен быть в ClickHouse»
    const spy = stub("log.query", (input) => ({ lines: [{ at: Date.now() - 60_000, machine: "laptop", part: "host", level: "info", msg: "account.moved", session: "docs@laptop", account: "ops@example.com", kind: "moved", text: "docs: work → ops · неделя work выбрана" }].filter((l) => l.msg.startsWith(input.msg ?? "")), more: false }));
    page(<Accounts />);
    const feed = await waitFor(() => { const el = document.querySelector('[data-card="moves"]'); expect(el).toBeTruthy(); return el as HTMLElement; });
    expect(within(feed).getByText("docs: work → ops · неделя work выбрана")).toBeTruthy();
    expect(within(feed).getByText("laptop")).toBeTruthy();
    expect(spy.mock.calls.filter((c) => (c[0] as { name: string }).name === "log.query").map((c) => c[1])).toEqual([{ msg: "account.", limit: 8 }]);
    // журнал флота лентой переходов не читается: история аккаунтов — одна, в ClickHouse
    expect(spy.mock.calls.some((c) => c[0] === ledgerRead)).toBe(false);
  });

  it("2в · «Обновить лимиты» — одна машина спрашивает Claude заново обо всех аккаунтах, экран перечитывает числа", async () => {
    // источник: слово пользователя 16 нояб. — «нужна кнопка рефреша лимитов: я использовал ресет лимитов, а панель его не схватила»
    page(<Accounts />);
    await waitFor(() => expect(document.querySelectorAll("[data-account]").length).toBeGreaterThan(0));
    const spy = vi.spyOn(apiModule.api, "call");
    const asked = () => spy.mock.calls.filter((c) => (c[0] as { name: string }).name === "account.list").map((c) => c[1] as { to: string; fresh?: boolean });
    fireEvent.click(screen.getByRole("button", { name: "Обновить лимиты" }));
    // сначала вопрос «заново», после ответа — обычное чтение чисел; машина одна и та же
    await waitFor(() => expect(asked().length).toBe(2));
    expect(asked()[0]!.fresh).toBe(true);
    expect(asked()[1]!.fresh).toBeUndefined();
    expect(new Set(asked().map((a) => a.to)).size).toBe(1);
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
    // модель — как у последней сессии этой машины: провайдер и точное имя стоят в документе
    expect(opened(spy)).toMatchObject([{ to: "@laptop", spec: { name: "menu-fix", cwd: "~/projects/site", key: CLAUDE } }]);
    expect(opened(spy)[0].spec.model).toMatch(/^claude-/);
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
    // модель новой сессии встаёт, когда ответил каталог: до этого открыть нельзя
    await waitFor(() => expect((screen.getByRole("button", { name: "Открыть сессию" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Открыть сессию" }));
    await waitFor(() => expect(opened(spy)).toHaveLength(1));
    expect(opened(spy)[0].spec.pieces).toEqual(neighbour.filter((id) => id !== gone));
  });

  it("5 · разговор, который держит живая сессия, продолжается только копией: «Копией» включена и не снимается", async () => {
    // источник: дизайн «Откат и ведомый», находка критика принята
    page(<NewForm />, AT);
    const spy = vi.spyOn(apiModule.api, "call");
    const list = await screen.findByRole("listbox", { name: "Разговоры папки" });
    const held = within(list).getAllByRole("option").find((o) => /занят/.test(o.textContent ?? ""))!;
    // модель новой сессии встаёт, когда ответил каталог: до этого открыть нельзя
    await waitFor(() => expect((screen.getByRole("button", { name: /Открыть сессию|Продолжить/ }) as HTMLButtonElement).disabled).toBe(false));
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

  it("6 · у флота нет ни аккаунта Claude, ни провайдера — открыть нельзя, причина словом", async () => {
    // источник: чьё: код
    stub("keys.list", () => ({ keys: [] }));
    page(<NewForm />, AT);
    expect((await screen.findByRole("alert")).textContent).toBe("У флота нет ни аккаунта Claude, ни провайдера: добавьте во «Флот → Аккаунты».");
    expect((screen.getByRole("button", { name: /Открыть сессию/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("6а · модель новой сессии обязательна: документ называет провайдера и точную модель; поля «Аккаунт» в форме нет", async () => {
    // источник: слово пользователя 15 нояб. — «выбирать провайдера и модель из списка, а не создавать слот на каждую»; дизайн — аккаунт выбирает машина
    page(<NewForm />, AT);
    const spy = vi.spyOn(apiModule.api, "call");
    expect(screen.queryByLabelText(/Аккаунт|Очередь/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Модель/ }));
    const list = await screen.findByRole("listbox", { name: "Модели" });
    fireEvent.click(await waitFor(() => { const el = list.querySelector('[data-offer="orca/qwen-3.5-coder"] .mp-pick'); expect(el).toBeTruthy(); return el as HTMLElement; }));
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "coder" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть сессию" }));
    await waitFor(() => expect(opened(spy)).toHaveLength(1));
    expect(opened(spy)[0].spec).toMatchObject({ name: "coder", key: "orca", model: "qwen-3.5-coder" });
    expect("slot" in opened(spy)[0].spec).toBe(false);
  });

  it("7 · папки нет — кнопка «Создать папку и открыть», запрос уходит с mkdir", async () => {
    // источник: чьё: код
    page(<NewForm />, "/new?machine=laptop&cwd=" + encodeURIComponent("~/projects/brand-new"));
    const spy = vi.spyOn(apiModule.api, "call");
    await waitFor(() => expect((screen.getByRole("button", { name: "Создать папку и открыть" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Создать папку и открыть" }));
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
  // находка: оповещение о сбое пропадало — у оповещений был один тег, и соседнее заменяло его
  it("оповещения о разном стоят рядом, о том же — заменяют себя: тег несёт вид и предмет", async () => {
    const w = worker({});
    const push = (n: Record<string, unknown>) => w.fire("push", { data: { json: () => n } });
    await push({ title: "Host машины laptop: сбой", text: "упал", kind: "alert", subject: "host.failed/laptop" });
    await push({ title: "Машина server без связи", text: "5 мин", kind: "alert", subject: "machine.offline/server/1" });
    await push({ title: "Host машины laptop: сбой", text: "снова", kind: "alert", subject: "host.failed/laptop" });
    const tags = w.shown.map((x) => x.o.tag);
    expect(tags[0]).not.toBe(tags[1]);
    expect(tags[2]).toBe(tags[0]);
    // уведомления сессии — как были: сессия и вид
    await push(note);
    expect(w.shown.at(-1)!.o.tag).toBe("site@laptop:done");
  });
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
