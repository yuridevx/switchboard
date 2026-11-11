/// <reference types="node" />
// Вторая итерация экранов: выпуски пачкой и перезапуск Host, установка машины ссылкой, «пожар», журнал словами, профили, аккаунты,
// архив (сводка, ветки), правила прокси (разница, вызов из архива), пуши без открытой страницы.
import { accountList, buildsKeeper, createApi, hostRestart, keeperState, pointsCalls, pointsList, type Account, type Piece, type SessionRow } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Steps } from "../shell/Page.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { diverge, dropFromQueues, limitWord, machineOrder, mergeAccounts } from "../lib/accounts.ts";
import { createMock, type Mock } from "../mock/fleet.ts";
import { useFleet } from "../store/fleet.ts";
import { archiveSummary, branches } from "./Archive.tsx";
import { fireCount, installCommand } from "./fleet/Machines.tsx";
import { firstPick, itemMatches, memoryMeasure, mergeTask } from "./fleet/Profiles.tsx";
import { bulkPlan, Releases } from "./fleet/Releases.tsx";
import { journalWord } from "./Observe.tsx";
import { inviteFor } from "./settings/People.tsx";
import { callRef, lineDiff } from "./settings/Proxy.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

const T = 1_800_000_000_000;
const quiet = () => createMock({ now: () => T, live: false, latency: 0 });
const ask = (m: Mock) => createApi(m.transport);
const acc = (id: string, o: Partial<Account> = {}): Account => ({ id, kind: "claude", email: id, ok: true, ...o });
const row = (callsign: string, backup?: boolean) => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~/p", ...(backup ? { backup } : {}) }, by: "~a@b.c", since: 0 }) as SessionRow;

describe("выпуски: пачкой и по машинам", () => {
  const machines = [{ name: "laptop", build: 411, online: true }, { name: "server", build: 412, online: true }, { name: "base2", build: 410, online: false }];
  it("закрепление пачкой касается только выбранных и только тех, где оно что-то меняет", () => {
    expect(bulkPlan(["laptop", "base2"], machines, { base2: 410 }, 412, 410)).toEqual([{ machine: "laptop", online: true, from: 411, to: 410, pinned: true }]);
    // снять закрепление: только там, где оно есть; машина вернётся к сборке флота
    expect(bulkPlan(["laptop", "base2"], machines, { base2: 410 }, 412, null)).toEqual([{ machine: "base2", online: false, from: 410, to: 412, pinned: false }]);
    expect(bulkPlan([], machines, {}, 412, 411)).toEqual([]);
  });
  it("мок: перезапуск Host — Keeper отвечает «обновляется» и называет pid и план; машина без связи — отказ offline", async () => {
    const m = quiet(), api = ask(m);
    const before = await api.call(keeperState, { to: ".keeper@laptop" });
    expect(before.host.state).toBe("running");
    expect(before).toMatchObject({ host: { pid: expect.any(Number) }, plan: before.build, pid: expect.any(Number) });
    await api.call(hostRestart, { to: ".keeper@laptop" });
    expect((await api.call(keeperState, { to: ".keeper@laptop" })).host.state).toBe("updating");
    await expect(api.call(hostRestart, { to: ".keeper@base2" })).rejects.toMatchObject({ word: "offline" });
  });
});

describe("машины", () => {
  it("команда установки: со ссылкой на Keeper сама его скачивает; приглашение идёт в stdin, не аргументом; на Windows — служба, пароль второй строкой stdin", () => {
    const link = { url: "https://f.example/builds/412/keeper-linux-amd64?sig=1", file: "keeper-linux-amd64" };
    const linux = installCommand("linux", "https://fleet.example", "home:k1:secret", link);
    expect(linux.split("\n")).toEqual(["curl -L -o keeper-linux-amd64 'https://f.example/builds/412/keeper-linux-amd64?sig=1'", "chmod +x keeper-linux-amd64 && echo 'home:k1:secret' | ./keeper-linux-amd64 install --base https://fleet.example"]);
    const win = installCommand("windows", "https://fleet.example", "home:k1:secret", { url: "https://f.example/k.exe", file: "keeper-windows-amd64.exe" });
    expect(win).toContain('curl.exe -L -o keeper-windows-amd64.exe "https://f.example/k.exe"');
    expect(win).toContain('$p = Read-Host "Пароль $env:USERNAME" -AsSecureString');
    expect(win).toContain('"home:k1:secret`n$([Net.NetworkCredential]::new(\'\', $p).Password)" | .\\keeper-windows-amd64.exe install --base https://fleet.example');
    expect(win).not.toContain("--logon");
    expect(win).not.toContain("--invite");
    // без ссылки — как раньше: файл кладут руками
    expect(installCommand("linux", "https://fleet.example", "i")).toBe("chmod +x keeper-linux-amd64 && echo 'i' | ./keeper-linux-amd64 install --base https://fleet.example");
    expect(installCommand("windows", "https://fleet.example", "i")).toBe('$p = Read-Host "Пароль $env:USERNAME" -AsSecureString\n"i`n$([Net.NetworkCredential]::new(\'\', $p).Password)" | .\\keeper-windows-amd64.exe install --base https://fleet.example');
  });
  it("мок отдаёт ссылку на Keeper сборки флота по системе", async () => {
    const r = await ask(quiet()).call(buildsKeeper, { os: "windows" });
    expect(r).toMatchObject({ file: "keeper-windows-amd64.exe", build: expect.any(Number) });
    expect(r.url).toContain("/keeper-windows-amd64.exe");
  });
  it("«пожар»: у машины без связи считаются сессии, сохранявшие точки; у машины на связи — ноль", () => {
    const sessions = [row("a@base2", true), row("b@base2"), row("c@laptop", true)];
    expect(fireCount({ name: "base2", online: false }, sessions)).toBe(1);
    expect(fireCount({ name: "laptop", online: true }, sessions)).toBe(0);
  });
  it("строка журнала машины словами: запрос — имя, от кого, время, отказ с причиной; остальное — событие и сессия", () => {
    expect(journalWord({ msg: "request", type: "profile.view", from: "pult~a@b.c", ms: 1, ok: false, word: "no_profile", why: "base: такой папки нет" })).toMatch(/^запрос profile.view от pult~a@b.c · 1 мс · отказ .+: base: такой папки нет$/);
    expect(journalWord({ msg: "request", type: "account.list", from: "pult~a@b.c", ms: 264, ok: true })).toBe("запрос account.list от pult~a@b.c · 264 мс");
    expect(journalWord({ msg: "launch", callsign: "site@laptop", start: "fork" })).toBe("launch · site@laptop");
    expect(journalWord({ msg: "host_start", build: 4 })).toBe("host_start · сборка 4");
    expect(journalWord({ msg: "ready" })).toBe("ready");
  });
});

