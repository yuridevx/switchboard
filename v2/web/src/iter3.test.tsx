/// <reference types="node" />
// Третья итерация страницы: порядок одним жестом, профили (слои промпта, память, репозитории), точки в инспекторе, ближние машины подъёма,
// HTML-документ вне блока кода, план опроса лимитов, части вызова для проверки правил, alias-модели ключа, «браузер устарел», состав строки списка.
import { createApi, pointsCall, type Piece, type SessionRow } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLine } from "./common.tsx";
import { pollPlan } from "./lib/accounts.ts";
import { browserLacks } from "./lib/browser.ts";
import { nudge, Sortable } from "./lib/Sortable.tsx";
import { createMock } from "./mock/fleet.ts";
import { nearFirst, raiseInput } from "./screens/archive/Raise.tsx";
import { byUse } from "./shell/NewSession.tsx";
import { memoryType, promptLayers, repoUse, tabOfKind } from "./screens/fleet/Profiles.tsx";
import { callParts } from "./screens/settings/Proxy.tsx";
import { modelsFor } from "./session/doc.ts";
import { fenceHtml } from "./session/html.tsx";
import { pointsHead } from "./session/Inspector.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(cleanup);

const T = 1_800_000_000_000;
const row = (callsign: string, spec: Partial<SessionRow["spec"]> = {}, o: Partial<SessionRow> = {}) => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~/p", ...spec }, by: "~a@b.c", since: 0, ...o }) as SessionRow;

