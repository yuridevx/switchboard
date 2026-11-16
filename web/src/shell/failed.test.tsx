/// <reference types="node" />
// Эталоны страницы дизайна «Ошибки на виду», запросы: у отказа запроса один показ — блок на месте, полоса наверху или тост.
// Источник свойства — над каждым эталоном.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CallError, keysModels, obsReport, sessionStop } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act as settle, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { Failed, useCall } from "../common.tsx";
import { useFleet } from "../store/fleet.ts";
import { FailedBar } from "./FailedBar.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(() => (cleanup(), vi.restoreAllMocks()));

let qc: QueryClient;
/** ответ флота на запрос: по имени запроса */
let answers: Record<string, () => unknown>;
beforeEach(() => {
  localStorage.clear();
  apiModule.connect();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  answers = {};
  vi.spyOn(apiModule.api, "call").mockImplementation((async (def: { name: string }) => answers[def.name]!()) as never);
});
const page = (ui: ReactNode) => render(<MantineProvider><QueryClientProvider client={qc}><FailedBar />{ui}</QueryClientProvider></MantineProvider>);
const refuse = (word: string, why: string) => () => { throw new CallError(word, why); };
const bar = () => screen.queryAllByRole("alert").filter((el) => el.className.includes("banner")).map((el) => el.textContent);

/** Экран, который читает каталог моделей и своего блока с причиной не имеет. */
function Models({ name }: { name: string }) {
  const q = useCall(keysModels, { name });
  return <div>моделей {q.data?.models.length ?? "нет"}</div>;
}
/** Экран со своим блоком «Повторить». */
function ModelsWithBlock({ name }: { name: string }) {
  const q = useCall(keysModels, { name });
  return q.error ? <Failed error={q.error} retry={() => void q.refetch()} /> : <div>моделей {q.data?.models.length ?? "нет"}</div>;
}

describe("отказ чтения", () => {
  // чьё: слово пользователя 16 нояб. — «показ ошибок пользователю вместо скрытия»: чтение без своего блока больше не молчит
  it("отказ чтения — в полосе: чтение отказало — строка с запросом и причиной; прошло — строки нет", async () => {
    answers["keys.models"] = refuse("provider_error", "каталог моделей Meta не ответил: 502");
    page(<Models name="meta-down" />);
    await waitFor(() => expect(bar()).toEqual(["Не загрузилось: keys.models — provider_error: каталог моделей Meta не ответил: 502"]));
    answers["keys.models"] = () => ({ models: [{ id: "muse-spark-1.3" }] });
    await settle(() => qc.refetchQueries({ queryKey: ["keys.models"] }));
    await waitFor(() => expect(screen.getByText("моделей 1")).toBeTruthy());
    expect(bar()).toEqual([]);
  });

  // чьё: решение слепого архитектора — полоса смотрит в кэш чтений: строка не висит после ухода с экрана
  it("экран с отказавшим чтением закрыт — строка ушла: своего списка у полосы нет", async () => {
    answers["keys.models"] = refuse("provider_error", "каталог не ответил");
    const shown = page(<Models name="meta-down" />);
    await waitFor(() => expect(bar()).toHaveLength(1));
    shown.rerender(<MantineProvider><QueryClientProvider client={qc}><FailedBar /></QueryClientProvider></MantineProvider>);
    await waitFor(() => expect(bar()).toEqual([]));
  });

  // чьё: решение слепого архитектора — у отказа один показ: причину пишет блок на месте, полоса её не повторяет
  it("чтение со своим блоком «Повторить»: причина в блоке, в полосе строк 0; чтение без блока рядом — в полосе", async () => {
    answers["keys.models"] = refuse("provider_error", "каталог не ответил");
    page(<><ModelsWithBlock name="meta-down" /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy());
    expect(screen.getByText("provider_error: каталог не ответил")).toBeTruthy();
    expect(bar()).toEqual([]);
  });

  // чьё: код — так было и до дизайна: когда связи нет, говорит одна полоса связи, а не каждый запрос
  it("связи нет: отказ словом offline в полосу отказов не идёт", async () => {
    answers["keys.models"] = refuse("offline", "нет связи");
    page(<Models name="meta-down" />);
    await waitFor(() => expect(qc.getQueryCache().find({ queryKey: ["keys.models", { name: "meta-down" }] })?.state.status).toBe("error"));
    expect(bar()).toEqual([]);
  });
});

describe("отказ действия", () => {
  // чьё: код — так действия показывались и до дизайна (красный тост); имя запроса и адресат в заголовке — дизайн «Ошибки на виду»
  it("отказ действия — тостом: один красный тост с запросом, адресатом и причиной; ответа у действия нет", async () => {
    const show = vi.spyOn(notifications, "show").mockImplementation(() => "id");
    answers["session.stop"] = refuse("stopped", "сессия уже остановлена");
    expect(await apiModule.act(sessionStop, { to: "site@laptop" })).toBeUndefined();
    expect(show.mock.calls.map(([n]) => [n.title, n.message, n.color])).toEqual([["Не получилось: session.stop · site@laptop", "Остановлено: сессия уже остановлена", "red"]]);
  });

  // чьё: код — полоса связи одна на всё
  it("связи нет и полоса связи на виду — тоста нет; связь есть, а запрос не дошёл — тост", async () => {
    const show = vi.spyOn(notifications, "show").mockImplementation(() => "id");
    answers["session.stop"] = refuse("offline", "fetch failed");
    useFleet.setState({ link: "closed" });
    await apiModule.act(sessionStop, { to: "site@laptop" });
    expect(show).not.toHaveBeenCalled();
    useFleet.setState({ link: "open" });
    await apiModule.act(sessionStop, { to: "site@laptop" });
    expect(show).toHaveBeenCalledTimes(1);
  });

  // чьё: слово пользователя 16 нояб. — «вместо скрытия»: молчать можно только о двух запросах, список один
  it("молчат два запроса: отчёт об ошибке страницы и отписка от ленты; о любом другом молчать нельзя", () => {
    answers["obs.report"] = refuse("offline", "нет связи");
    expect(() => apiModule.quietly(obsReport, { part: "web", level: "error", msg: "x" })).not.toThrow();
    expect(() => apiModule.quietly(sessionStop, { to: "site@laptop" })).toThrow(/молчать об отказе этого запроса нельзя/);
  });

  // чьё: слово пользователя 16 нояб. — «вместо скрытия»: пустых обработчиков отказа у запросов страницы нет
  it("в коде страницы нет запроса к флоту с пустым обработчиком отказа: молчит только quietly", () => {
    const src = join(__dirname, "..");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []));
    /** запрос к флоту, чей отказ пойман и выброшен: .catch(() => {}), .catch(() => null), второй обработчик then — пустой */
    const EMPTY = /\.catch\(\(\)\s*=>\s*(\{\s*\}|null|undefined)\)|,\s*\(\)\s*=>\s*\{\s*\}\)/;
    const silent = files(src).filter((f) => !f.includes(join("src", "mock"))).flatMap((f) => readFileSync(f, "utf8").split("\n").filter((line) => EMPTY.test(line)).map(() => relative(src, f).replaceAll("\\", "/"))).sort();
    // api.ts — quietly: одно место на два молчащих запроса; lib/push.ts — подписка браузера на уведомления, не запрос к флоту
    expect(silent).toEqual(["api.ts", "lib/push.ts", "lib/push.ts", "lib/push.ts"]);
  });
});