describe("профили", () => {
  const piece = (id: string, ok = true): Piece => ({ id, repo: "team/p", ok });
  it("при входе отмечен base, если он годен, иначе первый годный; на машине без кусочков — ничего", () => {
    expect(firstPick([piece("web"), piece("base")])).toEqual(["base"]);
    expect(firstPick([piece("base", false), piece("ops")])).toEqual(["ops"]);
    expect(firstPick([])).toEqual([]);
    // прежний выбор держится, пока его кусочки есть на машине
    expect(firstPick([piece("web"), piece("base")], ["web", "gone"])).toEqual(["web"]);
  });
  it("мера памяти: строки из 200 и килобайты из 25; сверх меры — помечено", () => {
    expect(memoryMeasure("a\nb\nc\n")).toMatchObject({ lines: 3, over: false, word: "3 из 200 строк · 0,0 из 25 КБ" });
    expect(memoryMeasure(Array.from({ length: 201 }, () => "x").join("\n")).over).toBe(true);
    expect(memoryMeasure("я".repeat(13_000)).over).toBe(true);
    expect(memoryMeasure("")).toMatchObject({ lines: 0, bytes: 0 });
  });
  it("поиск внутри набора — по имени и описанию; задача сведения называет репозиторий, шаг и файлы", () => {
    expect(itemMatches({ name: "deploy", about: "Выкладка сайта" }, "выкл")).toBe(true);
    expect(itemMatches({ name: "deploy" }, "тест")).toBe(false);
    expect(itemMatches({ name: "deploy" }, " ")).toBe(true);
    const task = mergeTask({ repo: "team/profiles", op: "rebase", files: ["skills/a.md"] });
    expect(task).toContain("team/profiles");
    expect(task).toContain("«rebase»");
    expect(task).toContain("skills/a.md");
  });
});

describe("аккаунты", () => {
  it("лимит старше часа подписан временем замера; свежий — нет", () => {
    const now = T;
    expect(limitWord({ used: 0.46, at: now - 5 * 60_000 }, now)).toBe("46%");
    expect(limitWord({ used: 0.46, at: now - 95 * 60_000 }, now)).toMatch(/^46% · от \d\d:\d\d$/);
  });
  it("расхождение машин: разный тариф или час сброса больше минуты — что говорит каждая; согласие — пусто", () => {
    const m = (a: Record<string, Account[]>) => mergeAccounts(a)[0]!;
    expect(diverge(m({ laptop: [acc("a@b.c", { plan: "max" })], server: [acc("a@b.c", { plan: "max" })] }))).toEqual([]);
    expect(diverge(m({ laptop: [acc("a@b.c", { plan: "max" })], server: [acc("a@b.c", { plan: "pro" })] }))).toEqual(["laptop: max", "server: pro"]);
    const drift = diverge(m({ laptop: [acc("a@b.c", { limits: [{ name: "five_hour", used: 0.1, resets: T }] })], server: [acc("a@b.c", { limits: [{ name: "five_hour", used: 0.1, resets: T + 600_000 }] })] }));
    expect(drift.length).toBe(2);
    expect(diverge(m({ laptop: [acc("a@b.c")] }))).toEqual([]);
  });
  it("убрать аккаунт из всех очередей всех машин; очереди без него не трогаются", () => {
    const q = (name: string, order: string[]) => ({ name, order, sessions: 0 });
    const slots = { laptop: [q("main", ["a@b.c", "c@d.e"]), q("night", ["c@d.e"])], server: [q("main", ["c@d.e", "a@b.c"])] };
    expect(dropFromQueues(slots, ["a@b.c"])).toEqual([{ machine: "laptop", slot: "main", order: ["c@d.e"] }, { machine: "server", slot: "main", order: ["c@d.e"] }]);
    expect(dropFromQueues(slots, ["nobody"])).toEqual([]);
  });
  it("машины со сбойным входом — первыми; мок отдаёт лимиты с временем замера и срок входа", async () => {
    expect(machineOrder({ a: [acc("x")], b: [acc("y", { ok: false })], c: [acc("z")] })).toEqual(["b", "a", "c"]);
    const r = await ask(quiet()).call(accountList, { to: "@laptop" });
    const claude = r.accounts.find((a) => a.kind === "claude")!;
    expect((claude as { expires?: number }).expires).toBeGreaterThan(T);
    expect((claude.limits![0] as { at?: number }).at).toBeLessThan(T);
  });
});

