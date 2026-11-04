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

describe("аккаунты", () => {
  it("7291 · подмена аккаунта при открытом экране: окна свежие, max_age 0", async () => {
    // источник: факт — host/modules/accounts: без max_age чтение кэша без опроса; комментарий стора обещает свежие окна
    const r = fleetRoster();
    const relay = fleetRelay(r);
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    await screen(relay, "/#accounts");
    relay.setRoster({ ...r, sessions: r.sessions.map((s) => (s.callsign === "site@laptop" ? { ...s, account: "work3" } : s)) });
    await flush(10);
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "laptop", max_age: 0 });
  });

  it("6940 · машина пришла при открытом экране: ей machine.accounts max_age 120, в нём и слоты", async () => {
    // источник: чьё: код
    const relay = fleetRelay(withoutPc());
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    await screen(relay, "/#accounts");
    expect(relay.sent("machine.accounts").map((f) => f.machine)).toEqual(["laptop"]);
    relay.setRoster(withPc());
    await flush(10);
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "pc", max_age: 120 });
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "pc" });
  });

  it("6950 · машина без запроса: ей запросов нет и слов отказа о ней нет; другой — есть", async () => {
    // источник: чьё: код
    const r = fleetRoster();
    for (const n of ["machine.accounts", "machine.profiles"]) delete r.machines[1].contract![n];
    const relay = fleetRelay(r);
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const t = await screen(relay, "/#accounts");
    await t.go("#profiles");
    for (const n of ["machine.accounts", "machine.profiles"]) {
      expect(relay.sent(n).map((f) => f.machine)).toEqual(["laptop"]);
    }
    expect(t.text()).not.toContain("pc:");
    expect(t.text()).not.toContain("pc ·");
  });

  it("6951 · отказ снят ответом: связь с машиной вернулась с новым since — слова нет, её аккаунты на экране", async () => {
    // источник: факт — ответ снимает его; устав — клиенты переподключаются
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : { ok: true, result: { accounts: {} } });
    const t = await screen(relay, "/#accounts");
    expect(t.text()).toContain("pc · machine.accounts: offline");
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "pc" ? { work: { login: "ok", email: "a@x.io" } } : {} } });
    relay.setRoster(bumped("pc"));
    await flush(10);
    expect(t.text()).not.toContain("machine.accounts: offline");
    expect(t.$('[data-account="a@x.io"] [data-machine="pc"]')).not.toBeNull();
  });
});

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

  it("6954 · аккаунты: «disconnected» снимается вопросом заново", () =>
    // источник: устав — соединение оборвалось, клиенты переподключаются; факт — machines.ts: машина вернулась — доспросить
    scenario("/#accounts", "machine.accounts", "machine.accounts: disconnected", () => ({ accounts: {} }), (x) => (x.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } }))));

  it("6955 · профили: «disconnected» снимается вопросом заново", () =>
    // источник: то же
    scenario("/#profiles", "machine.profiles", "machine.profiles: disconnected", () => ({ profiles: {}, repos: {} })));

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

describe("профили", () => {
  const answer = (conflict: string[] | null) => ({ ok: true as const, result: { profiles: { "team/profiles/ops": { model: "opus" }, "team/profiles/writer": { model: "haiku" } }, repos: { "team/profiles": conflict ? { state: "conflict", files: conflict } : { state: "ok" } } } });
  const shown = (t: T) => t.$$("[data-profile]").map((x) => x.dataset.profile);

  it("6941 · фильтр «конфликты» вычисляется: конфликты ушли — снят; появились — вернулся", async () => {
    // источник: чьё: код
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    const t = await screen(relay, "/#profiles");
    await t.click(t.$('[data-act="conflicts"]'));
    expect(shown(t)).toEqual(["team/profiles/ops"]);
    relay.handlers["machine.profiles"] = () => answer(null);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$('[data-act="conflicts"]')).toBeNull();
    expect(shown(t)).toHaveLength(2);
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$('[data-act="conflicts"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(shown(t)).toEqual(["team/profiles/ops"]);
  });

  it("6952 · одна машина отказала: строка со словом; профили второй на месте", async () => {
    // источник: устав — отказ словом
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = (f) => (f.machine === "pc" ? { ok: false, error: "no_app" } : answer(null));
    const t = await screen(relay, "/#profiles");
    expect(t.$(".pf-e")!.textContent).toBe("@pc: machine.profiles: no_app");
    expect(shown(t)).toHaveLength(2);
  });

  it("6953 · чей конфликт: файлы под папкой профиля — только у него; ни под чьей — у всех профилей репозитория", async () => {
    // источник: факт — правило в profiles/store.ts
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    const t = await screen(relay, "/#profiles");
    expect(t.$('[data-act="conflicts"]')!.textContent).toBe("конфликты 1");
    relay.handlers["machine.profiles"] = () => answer(["README.md"]);
    const t2 = await screen(relay, "/#profiles");
    expect(t2.$('[data-act="conflicts"]')!.textContent).toBe("конфликты 2");
  });

  it("6958 · синхронизация: на время «Свожу…»; без конфликта — «Сведено»", async () => {
    // источник: чьё: код
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(null);
    const t = await screen(relay, "/#profiles");
    relay.handlers["machine.profiles"] = () => undefined;
    await t.click(t.$('[data-act="sync"]'));
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Свожу…");
    for (const f of relay.sent("machine.profiles").filter((x) => x.sync === true)) relay.reply(f.id!, answer(null));
    await flush(5);
    expect(t.$(".sb-toast")!.textContent).toBe("Сведено");
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Синхронизировать");
  });
});
