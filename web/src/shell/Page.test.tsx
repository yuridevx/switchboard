// Страница шага: адрес, «Назад», подтверждение страницей, поиск.
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDanger } from "../common.tsx";
import { findIn } from "./Find.tsx";
import { Page, Steps } from "./Page.tsx";

afterEach(cleanup);

function Screen() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const go = useNavigate();
  return (
    <>
      <output data-testid="at">{loc.pathname + loc.search}</output>
      <button type="button" onClick={() => setOpen(true)}>Добавить</button>
      <button type="button" onClick={() => go(-1)}>назад браузера</button>
      <Page name="add" opened={open} onClose={() => setOpen(false)} title="Добавить машину"><p>форма</p></Page>
      <Steps />
    </>
  );
}
const page = () => render(<MantineProvider><MemoryRouter initialEntries={["/fleet/machines"]}><Screen /></MemoryRouter></MantineProvider>);

describe("страница шага", () => {
  it("открытый шаг стоит в адресе; «Назад» браузера закрывает его", async () => {
    page();
    fireEvent.click(screen.getByText("Добавить"));
    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/fleet/machines?do=add"));
    expect(screen.getByRole("heading", { name: "Добавить машину" })).toBeTruthy();
    fireEvent.click(screen.getByText("назад браузера"));
    await waitFor(() => expect(screen.queryByText("форма")).toBeNull());
    expect(screen.getByTestId("at").textContent).toBe("/fleet/machines");
  });

  it("опасное действие — страница: «Отмена» ничего не делает, красная кнопка выполняет", async () => {
    page();
    const run = vi.fn();
    const ask = () => confirmDanger({ title: "Удалить site@laptop?", body: "Точки останутся в архиве.", confirm: "Удалить", onConfirm: run });
    ask();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Удалить site@laptop?" })).toBeTruthy());
    expect(screen.getByText("Точки останутся в архиве.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Удалить site@laptop?" })).toBeNull());
    expect(run).not.toHaveBeenCalled();
    ask();
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull());
  });
});

describe("поиск", () => {
  it("находит по всем словам запроса в названии, описании и ключевых словах", () => {
    const items = [
      { label: "Сайт", about: "site@laptop · работает", words: ["/home/me/site", "Магазин"] },
      { label: "Машина laptop", about: "на связи", words: ["laptop"] },
    ];
    expect(findIn(items, "магазин site").map((x) => x.label)).toEqual(["Сайт"]);
    expect(findIn(items, "laptop").length).toBe(2);
    expect(findIn(items, "нет такого")).toEqual([]);
    expect(findIn(items, "  ").length).toBe(2);
  });
});
