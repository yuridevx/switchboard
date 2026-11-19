/// <reference types="node" />
// Экран «Настройки → GitHub» на моке флота: при замене приложения владельца нового называет человек — поле стоит у кнопки замены.
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

import * as apiModule from "../../api.ts";
import type { Mock } from "../../mock/fleet.ts";
import { useFleet } from "../../store/fleet.ts";
import { GitHub, setupAsk } from "./Rest.tsx";

let mock: Mock;
let link: { close(): void } | null = null;
const LONG = { timeout: 4000 };

beforeEach(async () => {
  apiModule.connect();
  mock = apiModule.mock!;
  await new Promise<void>((done) => {
    link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), done()) });
  });
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), link?.close(), mock.stop()));

describe("«Настройки → GitHub»", () => {
  // чьё: факт (приложение флота может жить в личном аккаунте, а стоять на организации: при замене формы без организации приложение на неё не встанет)
  it("замена приложения называет организацию: поле стоит у кнопки замены, запрос несёт её и слово замены", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MantineProvider><QueryClientProvider client={qc}><GitHub /></QueryClientProvider></MantineProvider>);
    // приложение уже установлено: админ видит замену и поле организации рядом с ней
    expect(await screen.findByRole("button", { name: "Заменить приложение" }, LONG)).toBeTruthy();
    expect(screen.getByLabelText("Организация")).toBeTruthy();
    const at = { origin: "https://f.example", pathname: "/" };
    expect(setupAsk(" team ", true, at)).toEqual({ redirect: "https://f.example/?open=settings/github", org: "team", replace: true });
    expect(setupAsk("", false, at)).toEqual({ redirect: "https://f.example/?open=settings/github" });
  });
});
