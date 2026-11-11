/// <reference types="node" />
// Комментарии пользователя 10 нояб.: форма «Новая сессия» одного уровня, состояние ClickHouse в «Наблюдении».
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "./api.ts";
import { Analytics } from "./screens/Observe.tsx";
import { NewForm } from "./shell/NewSession.tsx";
import { useFleet } from "./store/fleet.ts";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(cleanup);

const page = (ui: ReactNode) => render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider></MantineProvider>);

beforeEach(async () => {
  localStorage.clear();
  apiModule.connect();
  const mock = apiModule.mock!;
  await new Promise<void>((done) => {
    const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
  });
});

describe("новая сессия", () => {
  it("форма одного уровня: поля видны сразу, раскрывать нечего; размышления включены, ведомый — на виду", async () => {
    page(<NewForm />);
    expect(screen.queryByRole("button", { name: /Скрыть настройки|Модель, аккаунт/ })).toBeNull();
    for (const label of ["Модель", "Усилие", "Режим", "Очередь аккаунтов", "Проект"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect((screen.getByLabelText("Размышлять перед ответом") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("С ведомым") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(screen.getByText("Кусочки")).toBeTruthy());
  });
});

describe("ClickHouse в наблюдении", () => {
  it("отвечает: время ответа, строки по машинам и сколько точек ждут долива; админ доливает", async () => {
    page(<Analytics />);
    await waitFor(() => expect(screen.getByText(/^отвечает · 180 мс$/)).toBeTruthy());
    expect(screen.getByText("точек архива ждут долива").previousSibling?.textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Долить пропущенное" })).toBeTruthy();
  });
  it("не отвечает: причина словом, таблицы и доливки нет", async () => {
    apiModule.mock!.setAnalyticsDown(true);
    page(<Analytics />);
    await waitFor(() => expect(screen.getByText("не отвечает")).toBeTruthy());
    expect(screen.getByText("ClickHouse не ответил за 10 с")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Долить пропущенное" })).toBeNull();
    apiModule.mock!.setAnalyticsDown(false);
  });
});