describe("порядок перетаскиванием — один жест", () => {
  it("с клавиатуры строка сдвигается на одно место; у края порядок тот же", () => {
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    const ids = ["a", "b"];
    expect(nudge(ids, "a", -1)).toBe(ids);
    expect(nudge(ids, "x", 1)).toBe(ids);
  });
  it("ручка в фокусе: Alt+↓ меняет порядок, стрелка без Alt — нет", () => {
    const onOrder = vi.fn();
    render(<MantineProvider><Sortable ids={["a", "b", "c"]} label={(id) => id.toUpperCase()} onOrder={onOrder} row={(id) => <span>{id}</span>} /></MantineProvider>);
    const grip = screen.getByRole("button", { name: "Порядок: A" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onOrder).not.toHaveBeenCalled();
    fireEvent.keyDown(grip, { key: "ArrowDown", altKey: true });
    expect(onOrder).toHaveBeenCalledWith(["b", "a", "c"]);
  });
});

describe("профили", () => {
  const pieces = [{ id: "base", repo: "team/profiles", ok: true }, { id: "web", repo: "team/profiles", ok: true }, { id: "ops", repo: "team/ops", ok: true }] as Piece[];
  it("за репозиторием — его кусочки и сессии, у которых они в документе", () => {
    const use = repoUse("team/profiles", pieces, [row("site@laptop", { pieces: ["base", "web"] }), row("deploy@server", { pieces: ["ops"] }), row("bare@laptop")]);
    expect(use).toEqual({ pieces: ["base", "web"], sessions: ["site@laptop"] });
  });
  it("вид строки набора ведёт на свою вкладку", () => {
    expect([tabOfKind("skill"), tabOfKind("instructions"), tabOfKind("memory"), tabOfKind("setting"), tabOfKind("неизвестный")]).toEqual(["skills", "rules", "memory", "settings", undefined]);
  });
  it("слои промпта: основа, агент, стиль, добавка, инструкции и индекс памяти — с размером, где он известен", () => {
    const layers = promptLayers({
      prompt: { agent: { name: "reviewer", from: "base", path: "agents/reviewer.md" }, append: "Пиши по-русски" },
      files: { base: [{ path: "agents/reviewer.md", size: 2048 }, { path: "CLAUDE.md", size: 700 }, { path: "memory/MEMORY.md", size: 300 }] },
      items: [{ kind: "instructions", name: "CLAUDE.md", piece: "base", path: "CLAUDE.md" }, { kind: "memory", name: "MEMORY.md", piece: "base", path: "memory/MEMORY.md" }, { kind: "skill", name: "deploy", piece: "base" }],
    });
    expect(layers.map((l) => l.layer)).toEqual(["основа", "агент", "добавка", "инструкции", "индекс памяти"]);
    expect(layers[1]).toEqual({ layer: "агент", name: "reviewer", bytes: 2048 });
    expect(layers[2]!.bytes).toBe(new TextEncoder().encode("Пиши по-русски").length);
    expect(layers[0]!.bytes).toBeUndefined();
  });
  it("тип записи памяти — названный, из описания или из имени файла; иначе «прочее»", () => {
    expect([memoryType({ type: "user" }), memoryType({ about: "feedback: не писать числа" }), memoryType({ path: "memory/project_v2.md" }), memoryType({ about: "заметка" })]).toEqual(["user", "feedback", "project", "прочее"]);
  });
});

describe("новая сессия", () => {
  it("кусочки в выборе: чаще стоящие у сессий — раньше", () => {
    const sessions = { a: row("a@m", { pieces: ["web", "ops"] }), b: row("b@m", { pieces: ["web"] }) };
    expect(byUse([{ id: "base" }, { id: "ops" }, { id: "web" }], sessions).map((p) => p.id)).toEqual(["web", "ops", "base"]);
  });
});

describe("точки в инспекторе", () => {
  it("заголовок: сколько точек, когда последняя и её размер; сбой последней — словами и когда повтор", () => {
    expect(pointsHead([], {}).word).toBe("Точек пока нет");
    const h = pointsHead([{ at: T - 3_600_000 }, { at: T, bytes: 2 << 20 }], { archiveError: "хранилище не ответило", archiveRetryAt: T + 600_000 });
    expect(h.word).toMatch(/^2 точки · последняя .* · 2,0 МБ$/);
    expect(h.error).toMatch(/^Последняя точка не сохранилась: хранилище не ответило · повтор в \d\d:\d\d$/);
    expect(pointsHead([{ at: T }], {}).error).toBeUndefined();
  });
});

describe("подъём из архива", () => {
  it("машины, где уже идут сессии проекта, стоят первыми и названы ближними", () => {
    const sessions = [row("a@server", { project: "site" }), row("b@laptop", { project: "infra" }), row("c@wsl", { project: "site" })];
    expect(nearFirst(["laptop", "server", "wsl", "base2"], "site", sessions)).toEqual({ order: ["server", "wsl", "base2", "laptop"], near: ["server", "wsl"] });
    expect(nearFirst(["laptop", "server"], undefined, sessions)).toEqual({ order: ["laptop", "server"], near: [] });
  });
  it("перенос живой сессии идёт с move и без точки: прежняя машина снимает свежую", () => {
    const s = { sid: "s1", machine: "laptop", callsign: "site@laptop", points: 3, last: T, cwd: "~/p" };
    expect(raiseInput("move", s, { machine: "server", name: "site", cwd: "~/p", account: "auto", files: "point", point: "p2" })).toEqual({ to: "@server", sid: "s1", files: "point", move: true });
  });
});

describe("HTML-документ в ответе", () => {
  it("целый документ без блока кода оборачивается в блок html; обычный текст и кусок разметки — как есть", () => {
    expect(fenceHtml("<!doctype html>\n<html><body>привет</body></html>\n")).toBe("```html\n<!doctype html>\n<html><body>привет</body></html>\n```");
    expect(fenceHtml("Вот страница: <b>жирно</b>")).toBe("Вот страница: <b>жирно</b>");
    expect(fenceHtml("<html><body>без конца")).toBe("<html><body>без конца");
  });
});

describe("опрос лимитов", () => {
  const acc = (email: string, at?: number) => ({ kind: "claude", id: email, email, limits: [{ at }] });
  it("одна машина на почту с замером старше двух минут; свежие и ключи флота не опрашиваются; машин — минимум", () => {
    const plan = pollPlan({
      laptop: [acc("a@x.com", T - 300_000), acc("b@x.com", T - 300_000)],
      server: [acc("a@x.com", T - 300_000), acc("c@x.com", T - 10_000)],
      wsl: [acc("b@x.com", T - 300_000), { kind: "key", id: "deepseek" }],
    }, T);
    expect(plan).toEqual(["laptop"]);
    expect(pollPlan({ laptop: [acc("a@x.com", T - 1000)] }, T)).toEqual([]);
    // без времени замера — опросить
    expect(pollPlan({ server: [acc("a@x.com")] }, T)).toEqual(["server"]);
  });
});

describe("проверка правил на вызове из архива", () => {
  it("части вызова: промпт и последние сообщения, у каждой — где её ищут правила", () => {
    const parts = callParts({ system: "Ты в репозитории", messages: [{ n: 1, role: "user", text: "проверь" }, { n: 2, role: "assistant", text: "" }, { n: 3, role: "tool", text: "ok" }] });
    expect(parts.map((p) => [p.id, p.scope])).toEqual([["system", "system"], ["m1", "user"], ["m3", "tool_result"]]);
    expect(callParts(undefined)).toEqual([]);
  });
  it("мок отдаёт текст вызова в форме договора", async () => {
    const api = createApi(createMock({ now: () => T, live: false, latency: 0 }).transport);
    const r = await api.call(pointsCall, { sid: "s1", call: "c1" });
    expect(r.system).toMatch(/internal\.example\.com/);
    expect(r.messages[0]).toMatchObject({ n: 0, role: "user" });
  });
});

describe("сессия на ключе флота", () => {
  const sdk = [{ value: "claude-opus-5-5", label: "Opus" }];
  it("модель выбирается из alias-моделей ключа; их нет — одна модель ключа; у входа Claude — список SDK", () => {
    expect(modelsFor({ kind: "key", model: "orca/flash", models: { fast: "orca/flash", smart: "orca/glm" } }, sdk)).toEqual([{ value: "fast", label: "fast → orca/flash" }, { value: "smart", label: "smart → orca/glm" }]);
    expect(modelsFor({ kind: "key", model: "orca/flash" }, sdk)).toEqual([{ value: "orca/flash", label: "orca/flash" }]);
    expect(modelsFor({ kind: "claude" }, sdk)).toBe(sdk);
  });
});

describe("браузер устарел", () => {
  it("называет, чего не хватает; полный браузер — пусто", () => {
    const full = { WebSocket: function () {}, structuredClone: () => 0, crypto: { subtle: {} }, CSS: { supports: () => true } };
    expect(browserLacks(full)).toEqual([]);
    expect(browserLacks({ ...full, WebSocket: undefined, CSS: { supports: () => false } })).toEqual(["соединения WebSocket", "селектора :has в стилях"]);
    expect(browserLacks({ ...full, crypto: {} })).toEqual(["криптографии (страница открыта не по https)"]);
  });
});

describe("состав строки списка", () => {
  it("«Вид списка» убирает из строки позывной и время; заголовок остаётся", () => {
    const s = row("site@laptop", {}, { title: "Шапка сайта", doing: "правит Header.tsx", last: Date.now() - 120_000 });
    const qc = new QueryClient();
    const wrap = (el: React.ReactNode) => <QueryClientProvider client={qc}><MantineProvider>{el}</MantineProvider></QueryClientProvider>;
    const { rerender } = render(wrap(<SessionLine s={s} onPick={() => {}} />));
    expect(screen.getByText("site@laptop")).toBeTruthy();
    expect(screen.getByText(/правит Header\.tsx/)).toBeTruthy();
    rerender(wrap(<SessionLine s={s} onPick={() => {}} parts={{ call: false, doing: false, when: false }} />));
    expect(screen.queryByText("site@laptop")).toBeNull();
    expect(screen.queryByText(/правит Header\.tsx/)).toBeNull();
    expect(screen.getByText("Шапка сайта")).toBeTruthy();
  });
});
