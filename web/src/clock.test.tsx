/// <reference types="node" />
// Часы теста страницы (src/test-clock.ts): живой мок флота в тесте идёт по часам теста, а не по настоящим.
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMock } from "./mock/fleet.ts";
import { useFleet } from "./store/fleet.ts";

/** Настоящие таймеры процесса теста: их видит Node, часы теста их не подделывают. */
const realTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const Doing = () => <output>{useFleet((s) => s.sessions["site@laptop"]?.doing ?? "")}</output>;
const doing = () => screen.getByRole("status").textContent;

describe("часы теста", () => {
  it("1 · мок на часах теста: живой мок не заводит настоящих таймеров; ответ, первый кадр и такт сессий приходят, только когда тест двигает время", async () => {
    // чьё: факт — мок отвечает через 90 мс и сам меняет сессии раз в 1,6 с
    const t0 = Date.now(), was = realTimers();
    // живой, как в браузере: задержка ответа и такт сессий
    const mock = createMock();
    const replies: unknown[] = [];
    void mock.transport.call({ type: "whoami", id: "w1" }).then((r) => replies.push(r));
    const link = mock.transport.open("page", { onFrame: (f) => useFleet.getState().apply(f) });
    // такт, ответ и первый кадр — на часах теста; настоящих таймеров не прибавилось (между замерами нет ни одного оборота цикла событий)
    expect(vi.getTimerCount()).toBe(3);
    expect(realTimers() - was).toBe(0);
    render(<Doing />);
    await act(() => vi.advanceTimersByTimeAsync(89));
    expect(replies).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(replies).toHaveLength(1);
    expect(doing()).toBe("Правит src/components/Header.tsx");
    // такт сессий: до 1,6 с сессия прежняя, на 1,6 с — сделала шаг
    await act(() => vi.advanceTimersByTimeAsync(1600 - 90 - 1));
    expect(doing()).toBe("Правит src/components/Header.tsx");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(doing()).toBe("Ищет файлы");
    // время двигал только тест
    expect(Date.now() - t0).toBe(1600);
    // тест кончился: таймеров мока не осталось ни на часах теста, ни настоящих (их и не заводилось — проверено выше)
    link.close();
    mock.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
