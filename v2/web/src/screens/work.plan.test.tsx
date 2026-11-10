/// <reference types="node" />
// Сценарии плана тестов страницы — «Работа»: доска не открывает сессию сама, пара открывается последней стороной, перенос строки в проект.
// Жест перетаскивания подменён: тест зовёт то, что «Работа» делает, когда строка упала (сам жест держат тесты lib/drag и живой сценарий).
import { sessionUpdate } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dragged = vi.hoisted(() => ({ drop: null as null | ((d: { id: string; before: string | null; group: string }) => void) }));
vi.mock("../lib/drag.ts", () => ({
  useRowDrag: (o: { onDrop: (d: { id: string; before: string | null; group: string }) => void }) => {
    dragged.drop = o.onDrop;
    return { dragging: null, line: null, onPointerDown: () => () => {} };
  },
}));
vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

import * as apiModule from "../api.ts";
import { getLocal, setLocal } from "../lib/local.ts";
import type { Mock } from "../mock/fleet.ts";
import { HEAD_DEFAULT, pairKey } from "../session/Conversation.tsx";
import { useFleet } from "../store/fleet.ts";
import { Work } from "./Work.tsx";

let mock: Mock;
// соединение страницы остаётся открытым: изменения флота доходят до картины, как на настоящей странице
let link: { close(): void } | null = null;
const At = () => <output data-testid="at">{useLocation().pathname}</output>;
function work(at = "/work") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><At /><Routes><Route path="/work/:callsign?" element={<Work />} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
}
const groupOf = (callsign: string) => document.querySelector(`[aria-label="Работа"] [data-call="${callsign}"]`)?.closest("[data-drop-group]")?.getAttribute("data-drop-group");

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), done()) });
  });
  localStorage.clear();
  for (const [k, v] of [["work.filter", "all"], ["work.view", "list"], ["work.closed", []], ["work.group", "project"], ["work.nested", true], ["head.parts", HEAD_DEFAULT]] as const) setLocal(k, v as never);
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), link?.close(), mock.stop()));

describe("«Работа»", () => {
  it("1 · вид «Доска» — сессия сама не открывается; вид «Список» на широком экране открывает", async () => {
    // источник: слово пользователя «работа сразу должна открывать последнюю сессию»; доска — чьё: код
    setLocal("work.view", "board" as never);
    work();
    await flush(() => new Promise((r) => setTimeout(r, 120)));
    expect(screen.getByTestId("at").textContent).toBe("/work");
    cleanup();
    setLocal("work.view", "list" as never);
    work();
    await waitFor(() => expect(screen.getByTestId("at").textContent).toMatch(/^\/work\/.+@/));
  });

  it("2 · пара из списка открывается той стороной, которую человек смотрел последней", async () => {
    // источник: чьё: код
    setLocal("work.last", "docs@laptop" as never);
    setLocal(pairKey("lead@laptop"), "wing" as never);
    work("/work/docs@laptop");
    const list = within(await screen.findByLabelText("Работа"));
    await waitFor(() => expect(list.getByText("Замена клиента оплаты")).toBeTruthy());
    fireEvent.click(document.querySelector('[aria-label="Работа"] [data-call="lead@laptop"]')!);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/wing@laptop"));
    cleanup();
    setLocal(pairKey("lead@laptop"), "lead" as never);
    work("/work/docs@laptop");
    await waitFor(() => expect(document.querySelector('[aria-label="Работа"] [data-call="lead@laptop"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[aria-label="Работа"] [data-call="lead@laptop"]')!);
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/work/lead@laptop"));
  });

  it("4 · ширина списка меняется границей и помнится на устройстве: после нового открытия — та же", async () => {
    // источник: слово пользователя «ресайз ширины с возможностью заперсистить на девайсе»
    // у поддельной страницы нет раскладки: ширину окна задаём сами
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
    work("/work/docs@laptop");
    const edge = await screen.findByRole("separator", { name: "Ширина списка" });
    const was = Number(edge.getAttribute("aria-valuenow"));
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    await waitFor(() => expect(Number(screen.getByRole("separator", { name: "Ширина списка" }).getAttribute("aria-valuenow"))).toBe(was + 16));
    expect(getLocal("work.listw", 0)).toBe(was + 16);
    cleanup();
    work("/work/docs@laptop");
    expect(Number((await screen.findByRole("separator", { name: "Ширина списка" })).getAttribute("aria-valuenow"))).toBe(was + 16);
  });

  it("3 · строка упала в другой проект — уходит запрос на документ сессии, строка встаёт в новую группу", async () => {
    // источник: чьё: код
    work("/work/docs@laptop");
    await waitFor(() => expect(groupOf("docs@laptop")).toBe("site"));
    const spy = vi.spyOn(apiModule.api, "call");
    flush(() => dragged.drop!({ id: "docs@laptop", before: null, group: "infra" }));
    await waitFor(() => expect(groupOf("docs@laptop")).toBe("infra"));
    expect(spy.mock.calls.filter(([def]) => def === sessionUpdate).map(([, input]) => input)).toMatchObject([{ to: "docs@laptop", patch: { project: "infra" } }]);
    // в ту же группу — запроса на документ нет
    spy.mockClear();
    flush(() => dragged.drop!({ id: "docs@laptop", before: null, group: "infra" }));
    await flush(() => new Promise((r) => setTimeout(r, 60)));
    expect(spy.mock.calls.filter(([def]) => def === sessionUpdate)).toHaveLength(0);
  });
});
