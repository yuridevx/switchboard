// Покрытие плана screen-machine-answers: ответы машин одним циклом, фильтры по вычислению, части и отказы. Настройки — в settings.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

type T = Awaited<ReturnType<typeof pult>>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const bumped = (m: string, r = fleetRoster()): Roster => ({ ...r, machines: r.machines.map((x) => (x.machine === m ? { ...x, since: x.since + 60_000 } : x)) });
const withoutPc = () => {
  const r = fleetRoster();
  r.machines = r.machines.filter((m) => m.machine !== "pc");
  return r;
};
/** Машина pc вошла гостем: клиент флота открыл соединение с её relay. */
const withPc = () => {
  const r = fleetRoster();
  r.clients = [...r.clients, "@pc"];
  return r;
};

function keeperRelay(r = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.0.5", rev: 9, os: "linux", parts: [{ part: "host", version: "1.2.0", state: "running", pid: 1 }] } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
  relay.handlers["releases.set"] = () => ({ ok: true, result: { rev: 10 } });
  return relay;
}
const screen = async (relay: ReturnType<typeof fleetRelay>, url: string) => {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
};

describe("связь вернулась", () => {
  /** Запрос ушёл, связь оборвалась: отказ disconnected на экране; снова hello — спрошено заново, слово снято. */
  async function scenario(url: string, name: string, word: string, ok: () => unknown, also: (relay: ReturnType<typeof fleetRelay>) => void = () => {}) {
    const relay = keeperRelay();
    also(relay);
    relay.handlers[name] = () => undefined;
    const t = await screen(relay, url);
    const before = relay.sent(name).length;
    relay.handlers[name] = () => ({ ok: true, result: ok() });
    relay.drop();
    await flush(1);
    expect(t.text()).toContain(word);
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent(name).length).toBeGreaterThan(before);
    expect(t.text()).not.toContain(word);
  }

  it("6956 · машины: keeper спрошен заново, слово снято", async () => {
    // источник: то же
    const relay = keeperRelay();
    const fine = relay.handlers["keeper.state"];
    relay.handlers["keeper.state"] = () => undefined;
    const t = await screen(relay, "/#machines");
    await t.click(t.$('[data-row="pc"] .mc-head'));
    relay.handlers["keeper.state"] = fine;
    relay.drop();
    await flush(1);
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("keeper.state: disconnected");
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(t.$('[data-machine="pc"]')!.textContent).not.toContain("keeper.state:");
    expect(t.$('[data-machine="pc"] [data-keeper]')).not.toBeNull();
  });

  it("6957 · экран закрыт: вернувшаяся связь запросов не шлёт", async () => {
    // источник: гейт архитектора — опрос без нужды
    const relay = keeperRelay();
    await pult({ relay, url: "/#sessions" });
    await flush(5);
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("keeper.state")).toHaveLength(0);
    expect(relay.sent("machine.profiles")).toHaveLength(0);
  });
});

describe("машины", () => {
  const rowOf = (t: T, m: string) => t.$(`[data-row="${m}"]`)!;

  it("6942 · фильтр «в проекте»: проекта нет — показаны все, фильтра нет; проект появился — фильтр вернулся", async () => {
    // источник: чьё: код
    const relay = keeperRelay();
    relay.scoped = { global: { "fleet.projects": [{ id: "p1", name: "site", sessions: ["site@laptop"] }] } };
    const t = await pult({ relay, url: "/#card?callsign=site%40laptop" });
    await flush(5);
    await t.go("#machines");
    await t.click(t.$('[data-filter="project"]'));
    expect(t.$('[data-filter="project"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$$("[data-row]").map((x) => x.getAttribute("data-row"))).toEqual(["laptop"]);
    await t.go("#card?callsign=wiki%40laptop");
    await t.go("#machines");
    expect(t.$('[data-filter="project"]')).toBeNull();
    expect(t.$('[data-filter="all"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$$("[data-row]")).toHaveLength(2);
    await t.go("#card?callsign=site%40laptop");
    await t.go("#machines");
    expect(t.$('[data-filter="project"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("6943 · машина ушла и вернулась: «на связи», её keeper спрошен заново", async () => {
    // источник: устав — соединение оборвалось, клиенты переподключаются
    const relay = keeperRelay();
    const t = await screen(relay, "/#machines");
    relay.setRoster(withoutPc());
    await flush(5);
    expect(rowOf(t, "pc").getAttribute("data-state")).toBe("gone");
    const n = relay.sent("keeper.state").length;
    relay.setRoster(bumped("pc", withPc()));
    await flush(10);
    expect(rowOf(t, "pc").getAttribute("data-state")).not.toBe("gone");
    expect(t.$('[data-filter="gone"]')!.textContent).toBe("ушли 0");
    expect(relay.sent("keeper.state").slice(n).map((f) => f.to)).toContain(".keeper@pc");
  });

  it("6944 · сбой части: у keeper кнопки нет; «Перезапустить» отказал — слово, включение не уходит", async () => {
    // источник: устав — второе падение failed, дальше решает агент; отказ словом
    const relay = keeperRelay();
    relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.0.5", rev: 9, os: "linux", parts: [{ part: "host", version: "1.2.0", state: "failed", error: "код 1" }, { part: "keeper", version: "1.0.5", state: "failed" }] } });
    relay.handlers["releases.set"] = () => ({ ok: false, error: "denied" });
    const t = await screen(relay, "/#machines");
    expect(t.$('[data-filter="fail"]')!.textContent).toBe("со сбоем 2");
    await t.click(t.$('[data-row="pc"] .mc-head'));
    const card = t.$('[data-machine="pc"]')!;
    expect(t.$$<HTMLElement>('[data-machine="pc"] .mc-part').filter((x) => x.textContent?.includes("Перезапустить")).map((x) => x.querySelector("b")!.textContent)).toEqual(["host"]);
    await t.click(t.btn(card, "Перезапустить"));
    await flush(5);
    expect(relay.sent("releases.set")).toEqual([expect.objectContaining({ machine: "pc", part: "host", on: false })]);
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("releases.set: denied");
  });

  it("6945 · keeper одной машины отказал: у второй части и версии на месте", async () => {
    // источник: устав — отказ словом
    const relay = keeperRelay();
    const fine = relay.handlers["keeper.state"];
    relay.handlers["keeper.state"] = (f) => (f.to === ".keeper@pc" ? { ok: false, error: "offline" } : fine(f));
    const t = await screen(relay, "/#machines");
    await t.click(t.$('[data-row="pc"] .mc-head'));
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("keeper.state: offline");
    await t.click(t.$('[data-row="laptop"] .mc-head'));
    expect(t.$('[data-machine="laptop"] [data-part="host"]')!.textContent).toContain("1.2.0");
  });
});
