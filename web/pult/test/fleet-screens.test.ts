// Эталоны экранов флота по прототипу «Пульт и телефон» (подписан пользователем 2 нояб.: «основа дизайна ок»):
// машины строками с фильтрами и раскрытием, вход аккаунта на любой машине с активной ссылкой.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, fleetRelay, fleetRoster, pult, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
const rows = (t: P) => t.$$("[data-row]").map((r) => r.getAttribute("data-row"));

describe("машины", () => {
  function relayWith() {
    const relay = fleetRelay();
    relay.handlers["keeper.state"] = (f) => {
      const m = String(f.to).split("@")[1];
      return {
        ok: true,
        result: {
          keeper: "1.0.5",
          rev: 9,
          os: m === "pc" ? "Ubuntu 24.04" : "Windows 11 Pro",
          parts: [{ part: "host", version: "1.2.0+7", state: "running", pid: 1 }, ...(m === "pc" ? [{ part: "nvidia-exporter", version: "0.3.0", state: "failed", error: "exit 2: порт 9400 занят" }] : [])],
        },
      };
    };
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    relay.handlers["releases.set"] = () => ({ ok: true, result: { machine: "pc", rev: 10 } });
    return relay;
  }

  it("5401 · строки машин: система, host, keeper, сессии; поиск по имени и системе; «со сбоем» — машины с упавшей частью", async () => {
    const t = await pult({ relay: relayWith(), url: "/#machines" });
    await flush(10);
    expect(rows(t)).toEqual(["laptop", "pc"]);
    const pc = t.$('[data-row="pc"]')!;
    expect(pc.textContent).toContain("Ubuntu 24.04");
    expect(pc.textContent).toContain("host 1.2.0+7");
    expect(pc.textContent).toContain("keeper 1.0.5");
    expect(pc.textContent).toContain("3 сессии · сбой части");
    expect(t.$('[data-filter="fail"]')!.textContent).toBe("со сбоем 1");
    await t.click(t.$('[data-filter="fail"]'));
    expect(rows(t)).toEqual(["pc"]);
    await t.click(t.$('[data-filter="all"]'));
    await t.type(t.$('[data-f="q"]'), "windows");
    expect(rows(t)).toEqual(["laptop"]);
  });

  it("5402 · строка раскрывается в карточку: части с причиной сбоя; «Перезапустить» — releases.set on:false, затем on:true; повторное нажатие сворачивает", async () => {
    const relay = relayWith();
    const t = await pult({ relay, url: "/#machines" });
    await flush(10);
    expect(t.$('[data-machine="pc"]')).toBeNull();
    await t.click(t.$('[data-row="pc"] .mc-head'));
    const card = t.$('[data-machine="pc"]')!;
    expect(card.textContent).toContain("exit 2: порт 9400 занят");
    expect(t.btn(card, "Перезапустить")).not.toBeNull();
    const keeperAsked = relay.sent("keeper.state").filter((f) => f.to === ".keeper@pc").length;
    await t.click(t.btn(card, "Перезапустить"));
    await flush(5);
    expect(relay.sent("releases.set").map((f) => [f.machine, f.part, f.on])).toEqual([
      ["pc", "nvidia-exporter", false],
      ["pc", "nvidia-exporter", true],
    ]);
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("выключена и включена по плану");
    // 7252: перезапуск перечитывает keeper командой keeper.reload и не уводит с экрана
    expect(location.hash).toContain("machines");
    await flush(10);
    expect(relay.sent("keeper.state").filter((f) => f.to === ".keeper@pc").length).toBeGreaterThan(keeperAsked);
    // строка итога у строки машины: свёртка карточки её не теряет
    await t.click(t.$('[data-row="pc"] .mc-head'));
    await t.click(t.$('[data-row="pc"] .mc-head'));
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("выключена и включена по плану");
    await t.click(t.$('[data-row="pc"] .mc-head'));
    expect(t.$('[data-machine="pc"]')).toBeNull();
  });
});

describe("вход аккаунта", () => {
  it("5403 · «＋ войти на машине…» — машины на связи без этой почты; выбор — machine.login с тем же именем; ссылка входа — активная, «Копировать» кладёт её в буфер", async () => {
    const relay = fleetRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "poe", name: "poe", sessions: ["poe-bot@pc"] }] };
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "laptop" ? { night: { login: "ok", email: "night@x.io", plan: "max" } } : {} } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?code=true&x=1" } });
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } });
    const t = await pult({ relay, url: "/#accounts" });
    await flush(10);
    const card = t.$('[data-account="night@x.io"]')!;
    expect(card.querySelectorAll(".ac-m")).toHaveLength(1);
    await t.click(card.querySelector("[data-any]"));
    const pick = t.$('[data-any-pick="night@x.io"]')!;
    expect([...pick.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pc", "Отмена"]);
    await t.click(t.btn(pick, "pc"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ machine: "pc", account: "night" })]);
    const login = t.$('[data-login="pc:night"]')!;
    const a = login.querySelector<HTMLAnchorElement>("a")!;
    expect([a.getAttribute("href"), a.getAttribute("target"), a.textContent]).toEqual(["https://claude.ai/oauth/authorize?code=true&x=1", "_blank", "Открыть ссылку входа ↗"]);
    await t.click(t.btn(login, "Копировать"));
    expect(writes).toEqual(["https://claude.ai/oauth/authorize?code=true&x=1"]);
  });
});

describe("вход аккаунта · проект", () => {
  it("5404 · открыт проект: машины проекта в «＋ войти на машине…» — со ★", async () => {
    // источник: подпись экрана p17 прототипа «Пульт и телефон» (подписан 2 нояб.): ★ только с проектом
    const relay = fleetRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "poe", name: "poe", sessions: ["poe-bot@pc"] }] };
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "laptop" ? { night: { login: "ok", email: "night@x.io", plan: "max" } } : {} } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const t = await pult({ relay, url: "/#card?callsign=poe-bot%40pc" });
    await flush(10);
    location.hash = "#accounts";
    await flush(10);
    await t.click(t.$('[data-account="night@x.io"] [data-any]'));
    expect([...t.$('[data-any-pick="night@x.io"]')!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pc ★", "Отмена"]);
  });
});
