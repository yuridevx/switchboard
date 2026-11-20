/// <reference types="node" />
// Эталоны знака «экран загрузился»: aria-busy у области экрана идёт за чтениями экрана и его куском сборки, а не за временем.
// Проверки страницы в браузере ждут этот знак вместо паузы после перехода.
import { keysModels } from "@sb/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { lazy, Suspense, useLayoutEffect } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { useCall } from "../common.tsx";
import { Loading, Screen } from "./Busy.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(() => (cleanup(), vi.restoreAllMocks()));

/** ответ на чтение — по имени каталога; держится, пока эталон его не отдаст */
let answer: Record<string, (v: unknown) => void>;
let qc: QueryClient;
beforeEach(() => {
  answer = {};
  atCommit = undefined;
  apiModule.connect();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiModule.api, "call").mockImplementation(((_def: unknown, input: { name: string }) => new Promise((r) => (answer[input.name] = r))) as never);
});

function Reads({ name }: { name: string }) {
  const q = useCall(keysModels, { name });
  return <div>{name}: {q.data ? "есть" : "жду"}</div>;
}
/** знак в ту минуту, когда экран встал в страницу: эффект раскладки идёт после правки DOM, до эффектов экрана */
let atCommit: string | null | undefined;
function Probe() {
  useLayoutEffect(() => void (atCommit = busy()), []);
  return null;
}
/** кусок сборки ленивого экрана: грузится, пока эталон его не отдаст */
let chunk: (m: { default: () => React.ReactNode }) => void;
const Late = lazy(() => new Promise<{ default: () => React.ReactNode }>((r) => (chunk = r)));

function app(first: string) {
  const router = createMemoryRouter([{
    path: "/", element: <Screen><Outlet /></Screen>,
    children: [
      { path: "a", element: <Reads name="a" /> },
      { path: "b", element: <><Probe /><Reads name="b" /></> },
      { path: "still", element: <div>без чтений</div> },
      { path: "late", element: <Suspense fallback={<Loading />}><Late /></Suspense> },
    ],
  }], { initialEntries: [first] });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
function busy() {
  return document.querySelector(".screen")!.getAttribute("aria-busy");
}
/** Все значения знака с этой минуты: старое значение каждой смены — и нынешнее. */
function watch() {
  const seen: MutationRecord[] = [];
  const mo = new MutationObserver((r) => seen.push(...r));
  mo.observe(document.querySelector(".screen")!, { attributes: true, attributeFilter: ["aria-busy"], attributeOldValue: true });
  return () => (seen.push(...mo.takeRecords()), mo.disconnect(), [...seen.slice(1).map((r) => r.oldValue), busy()]);
}

// чьё: задача «Тесты без случайности» — пауза после перехода заменяется сигналом «раздел загрузился»
it("чтение экрана идёт — занят, ответило — свободен; переход к экрану с новым чтением — занят без «свободен» посередине", async () => {
  const router = app("/a");
  await waitFor(() => expect(answer.a).toBeTruthy());
  expect(busy()).toBe("true");
  await act(async () => answer.a!({ models: [] }));
  await waitFor(() => expect(busy()).toBe("false"));
  const values = watch();
  await act(() => router.navigate("/b"));
  expect(answer.b).toBeTruthy();
  // новый экран встал в страницу уже занятым: прежнее «свободен» к нему не относится
  expect(atCommit).toBe("true");
  expect(busy()).toBe("true");
  await act(async () => answer.b!({ models: [] }));
  await waitFor(() => expect(busy()).toBe("false"));
  // пока чтение нового экрана шло, знак ни разу не говорил «свободен»
  expect(values()).toEqual(["true", "false"]);
});

// чьё: задача «Тесты без случайности»
it("экран без чтений — свободен сразу после перехода", async () => {
  const router = app("/a");
  await act(async () => answer.a!({ models: [] }));
  await act(() => router.navigate("/still"));
  await waitFor(() => expect(busy()).toBe("false"));
});

// чьё: код — редкие разделы грузятся отдельными кусками сборки (main.tsx)
it("ленивый экран: занят, пока грузится кусок сборки и пока идёт его чтение; свободен, когда чтение ответило", async () => {
  const router = app("/still");
  await waitFor(() => expect(busy()).toBe("false"));
  const values = watch();
  await act(() => router.navigate("/late"));
  expect(busy()).toBe("true");
  await act(async () => chunk({ default: () => <><Probe /><Reads name="late" /></> }));
  await waitFor(() => expect(answer.late).toBeTruthy());
  expect(atCommit).toBe("true");
  expect(busy()).toBe("true");
  await act(async () => answer.late!({ models: [] }));
  await waitFor(() => expect(busy()).toBe("false"));
  expect(values()).toEqual(["true", "false"]);
});
