// Флоу пульта по плану цикла тестов (web): аккаунты и вход, слоты, удаление аккаунта, машины, приложение GitHub.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { FakeRelay } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, flush, HOST, pult, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
type Ans = { ok: true; result?: unknown } | { ok: false; error: string };

/** Аккаунты и слоты машин: accounts[m], slots[m] — ответы владельцев. */
function fleetAccounts(accounts: Record<string, unknown>, slots: Record<string, unknown> = {}, r = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers["machine.accounts"] = (f) => (accounts[String(f.machine)] as Ans | undefined) ?? { ok: true, result: { accounts: {} } };
  relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: slots[String(f.machine)] ?? {} } });
  return relay;
}

async function accountsScreen(relay = fleetAccounts({}), url?: string) {
  const t = await pult({ relay, url });
  if (!url) await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
  await flush(10);
  return t;
}

const ok = (accounts: Record<string, unknown>) => ({ ok: true as const, result: { accounts } });

/** Ответы keeper и профилей для экрана «Машины». */
function machinesRelay(r: Roster = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.0.1", rev: 7, os: "linux", parts: [{ part: "host", version: "1.1.58", state: "running", pid: 1 }] } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "org/p": { state: "ok" } } } });
  return relay;
}

async function machines(relay = machinesRelay(), url?: string) {
  const t = await pult({ relay, url });
  if (!url) await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
  await flush(10);
  return t;
}

/** Раскрыть строку машины в карточку. */
async function expand(t: Awaited<ReturnType<typeof pult>>, m: string) {
  await t.click(t.$(`[data-row="${m}"] .mc-head`));
  await flush(5);
}

describe("машины", () => {
  it("4150 · keeper не ответил — «keeper.state: слово» в карточке машины", async () => {
    const relay = machinesRelay();
    relay.handlers["keeper.state"] = (f) => (f.to === ".keeper@pc" ? { ok: false, error: "offline" } : { ok: true, result: { keeper: "1.0.1", parts: [] } });
    const t = await machines(relay);
    await expand(t, "pc");
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("keeper.state: offline");
    await expand(t, "laptop");
    expect(t.$('[data-machine="laptop"]')!.textContent).not.toContain("keeper.state:");
  });

  it("4152 · машина ушла из roster — строка «ушла ЧЧ:ММ», в фильтре «ушли 1»; кадров к ней нет", async () => {
    // источник: прототип «Пульт и телефон» (подписан пользователем 2 нояб.): ушедшая машина остаётся строкой «ушла»
    const relay = machinesRelay();
    const t = await machines(relay);
    const n = relay.got.length;
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    relay.setRoster(r);
    await flush(10);
    expect(t.$('[data-row="pc"]')!.getAttribute("data-state")).toBe("gone");
    expect(t.$('[data-row="pc"]')!.textContent).toMatch(/ушла \d\d:\d\d/);
    expect(t.$('[data-filter="gone"]')!.textContent).toBe("ушли 1");
    expect(relay.got.slice(n).filter((f) => f.to === ".keeper@pc" || f.machine === "pc")).toEqual([]);
  });

  it("4192 · машина вернулась при закрытом экране «Машины» — keeper.state не шлётся", async () => {
    // источник: факт цикла тестов 2 нояб. — пульт опрашивал вернувшуюся машину и при закрытом экране; при открытии экран спрашивает все машины сам
    const relay = machinesRelay();
    await pult({ relay });
    await flush(10);
    const r = fleetRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
    await flush(10);
    expect(relay.sent("keeper.state")).toHaveLength(0);
  });

  it("4193 · экран «Машины» закрыли, машина вернулась, экран открыли снова — keeper.state на открытии, а не при закрытом", async () => {
    // источник: чьё: код (экран при открытии спрашивает все машины; закрытый — не спрашивает)
    const relay = machinesRelay();
    const t = await machines(relay);
    const before = relay.sent("keeper.state").length;
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    const r = fleetRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
    await flush(10);
    expect(relay.sent("keeper.state")).toHaveLength(before);
    await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
    await flush(10);
    expect(relay.sent("keeper.state").slice(before).map((f) => f.to)).toContain(".keeper@pc");
  });

  it("4153 · машина впервые в roster при открытом экране — keeper.state, а не «…»", async () => {
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    const relay = machinesRelay(r);
    const t = await machines(relay);
    // машина pc вошла гостем на laptop — клиент флота открыл соединение с её relay
    const full = fleetRoster();
    full.clients = [...full.clients, "@pc"];
    relay.setRoster(full);
    await flush(10);
    expect(relay.sent("keeper.state").map((f) => f.to)).toContain(".keeper@pc");
    await expand(t, "pc");
    expect(t.$('[data-machine="pc"] [data-keeper]')!.textContent).toBe("1.0.1 · план rev 7");
  });
});
