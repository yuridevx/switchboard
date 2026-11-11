/// <reference types="node" />
// Сценарии плана тестов страницы — вход на настоящем флоте: приглашение в адресе, отклонённое приглашение, нет связи.
// Флот здесь поддельный на уровне api.ts: страница идёт веткой «не мок».
import { CallError } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
const fleet = vi.hoisted(() => ({
  invite: "", key: "", accepted: [] as string[], opened: 0,
  accept: async (_invite: string): Promise<void> => {},
  whoami: async (): Promise<unknown> => ({}),
}));

vi.mock("../api.ts", async () => {
  const { CallError: Err } = await import("@sb/protocol");
  const sayError = (e: unknown) => (e instanceof Err ? `${e.word}${e.why ? `: ${e.why}` : ""}` : e instanceof Error ? e.message : String(e));
  return {
    isMock: false, mock: null, fleetBase: "https://fleet.example",
    connect: () => {},
    inviteInHash: () => fleet.invite,
    inviteFrom: (t: string) => t.trim(),
    acceptInvite: async (invite: string) => { await fleet.accept(invite); fleet.accepted.push(invite); fleet.key = "home:k1a2b3:secretsecretsecret"; },
    keyStore: { get: () => fleet.key, set: (k: string) => void (fleet.key = k) },
    api: { call: async (def: { name: string }) => (def.name === "whoami" ? fleet.whoami() : {}) },
    act: async () => undefined,
    sayError, sayWord: (w?: string) => w ?? "",
  };
});
vi.mock("./link.ts", async () => {
  const { create } = await import("zustand");
  return { useLink: create(() => ({ state: "open", seen: 0 })), openPage: () => void fleet.opened++, closePage: () => {}, linkWord: () => "" };
});

import { useFleet } from "../store/fleet.ts";
import { Gate } from "./Gate.tsx";

const show = () => render(<MantineProvider><MemoryRouter><Gate><p>экран «Работа»</p></Gate></MemoryRouter></MantineProvider>);
afterEach(() => {
  cleanup();
  Object.assign(fleet, { invite: "", key: "", accepted: [], opened: 0, accept: async () => {}, whoami: async () => ({}) });
  useFleet.setState({ rev: 0 });
});

describe("вход на флот", () => {
  it("1 · приглашение в адресе — оно принято, соединение открыто, человек видит экран", async () => {
    // источник: память «прототипы и страницы давать ссылкой с #invite=» — слово пользователя
    fleet.invite = "home%3Ak9z9z9%3Anewnewnewnewnewnew";
    show();
    await waitFor(() => expect(fleet.opened).toBe(1));
    expect(fleet.accepted).toEqual(["home:k9z9z9:newnewnewnewnewnew"]);
    // картина флота пришла — экран открыт
    useFleet.setState({ rev: 1 });
    expect(await screen.findByText("экран «Работа»")).toBeTruthy();
  });

  it("2 · приглашение не принято — экран «Нужно приглашение» с причиной словом; соединение не открывается", async () => {
    // источник: устав «ошибки — словами»
    fleet.invite = "home%3Ak9z9z9%3Aused";
    fleet.accept = async () => { throw new CallError("bad_invite", "приглашение уже использовано"); };
    show();
    expect(await screen.findByText("Нужно приглашение")).toBeTruthy();
    expect(screen.getByText(/приглашение уже использовано/)).toBeTruthy();
    expect(fleet.opened).toBe(0);
    expect(screen.queryByText("экран «Работа»")).toBeNull();
  });

  it("4 · пропуск уже есть, а в адресе приглашение — замена только по выбору: «Оставить прежний» входит без приглашения", async () => {
    // источник: чьё: код
    fleet.key = "home:k1a2b3:secretsecretsecret";
    fleet.invite = "home%3Ak9z9z9%3Anewnewnewnewnewnew";
    show();
    expect(await screen.findByText("На этом устройстве уже есть пропуск")).toBeTruthy();
    expect(fleet.accepted).toEqual([]);
    expect(fleet.opened).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Оставить прежний" }));
    await waitFor(() => expect(fleet.opened).toBe(1));
    expect(fleet.accepted).toEqual([]);
    cleanup();
    Object.assign(fleet, { opened: 0 });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Заменить пропуск" }));
    await waitFor(() => expect(fleet.accepted).toEqual(["home:k9z9z9:newnewnewnewnewnew"]));
  });

  it("3 · флот не отвечает при входе — экран «Нет связи с флотом»; «Повторить» входит, когда связь вернулась", async () => {
    // источник: закрытый список устава «прямой запрос не прошёл — отказ словом»
    fleet.key = "home:k1a2b3:secretsecretsecret";
    fleet.whoami = async () => { throw new CallError("offline", "fetch failed"); };
    show();
    expect(await screen.findByText("Нет связи с флотом")).toBeTruthy();
    expect(fleet.opened).toBe(0);
    fleet.whoami = async () => ({});
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(fleet.opened).toBe(1));
  });
});
