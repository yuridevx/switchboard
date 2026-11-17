/// <reference types="node" />
// Эталоны страницы дизайна «Аккаунты и модели»: в разговоре нет аккаунта и его лимитов; список моделей один в трёх местах; закреп — личный и сверху;
// «/model» ставит модель документом сессии; час кэша и расхождение модели приходят в строке сессии.
import { CLAUDE, keysList, keysModels, message, sessionUpdate } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import type { Mock } from "../mock/fleet.ts";
import { NewForm } from "../shell/NewSession.tsx";
import { Steps } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";
import { Conversation } from "./Conversation.tsx";
import { Inspector } from "./Inspector.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

let mock: Mock;
function page(ui: ReactNode, at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><Notifications /><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
}
const called = (spy: { mock: { calls: unknown[][] } }, def: unknown) => spy.mock.calls.filter((c) => c[0] === def).map((c) => c[1] as any);
// выпадающий список в тестовом DOM без раскладки считается скрытым (у всего нулевые размеры), поэтому его содержимое ищется по разметке, а не по ролям
const listbox = () => document.querySelector('[role="listbox"][aria-label="Модели"]') as HTMLElement | null;
const offers = () => [...(listbox()?.querySelectorAll("[data-offer]") ?? [])].map((el) => el.getAttribute("data-offer")!);
const inList = (label: string) => listbox()!.querySelector(`[aria-label="${label}"]`) as HTMLElement;
/** Открыть список моделей кнопкой «Модель» и вернуть имена его строк по порядку: закреплённые — первыми. */
async function modelList(): Promise<string[]> {
  fireEvent.click(await screen.findByRole("button", { name: /^Модель/ }));
  // каталоги провайдеров приходят по одному: список читается, когда пришли все
  const keys = (await apiModule.api.call(keysList, {})).keys.filter((k) => k.protocol !== CLAUDE).map((k) => k.name);
  // каталог провайдера, который не ответил, моделей в список не даёт: остальные в списке остаются
  const all = (await Promise.all([CLAUDE, ...keys].map((name) => apiModule.api.call(keysModels, { name }).then((r) => r.models.length, () => 0)))).reduce((n, r) => n + r, 0);
  await waitFor(() => expect(offers().length).toBe(all));
  return offers();
}
const row = () => screen.getByRole("group", { name: "Документ сессии" });
/** Строка сессии пришла с машины: картина страницы получает её целиком. patch — что машина в ней сменила. */
const setRow = (callsign: string, patch: object = {}) => useFleet.getState().apply({ type: "roster.delta", rev: Date.now(), sessions: [{ callsign, row: { ...mock.state.sessions[callsign]!, ...patch } }] } as never);

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
  localStorage.clear();
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), mock.stop()));

