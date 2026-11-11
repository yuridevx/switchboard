/// <reference types="node" />
// Наблюдение первого класса и находки архива: ряды и числа Host, машины в сводке здоровья, оповещения о машине и сессии,
// переход к найденной записи, сводка архива, время замера лимитов, номера сообщений вызова.
import { accountList, createApi, HostMetrics, machineMetrics, obsHealth, obsSeries, pointsList, pointsStats, type Account } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Steps } from "./shell/Page.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "./api.ts";
import { mergeAccounts, pollPlan } from "./lib/accounts.ts";
import { hostLine, HostNumbers, seriesPoints, sessionsWord } from "./lib/metrics.tsx";
import { createMock } from "./mock/fleet.ts";
import { runsOfRecord, statsLines } from "./screens/Archive.tsx";
import { Machine } from "./screens/Machine.tsx";
import { alertsToSave } from "./screens/settings/Fleetwide.tsx";
import { callParts } from "./screens/settings/Proxy.tsx";
import { useFleet } from "./store/fleet.ts";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(cleanup);

const T = 1_800_000_000_000, MIN = 60_000;
const win = (at: number, o: Partial<HostMetrics> = {}): HostMetrics => ({ at, sessions: { busy: 1, idle: 2 }, queue: 0, provider: { n: 10, p50: 1000, p95: 3000, failed: 0, retries: 0 }, crashes: 0, resumes: 0, ...o });
const quiet = () => createApi(createMock({ now: () => T, live: false, latency: 0 }).transport);

describe("числа Host", () => {
  it("ряд по минутам складывается в отрезки: медиана — по вызовам, 95% — худший, сбои — суммой, сессии — на конец отрезка", () => {
    const rows = [
      win(T, { provider: { n: 10, p50: 1000, p95: 3000, failed: 1, retries: 0 }, crashes: 1, resumes: 1 }),
      win(T + MIN, { provider: { n: 30, p50: 2000, p95: 2500, failed: 0, retries: 2 }, sessions: { busy: 3, waiting: 1, stopped: 2 }, queue: 4 }),
      win(T + 10 * MIN),
    ];
    const pts = seriesPoints(rows, T, T + 20 * MIN, 2);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ at: T, p50: 1750, p95: 3000, calls: 40, failed: 1, retries: 2, crashes: 1, resumes: 1, busy: 3, waiting: 1, idle: 0, other: 2, queue: 4 });
    expect(pts[1]).toMatchObject({ at: T + 10 * MIN, calls: 10, busy: 1, idle: 2 });
  });
  it("отрезок без вызовов не даёт времени провайдера; строки вне периода не входят; пустые отрезки пропущены", () => {
    const pts = seriesPoints([win(T - MIN), win(T, { provider: { n: 0, p50: 0, p95: 0, failed: 0, retries: 0 } }), win(T + 59 * MIN)], T, T + 60 * MIN, 60);
    expect(pts.map((p) => p.at)).toEqual([T, T + 59 * MIN]);
    expect(pts[0]).toMatchObject({ p50: 0, p95: 0, calls: 0 });
  });
  it("сессии по состояниям — словами, только где кто-то есть", () => {
    expect(sessionsWord({ idle: 2, busy: 1, failed: 0, waiting: 1 })).toBe("работает 1 · ждёт вас 1 · свободна 2");
    expect(sessionsWord({})).toBe("нет");
  });
  it("строка машины в сводке: только то, что есть — очередь, провайдер, сбои", () => {
    expect(hostLine(win(T))).toBe("работает 1 · свободна 2 · провайдер 95% 3 с");
    expect(hostLine(win(T, { sessions: {}, queue: 2, provider: { n: 0, p50: 0, p95: 0, failed: 0, retries: 0 }, crashes: 1 }))).toBe("сессий нет · в очереди ввода 2 · процесс вышел 1");
  });
  it("последнее окно словами: сессии, очередь, провайдер, сбои процессов", () => {
    render(<MantineProvider><HostNumbers m={win(T, { queue: 3, provider: { n: 12, p50: 800, p95: 4200, failed: 2, retries: 1 }, crashes: 2, resumes: 1 })} /></MantineProvider>);
    expect(screen.getByText("работает 1 · свободна 2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/медиана 800 мс · 95% .* · вызовов 12 · отказов 2 · повторов 1/)).toBeTruthy();
    expect(screen.getByText("вышли сами 2 · возобновлено 1")).toBeTruthy();
  });
  it("мок отдаёт числа в форме договора: окно машины, ряд, машины в сводке здоровья", async () => {
    const api = quiet();
    expect(HostMetrics.safeParse(await api.call(machineMetrics, { to: "@laptop" })).success).toBe(true);
    const s = await api.call(obsSeries, { machine: "laptop", since: T - 60 * MIN, until: T });
    expect(s.rows).toHaveLength(60);
    expect(s.rows[0]!.at).toBeLessThan(s.rows.at(-1)!.at);
    expect(s.rows.every((r) => HostMetrics.safeParse(r).success)).toBe(true);
    const h = await api.call(obsHealth, {});
    expect(h.hosts!.map((x) => x.machine).sort()).toEqual(h.hosts!.map((x) => x.machine).sort().filter((m) => m !== "base2"));
    expect(h.hosts!.length).toBe(h.machines.online);
    await expect(api.call(machineMetrics, { to: "@base2" })).rejects.toMatchObject({ word: "offline" });
  });
});

