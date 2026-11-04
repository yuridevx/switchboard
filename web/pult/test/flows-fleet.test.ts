// Флоу пульта по плану цикла тестов (web): аккаунты и вход, слоты, удаление аккаунта, машины, приложение GitHub, журнал флота.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { FakeRelay } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, joinedRoster, flush, HOST, pult, SLOTS } from "./stand.ts";

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

describe("журнал флота", () => {
  const day = 86_400_000;
  const evs = () => {
    const now = Date.now();
    return [
      { id: 3, t: now, ev: "session.opened", from: "laptop", by: "panel-desk", callsign: "a@laptop", text: "открыта a@laptop" },
      { id: 2, t: now - day, ev: "machine.left", from: ".relay", machine: "pc", text: "pc ушла" },
      { id: 1, t: now - 7 * day, ev: "points.deleted", from: ".points", text: "удалены точки old" },
    ];
  };

  async function journal(relay = fleetRelay()) {
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    return t;
  }

  it("4159 · записи новые сверху по дням — «Сегодня», «Вчера», дата; текст как прислал ledger, «by»", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs(), more: false } });
    const t = await journal(relay);
    expect(relay.sent("ledger.read")[0]).toMatchObject({ to: ".ledger", limit: 50 });
    const days = t.$$(".jr-day").map((x) => x.textContent);
    expect(days.slice(0, 2)).toEqual(["Сегодня", "Вчера"]);
    expect(days).toHaveLength(3);
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["3", "2", "1"]);
    expect(t.$('.jr-r[data-id="3"]')!.textContent).toContain("открыта a@laptop · by panel-desk");
    expect(t.$('.jr-r[data-id="3"] em')!.textContent).toBe("a@laptop");
  });

  it("6521 · быстрая смена машины: опоздавший ответ прежней не перекрывает выбранную", async () => {
    // источник: слепой архитектор 4 нояб.: чтение журнала шло без отмены устаревшего ответа
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs(), more: false } });
    const t = await journal(relay);
    relay.handlers["ledger.read"] = () => undefined;
    const pick = async (m: string) => {
      const s = t.$<HTMLSelectElement>('[data-f="machine"]')!;
      s.value = m;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    };
    await pick("pc");
    await pick("laptop");
    const [late, now] = relay.sent("ledger.read").slice(-2) as Array<{ id: string; machine: string }>;
    expect([late.machine, now.machine]).toEqual(["pc", "laptop"]);
    const ev = (id: number, machine: string) => ({ id, t: Date.now(), ev: "e", from: machine, machine, text: `запись ${machine}` });
    relay.reply(now.id, { ok: true, result: { events: [ev(20, "laptop")], more: false } });
    await flush();
    relay.reply(late.id, { ok: true, result: { events: [ev(10, "pc")], more: true } });
    await flush();
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["20"]);
    expect(t.button("Раньше")).toBeNull();
  });

  it("4160 · отказ ledger.read — «ledger.read: слово»", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "unknown_request" });
    const t = await journal(relay);
    expect(t.text()).toContain("ledger.read: unknown_request");
  });

  it("4161 · экран закрыт или чтение идёт — roster не шлёт ledger.read", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => undefined;
    const t = await journal(relay);
    relay.setRoster(fleetRoster());
    await flush();
    expect(relay.sent("ledger.read")).toHaveLength(1);
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    relay.reply(relay.sent("ledger.read")[0].id!, { ok: true, result: { events: [], more: false } });
    relay.setRoster(fleetRoster());
    await flush();
    expect(relay.sent("ledger.read")).toHaveLength(1);
  });

  it("4162 · первое чтение отказало — следующий roster читает всё заново, строка отказа снята", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "disconnected" });
    const t = await journal(relay);
    expect(t.text()).toContain("ledger.read: disconnected");
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs().slice(0, 2), more: false } });
    relay.setRoster(joinedRoster());
    await flush();
    expect(relay.sent("ledger.read").at(-1)).not.toHaveProperty("after");
    expect(t.text()).not.toContain("ledger.read: disconnected");
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["3", "2"]);
  });
});