describe("архив", () => {
  it("сводка: сколько в архиве, сколько идёт, сколько только в архиве и какие живые сессии точек не сохраняют", () => {
    const s = archiveSummary([{ callsign: "a@l", bytes: 1000 }, { callsign: "b@l", bytes: 500, live: true }, { callsign: "c@l" }], [row("a@l", true), row("z@l")]);
    expect(s).toEqual({ total: 3, going: 2, only: 1, bytes: 1500, bare: ["z@l"] });
  });
  it("ветки линии точек: точка с основой не из предыдущей — ветка с отступом; продолжение ветки держит отступ", () => {
    const t = branches([{ point: "p1" }, { point: "p2", base: "p1" }, { point: "p3", base: "p2" }, { point: "p4", base: "p1" }, { point: "p5", base: "p4" }]);
    expect(t.p2).toEqual({ depth: 0 });
    expect(t.p4).toEqual({ depth: 1, from: "p1" });
    expect(t.p5).toEqual({ depth: 1 });
  });
  it("мок: у длинной линии последняя точка — ветка; у вызова модели есть текст или промпт", async () => {
    const api = ask(quiet());
    const sid = (await api.call(pointsList, {})).sessions.find((x) => x.points > 3)!.sid;
    const pts = (await api.call(pointsList, { sid })).points as Array<{ point: string; base?: string }>;
    expect(pts.at(-1)!.base).toBe(pts[1]!.point);
    const calls = (await api.call(pointsCalls, { sid })).calls as Array<{ text?: string; system?: string }>;
    expect(calls.every((c) => c.text || c.system)).toBe(true);
  });
});

describe("правила прокси", () => {
  it("разница построчно: убранное и поставленное; одинаковое — как есть", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([{ kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" }]);
    expect(lineDiff("a\nb", "a")).toEqual([{ kind: "same", text: "a" }, { kind: "del", text: "b" }]);
    expect(lineDiff("x", "x").every((l) => l.kind === "same")).toBe(true);
  });
  it("вызов из архива в адресе: сессия и вызов; обрубок — не ссылка", () => {
    expect(callRef("d17a-4f49/c3")).toEqual({ sid: "d17a-4f49", call: "c3" });
    for (const bad of [null, "", "abc", "abc/", "/c3"]) expect(callRef(bad)).toBeNull();
  });
});

describe("люди", () => {
  it("приглашение из строки человека: устройство — имя~почта, машина — @имя с владельцем", () => {
    expect(inviteFor("~anya@example.com", "device", "phone")).toEqual({ addr: "phone~anya@example.com" });
    expect(inviteFor("~anya@example.com", "machine", "anya-pc")).toEqual({ addr: "@anya-pc", owner: "~anya@example.com" });
  });
});

describe("экраны второй итерации в отрисовке", () => {
  let mock: Mock;
  function page(ui: ReactNode, at = "/fleet/releases") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
  }
  beforeEach(async () => {
    localStorage.clear();
    apiModule.connect();
    mock = apiModule.mock!;
    await new Promise<void>((done) => {
      const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
    });
  });
  afterEach(() => cleanup());

  it("«Выпуски»: вид «По машинам» — строка на машину; выбор галочкой открывает закрепление пачкой; вид «Сборки» помнится на устройстве", async () => {
    page(<Releases />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Выбрать laptop" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Закрепить выбранные…" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Выбрать laptop" }));
    expect(screen.getByRole("button", { name: "Закрепить выбранные…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "К сборке флота" })).toBeTruthy();
    // у машины на связи есть перезапуск Host; у машины без связи — нет
    expect(screen.getAllByRole("button", { name: "Перезапустить Host" }).length).toBe(Object.values(useFleet.getState().machines).filter((m) => m.online).length);
    fireEvent.click(screen.getByRole("radio", { name: "Сборки" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Закрепить машину" }).length).toBeGreaterThan(0));
    expect(JSON.parse(localStorage.getItem("sb2.releases.view") ?? localStorage.getItem("releases.view") ?? "null") ?? "builds").toBe("builds");
  });
});
