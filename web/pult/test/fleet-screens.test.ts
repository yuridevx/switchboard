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