describe("оповещения о сбоях", () => {
  it("в настройку идут только отличия: порог машины по умолчанию не пишется, выключенные случаи пишутся явно", () => {
    expect(alertsToSave({ rate: 0.3, offline: 10 })).toEqual({ rate: 0.3 });
    expect(alertsToSave({ offline: 0, failed: false })).toEqual({ offline: 0, failed: false });
    expect(alertsToSave({ offline: 30, failed: undefined, to: ["~a@b.c"] })).toEqual({ offline: 30, to: ["~a@b.c"] });
  });
});

describe("архив: найденная запись и сводка", () => {
  it("строки найденной записи идут отдельным куском; без записи лента — один кусок", () => {
    const rows = [{ key: "u1:0" }, { key: "u2:0" }, { key: "u2:1" }, { key: "u3:0" }, { key: "r7" }];
    expect(runsOfRecord(rows, "u2").map((r) => [r.hit, r.rows.map((x) => x.key)])).toEqual([[false, ["u1:0"]], [true, ["u2:0", "u2:1"]], [false, ["u3:0", "r7"]]]);
    expect(runsOfRecord(rows).map((r) => r.hit)).toEqual([false]);
    // номер другой записи с тем же началом не цепляется
    expect(runsOfRecord([{ key: "u22:0" }], "u2")[0]!.hit).toBe(false);
  });
  it("мок: поиск называет запись с найденным словом и строку с окружением", async () => {
    const api = quiet();
    const all = await api.call(pointsList, {});
    const word = "шапк";
    const found = await api.call(pointsList, { q: word });
    expect(found.sessions.length).toBeGreaterThan(0);
    expect(found.sessions.length).toBeLessThanOrEqual(all.sessions.length);
    const withRecord = found.sessions.filter((s) => s.hitUuid);
    expect(withRecord.length).toBeGreaterThan(0);
    for (const s of withRecord) expect(s.hit!.toLowerCase()).toContain(word);
  });
  it("сводка архива: всего и по машинам, пустые машины не показаны, большие первыми", async () => {
    const st = await quiet().call(pointsStats, {});
    expect(st.machines.reduce((n, m) => n + m.sessions, 0)).toBe(st.sessions);
    const lines = statsLines({ sessions: 3, points: 12, blocks: 30, bytes: 3 * 1024 * 1024, machines: [{ machine: "a", sessions: 1, points: 2, blocks: 4, bytes: 1024 }, { machine: "b", sessions: 2, points: 10, blocks: 26, bytes: 2 * 1024 * 1024 }, { machine: "c", sessions: 0, points: 0, blocks: 0, bytes: 0 }] }, (m) => m.toUpperCase());
    expect(lines.total).toMatch(/^3 сесси.* · 12 точ.* · /);
    expect(lines.machines.map((m) => m.machine)).toEqual(["b", "a"]);
    expect(lines.machines[0]!.line.startsWith("B: 2 сесси")).toBe(true);
  });
});

describe("аккаунты: время замера и срок входа", () => {
  const acc = (o: Partial<Account>): Account => ({ id: "a@b.c", kind: "claude", email: "a@b.c", ok: true, ...o });
  it("время замера берётся у окна, а если его нет — у аккаунта", () => {
    const old = T - 3 * 60 * MIN;
    const [m] = mergeAccounts({ laptop: [acc({ at: old, limits: [{ name: "five_hour", used: 0.4 }, { name: "seven_day", used: 0.2, at: T }] })] });
    expect(m!.limits.map((l) => l.at)).toEqual([old, T]);
  });
  it("план опроса: свежий замер аккаунта опроса не требует, даже когда у окон времени нет", () => {
    expect(pollPlan({ laptop: [{ kind: "claude", id: "a", email: "a@b.c", at: T - MIN, limits: [{}] }] }, T)).toEqual([]);
    expect(pollPlan({ laptop: [{ kind: "claude", id: "a", email: "a@b.c", limits: [{}] }] }, T)).toEqual(["laptop"]);
  });
  it("мок отдаёт время замера и срок входа в форме договора", async () => {
    const { accounts } = await quiet().call(accountList, { to: "@laptop" });
    const claude = accounts.filter((a) => a.kind === "claude");
    expect(claude.length).toBeGreaterThan(0);
    for (const a of claude) {
      expect(typeof a.at).toBe("number");
      expect(typeof a.expires).toBe("number");
    }
  });
});

describe("проверка правил на вызове", () => {
  it("сообщения вызова названы с единицы, хотя служба считает их с нуля", () => {
    const parts = callParts({ system: "", messages: [{ n: 0, role: "user", text: "проверь" }, { n: 1, role: "assistant", text: "смотрю" }] });
    expect(parts.map((p) => [p.id, p.word])).toEqual([["m0", "Человек · 1"], ["m1", "Модель · 2"]]);
  });
});

describe("экран машины", () => {
  function page(ui: ReactNode, at: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="/machine/:name" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
  }
  beforeEach(async () => {
    localStorage.clear();
    apiModule.connect();
    const mock = apiModule.mock!;
    await new Promise<void>((done) => {
      const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
    });
  });
  it("у машины на связи — её числа Host; у машины без связи блока нет", async () => {
    page(<Machine />, "/machine/laptop");
    await waitFor(() => expect(screen.getByText("Числа Host")).toBeTruthy());
    expect(screen.getByText("Очередь ввода")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Период рядов" })).toBeTruthy();
    cleanup();
    page(<Machine />, "/machine/base2");
    await waitFor(() => expect(screen.getByText("Что на ней стояло")).toBeTruthy());
    expect(screen.queryByText("Числа Host")).toBeNull();
  });
});