describe("эталоны страницы «Аккаунты и модели»", () => {
  it("1 · разговор сессии на Claude открыт — ни аккаунта, ни его лимитов в ряду под полем ввода и в панели сессии", async () => {
    // чьё: слово пользователя 15 нояб. — «на панели знать лимиты аккаунта вообще не нужно, ведь система это абстрагирует»
    // аккаунт сессии — не почта того, кто её открыл: имя открывшего в панели остаётся
    setRow("site@laptop", { account: "work@example.com" });
    const s = useFleet.getState().sessions["site@laptop"]!;
    expect(s.spec.key).toBe(CLAUDE);
    const spy = vi.spyOn(apiModule.api, "call");
    const { container } = page(<><Conversation callsign="site@laptop" /><aside aria-label="Панель сессии"><Inspector s={s} /></aside></>, "/work/site@laptop");
    await waitFor(() => expect(within(row()).getByLabelText("Модель").textContent).toContain("Fable 5.2"));
    const account = s.account!, short = account.slice(0, account.indexOf("@"));
    for (const place of [row(), screen.getByRole("complementary", { name: "Панель сессии" })]) {
      expect(place.textContent).not.toContain(account);
      expect(place.textContent).not.toMatch(new RegExp(`${short}|Очередь|Аккаунт|неделя`));
    }
    expect(container.querySelector("[data-limit], .meter, .vbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /Очередь|Аккаунт|Сменить аккаунт/ })).toBeNull();
    // аккаунты машины разговору не нужны: запроса account.list нет
    expect(spy.mock.calls.some((c) => (c[0] as { name: string }).name === "account.list")).toBe(false);
  });

  it("2 · новая сессия, ряд под полем ввода, остановленная сессия — список моделей один и тот же", async () => {
    // чьё: слово пользователя 15 нояб. — «список доступных моделей супер плавает и не консистентный»
    const fresh = page(<NewForm />, "/new?machine=laptop&cwd=" + encodeURIComponent("~/projects/site"));
    const inNew = await modelList();
    fresh.unmount();
    const live = page(<Conversation callsign="site@laptop" />, "/work/site@laptop");
    const inRow = await modelList();
    live.unmount();
    expect(mock.state.sessions["hotfix@laptop"]!.state).toBe("failed");
    page(<Conversation callsign="hotfix@laptop" />, "/work/hotfix@laptop");
    const inStopped = await modelList();
    expect(inRow).toEqual(inNew);
    expect(inStopped).toEqual(inNew);
    // в списке — все модели каталогов: Claude целиком и каждый провайдер
    const claude = (await apiModule.api.call(keysModels, { name: CLAUDE })).models.map((m) => `${CLAUDE}/${m.id}`);
    expect(inNew.filter((id) => id.startsWith(CLAUDE + "/")).sort()).toEqual([...claude].sort());
    expect(inNew.some((id) => id.startsWith("orca/"))).toBe(true);
  });

  it("3 · модель закреплена — стоит сверху списка; закреп — личная настройка, одна на всех устройствах человека", async () => {
    // чьё: слово пользователя 15 нояб. — «модель из списка с поиском с закрепов»
    const spy = vi.spyOn(apiModule.api, "call");
    const first = page(<Conversation callsign="site@laptop" />, "/work/site@laptop");
    const before = await modelList();
    expect(before.indexOf("orca/kimi-k3")).toBeGreaterThan(3);
    fireEvent.click(inList("Закрепить kimi-k3"));
    await waitFor(() => expect(spy.mock.calls.some((c) => (c[0] as { name: string }).name === "prefs.set" && (c[1] as any).scope === "me" && (c[1] as any).name === "models.pins" && (c[1] as any).value.includes("orca/kimi-k3"))).toBe(true));
    first.unmount();
    // другое устройство того же человека: своей памяти нет — закреп приходит из его настроек
    localStorage.clear();
    page(<NewForm />, "/new?machine=laptop&cwd=" + encodeURIComponent("~/projects/site"));
    const after = await modelList();
    expect(after.slice(0, 4)).toEqual(["claude/claude-fable-5-2", "orca/glm-5.3", "orca/deepseek-v4", "orca/kimi-k3"]);
    expect(inList("Открепить kimi-k3").getAttribute("aria-pressed")).toBe("true");
  });

  it("4 · «/model слова» в поле ввода открывает тот же список с поиском; Enter ставит провайдера и модель одним запросом, в разговор команда не уходит", async () => {
    // чьё: слово пользователя 15 нояб. — «/model должно правильно отрабатываться и саппортиться»
    page(<Conversation callsign="docs@laptop" />, "/work/docs@laptop");
    const box = (await screen.findByLabelText("Сообщение сессии")) as HTMLTextAreaElement;
    const spy = vi.spyOn(apiModule.api, "call");
    fireEvent.change(box, { target: { value: "/model qwen coder" } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Enter" });
    const search = (await screen.findByLabelText("Найти модель")) as HTMLInputElement;
    expect(search.value).toBe("qwen coder");
    await waitFor(() => expect(offers()).toEqual(["orca/qwen-3.5-coder"]));
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(called(spy, sessionUpdate)).toEqual([{ to: "docs@laptop", patch: { key: "orca", model: "qwen-3.5-coder" } }]));
    expect(called(spy, message)).toEqual([]);
    expect(box.value).toBe("");
    await waitFor(() => expect(mock.state.sessions["docs@laptop"]!.spec.key).toBe("orca"));
    setRow("docs@laptop");
    await waitFor(() => expect(within(row()).getByLabelText("Модель").textContent).toBe("qwen-3.5-coder · orca"));
  });

  it("5 · модель Claude с окном от миллиона уходит в документ именем каталога как есть; в ряду стоит название из каталога", async () => {
    // чьё: дизайн «Свободная смена модели», эталон 16 — имя в документе как в каталоге у любого провайдера; суффикс окна знает только машина
    page(<Conversation callsign="docs@laptop" />, "/work/docs@laptop");
    const spy = vi.spyOn(apiModule.api, "call");
    await modelList();
    fireEvent.click(listbox()!.querySelector('[data-offer="claude/claude-opus-4-8"] .mp-pick')!);
    await waitFor(() => expect(called(spy, sessionUpdate)).toEqual([{ to: "docs@laptop", patch: { key: CLAUDE, model: "claude-opus-4-8" } }]));
    await waitFor(() => expect(mock.state.sessions["docs@laptop"]!.spec.model).toBe("claude-opus-4-8"));
    setRow("docs@laptop");
    await waitFor(() => expect(within(row()).getByLabelText("Модель").textContent).toBe("Opus 4.8"));
  });

  it("6 · отвечает не та модель, что выбрана, — в ряду видны обе; страница сама не сравнивает: ответившую называет машина в строке сессии", async () => {
    // чьё: слово пользователя 15 нояб. — «жёсткий мониторинг, какая модель активна, убрать любой десинк»
    page(<Conversation callsign="docs@laptop" />, "/work/docs@laptop");
    const model = () => within(row()).getByLabelText("Модель");
    await waitFor(() => expect(model().textContent).toBe("Fable 5.2 ≠ Opus 5.5"));
    expect(model().className).toContain("loud");
    // строка без answers — расхождения нет, какой бы ни была модель документа
    setRow("docs@laptop", { answers: undefined });
    await waitFor(() => expect(model().textContent).toBe("Fable 5.2"));
    expect(model().className).not.toContain("loud");
  });

  it("7 · час кэша — из строки сессии: тёплый до названного времени; засечка автосжатия — только если машина назвала его час; строки нет — кэш холодный", async () => {
    // чьё: слово пользователя 15 нояб. — «в визуал обязательно время кэша сессии»; правило 54-й минуты и 200 К считает машина
    page(<Conversation callsign="lead@laptop" />, "/work/lead@laptop");
    const clock = () => document.querySelector("[data-cache]") as HTMLElement;
    await waitFor(() => expect(clock()?.getAttribute("data-cache")).toBe("warm"));
    expect(clock().getAttribute("aria-label")).toMatch(/^Кэш разговора тёплый до \d\d:\d\d · в \d\d:\d\d разговор сожмётся сам$/);
    expect(clock().querySelector(".notch")).toBeTruthy();
    setRow("lead@laptop", { cache: { until: Date.now() + 30 * 60_000 } });
    await waitFor(() => expect(clock().querySelector(".notch")).toBeNull());
    expect(clock().getAttribute("aria-label")).toMatch(/^Кэш разговора тёплый до \d\d:\d\d$/);
    expect(clock().textContent).toBe("30");
    setRow("lead@laptop", { cache: undefined });
    await waitFor(() => expect(clock().getAttribute("data-cache")).toBe("cold"));
  });

  it("8 · провайдер срока кэша не называет: кольцо показывает долю последнего запроса, прочитанную из кэша; прочитано ноль — кэш холодный", async () => {
    // чьё: слово пользователя 17 нояб. — «на всех моделях должен работать горячий кэш-индикатор»; факт опыта — сторонние называют чтения из кэша, срок — нет
    page(<Conversation callsign="lead@laptop" />, "/work/lead@laptop");
    const clock = () => document.querySelector("[data-cache]") as HTMLElement;
    await waitFor(() => expect(clock()).toBeTruthy());
    setRow("lead@laptop", { cache: { size: 40_000, read: 38_000 } });
    await waitFor(() => expect(clock().getAttribute("data-cache")).toBe("read"));
    expect(clock().getAttribute("aria-label")).toBe("Последний запрос прочитал из кэша 95 %");
    expect(clock().textContent).toBe("95%");
    expect(clock().querySelector(".arc")).toBeTruthy();
    setRow("lead@laptop", { cache: { size: 40_000, read: 0 } });
    await waitFor(() => expect(clock().textContent).toBe("0%"));
    expect(clock().className).toContain("cold");
    expect(clock().querySelector(".arc")).toBeNull();
  });
});
