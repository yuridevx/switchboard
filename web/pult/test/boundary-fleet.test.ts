// Леса границы «обзор флота на странице»: машины и настройки флота — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModule, AppPart, Frame, Roster } from "@switchboard/web-core";
import { memoryStore } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM, type BrowserPush } from "@switchboard/web-alerts";
import { FakeRelay, flush, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";
import { createMachines, manifest as machinesM } from "../modules/machines/contract.ts";
import { createSettings, manifest as settingsM } from "../modules/settings/contract.ts";
import { fleetRelay, fleetRoster, pult, SLOTS } from "./stand.ts";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Машины: связь и отказы", () => {
  type T = Awaited<ReturnType<typeof pult>>;

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

    it("6956 · машины: keeper спрошен заново, слово снято", async () => {
      // источник: то же
      const relay = keeperRelay();
      const fine = relay.handlers["keeper.state"];
      relay.handlers["keeper.state"] = () => undefined;
      const t = await screen(relay, "/#accounts");
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
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
      const t = await pult({ relay, url: "/#sessions" });
      await flush(5);
      relay.drop();
      await new Promise((r) => setTimeout(r, 30));
      await flush(10);
      expect(relay.sent("keeper.state")).toHaveLength(0);
      expect(relay.sent("machine.profiles")).toHaveLength(0);
      await t.go("#accounts");
      expect(relay.sent("keeper.state").length).toBeGreaterThan(0);
    });
  });

  describe("машины", () => {
    const rowOf = (t: T, m: string) => t.$(`[data-machine="${m}"]`)!;

    it("6943 · машина ушла и вернулась: «на связи», её keeper спрошен заново", async () => {
      // источник: устав — соединение оборвалось, клиенты переподключаются
      const relay = keeperRelay();
      const t = await screen(relay, "/#accounts");
      relay.setRoster(withoutPc());
      await flush(5);
      expect(rowOf(t, "pc").getAttribute("data-state")).toBe("gone");
      const n = relay.sent("keeper.state").length;
      relay.setRoster(bumped("pc", withPc()));
      await flush(10);
      expect(rowOf(t, "pc").getAttribute("data-state")).not.toBe("gone");
      expect(relay.sent("keeper.state").slice(n).map((f) => f.to)).toContain(".keeper@pc");
    });

    it("6944 · сбой части: у keeper кнопки нет; «Перезапустить» отказал — слово, включение не уходит", async () => {
      // источник: устав — второе падение failed, дальше решает агент; отказ словом
      const relay = keeperRelay();
      relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.0.5", rev: 9, os: "linux", parts: [{ part: "host", version: "1.2.0", state: "failed", error: "код 1" }, { part: "keeper", version: "1.0.5", state: "failed" }] } });
      relay.handlers["releases.set"] = () => ({ ok: false, error: "denied" });
      const t = await screen(relay, "/#accounts");
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      const card = t.$('[data-machine="pc"]')!;
      expect(t.$$<HTMLElement>('[data-machine="pc"] .mc-part').filter((x) => x.textContent?.includes("Перезапустить")).map((x) => x.querySelector("b")!.textContent)).toEqual(["host"]);
      await t.click(t.btn(card, "Перезапустить"));
      await flush(5);
      expect(relay.sent("releases.set")).toEqual([expect.objectContaining({ machine: "pc", part: "host", on: false })]);
      expect(t.$('[data-machine="pc"]')!.textContent).toContain("releases.set: denied");
    });

  });
});

describe("Машины: строки", () => {
  type P = Awaited<ReturnType<typeof pult>>;
  const rows = (t: P) => t.$$("[data-machine]").map((r) => r.getAttribute("data-machine"));

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

    it("5401 · строки машин: со сбоем первая; версии и система — в карточке, числа сессий нет", async () => {
      const t = await pult({ relay: relayWith(), url: "/#accounts" });
      await flush(10);
      expect(rows(t)).toEqual(["pc", "laptop"]);
      const pc = t.$('[data-machine="pc"]')!;
      expect(pc.getAttribute("data-state")).toBe("fail");
      expect(pc.textContent).not.toContain("сесси");
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      const parts = t.$('[data-machine-parts="pc"]')!;
      expect(parts.textContent).toContain("Ubuntu 24.04");
      expect(parts.textContent).toContain("1.2.0+7");
      expect(parts.textContent).toContain("1.0.5");
    });

    it("5402 · строка раскрывается в карточку: части с причиной сбоя; «Перезапустить» — releases.set on:false, затем on:true; повторное нажатие сворачивает", async () => {
      const relay = relayWith();
      const t = await pult({ relay, url: "/#accounts" });
      await flush(10);
      expect(t.$('[data-machine-parts="pc"]')).toBeNull();
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      const card = t.$('[data-machine-parts="pc"]')!;
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
      expect(location.hash).toContain("accounts");
      await flush(10);
      expect(relay.sent("keeper.state").filter((f) => f.to === ".keeper@pc").length).toBeGreaterThan(keeperAsked);
      // строка итога у строки машины: свёртка карточки её не теряет
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      expect(t.$('[data-machine="pc"]')!.textContent).toContain("выключена и включена по плану");
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      expect(t.$('[data-machine-parts="pc"]')).toBeNull();
    });

    it("V-M1 · «Перезапускаю…» до ответа; «План в «Выпусках»» — настройки с машиной", async () => {
      const relay = relayWith();
      relay.handlers["releases.list"] = () => ({ ok: true, result: { parts: {}, machines: [], rev: 1, modules: {} } });
      const t = await pult({ relay, url: "/#accounts" });
      await flush(10);
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      relay.handlers["releases.set"] = () => undefined;
      await t.click(t.btn(t.$('[data-machine="pc"]'), "Перезапустить"));
      expect(t.$('[data-machine="pc"]')!.textContent).toContain("Перезапускаю…");
      await t.click(t.btn(t.$('[data-machine="pc"]'), "План в «Выпусках»"));
      expect(location.hash).toBe("#settings?tab=releases&machine=pc");
      expect(t.$('[data-plan="pc"]')).not.toBeNull();
    });
  });
});

describe("Машины и настройки: ответы keeper", () => {

  describe("эталоны пульта: аккаунты и слоты", () => {
    it("7354 · имя машины вместо адреса: аккаунты и выпуски", async () => {
      // источник: дизайн «Сессии, проекты и профили» — имя заменяет адрес в интерфейсе; бэклог: сырые win, wsl на этих экранах
      const relay = Object.assign(fleetRelay(), { scoped: { global: { "fleet.labels": { sessions: {}, machines: { laptop: "Домашний ПК" } } } } });
      relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { slots: {}, accounts: f.machine === "laptop" ? { infirex: { login: "ok", limits: {} } } : {} } });
      relay.handlers["releases.list"] = () => ({ ok: true, result: { parts: {}, machines: [], rev: 1, modules: {} } });
      const t = await pult({ relay });
      await t.go("#accounts?view=accounts");
      await flush(10);
      expect(t.$$('[data-machine="laptop"]').some((x) => x.textContent!.startsWith("Домашний ПК"))).toBe(true);
      await t.go("#settings");
      await flush(10);
      expect(t.$('tr[data-machine="laptop"]')!.textContent).toContain("Домашний ПК");
    });

  });

  describe("эталоны пульта: машины", () => {
    async function machines() {
      const relay = fleetRelay();
      let host: Record<string, { version: string; state: string; error?: string }> = { laptop: { version: "1.1.58", state: "running" }, pc: { version: "1.1.58", state: "running" } };
      relay.handlers["keeper.state"] = (f) => {
        const m = String(f.to).split("@")[1];
        return {
          ok: true,
          result: { keeper: "0.5.0", rev: 44, os: m === "pc" ? "linux 6.8.0 amd64" : "windows 10.0.26300 amd64", parts: [{ part: "host", ...host[m], pid: 7731, restarts: 0 }, { part: "capture", version: "1.3.2", state: "running", pid: 9120, restarts: 0 }] },
        };
      };
      relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "team/profiles": { state: "ok" } } } });
      const t = await pult({ relay });
      await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
      await flush(10);
      return { t, relay, setHost: (m: string, v: { version: string; state: string; error?: string }) => (host = { ...host, [m]: v }) };
    }

    it("6902 · ответы keeper одни на «Машины» и «Настройки»: новые «Настройки» сразу видят полученное «Машинами», пока их запрос идёт", async () => {
      // источник: гейт архитектора «дубликат состояния не пропускается»; ответы — метка keeper.answers модуля настроек
      const { t, relay } = await machines();
      relay.handlers["releases.list"] = () => ({ ok: true, result: { parts: {}, machines: [], rev: 1, modules: {} } });
      expect(relay.sent("keeper.state")).toHaveLength(2);
      relay.handlers["keeper.state"] = () => undefined; // второй раз keeper не отвечает
      await t.go("#settings?tab=releases");
      await flush(10);
      expect(relay.sent("keeper.state")).toHaveLength(4);
      expect(t.root.textContent).toContain("rev 44");
    });

    it("195 · машины: keeper.state от .keeper@машина — части с версиями и состоянием; failed — причиной; кнопки обновления нет; машина вернулась — keeper.state заново", async () => {
      const { t, relay, setHost } = await machines();
      expect(relay.sent("keeper.state").map((f) => f.to)).toEqual([".keeper@laptop", ".keeper@pc"]);
      await t.click(t.$('[data-machine="pc"] .ac-mname'));
      expect(t.$('[data-machine="pc"] [data-keeper]')!.textContent).toBe("0.5.0 · план rev 44");
      expect(t.$('[data-machine="pc"] [data-part="host"]')!.textContent).toBe("1.1.58 · running · pid 7731");
      expect(t.$('[data-machine="pc"] [data-part="capture"]')!.textContent).toBe("1.3.2 · running · pid 9120");
      expect(t.$('[data-machine="pc"]')!.textContent).not.toContain("Обновить");
      setHost("pc", { version: "1.1.59", state: "failed", error: "второе падение: код 1" });
      const r = fleetRoster();
      relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
      await flush(10);
      expect(relay.sent("keeper.state").map((f) => f.to)).toEqual([".keeper@laptop", ".keeper@pc", ".keeper@pc"]);
      const host = t.$('[data-machine="pc"] [data-part="host"]')!;
      expect([host.textContent, host.getAttribute("data-state"), host.className]).toEqual(["1.1.59 · failed · pid 7731", "failed", "v bad"]);
      expect(t.$('[data-machine="pc"]')!.textContent).toContain("второе падение: код 1");
      expect(t.$('[data-machine="pc"]')!.getAttribute("data-state")).toBe("fail");
    });
  });
});

describe("Машины: уход и возврат", () => {
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
    if (!url) await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await flush(10);
    return t;
  }

  /** Раскрыть строку машины в карточку. */
  async function expand(t: Awaited<ReturnType<typeof pult>>, m: string) {
    await t.click(t.$(`[data-machine="${m}"] .ac-mname`));
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
      expect(t.$('[data-machine="pc"]')!.getAttribute("data-state")).toBe("gone");
      expect(t.$('[data-machine="pc"]')!.textContent).toMatch(/ушла \d\d:\d\d/);
      expect(relay.got.slice(n).filter((f) => f.to === ".keeper@pc" || f.machine === "pc")).toEqual([]);
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
      await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
      await flush(10);
      expect(relay.sent("keeper.state").slice(before).map((f) => f.to)).toContain(".keeper@pc");
    });

  });

  it("V-M2 · когда ушла машина: журнал спрошен один раз и только о машине, что ушла раньше; вернулась — забыто; ушла на странице — своё время", async () => {
    let m!: AppModule;
    const parts: AppPart[] = [{ manifest: settingsM, module: createSettings }, { manifest: machinesM, module: (app) => (m = createMachines(app)) }];
    const relay = machinesRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ t: 1234, ev: "machine.left" }] } });
    const run = (machine: string) => m.commands!["machines.left.read"].run!({ machine });
    await stand(parts, { relay, url: "/#accounts", wide: true });
    await flush(5);
    expect(m.marks!["machines.left"]("old")).toBeUndefined();
    run("old");
    run("old");
    await flush(5);
    expect(relay.sent("ledger.read")).toEqual([expect.objectContaining({ machine: "old", limit: 1 })]);
    expect(m.marks!["machines.left"]("old")).toBe(1234);
    run("");
    expect(relay.sent("ledger.read")).toHaveLength(1);
    // журнал без записи об уходе — времени нет
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ t: 9, ev: "machine.back" }] } });
    run("other");
    await flush(5);
    expect(m.marks!["machines.left"]("other")).toBeUndefined();
    // ушла при открытой странице: своё время, журнал не нужен
    const r = fleetRoster();
    r.machines = r.machines.filter((x) => x.machine !== "pc");
    relay.setRoster(r);
    await flush(5);
    expect(m.marks!["machines.left"]("pc")).toEqual(expect.any(Number));
    const asked = relay.sent("ledger.read").length;
    run("pc");
    await flush(5);
    expect(relay.sent("ledger.read")).toHaveLength(asked);
    // вернулась — забыто
    relay.setRoster(fleetRoster());
    await flush(5);
    expect(m.marks!["machines.left"]("pc")).toBeUndefined();
  });
});

describe("Настройки", () => {
  const contract = { "machine.profiles": 1 };
  const roster = (): Roster => ({
    type: "roster",
    machines: [
      { machine: "laptop", since: 1, proto: 1, contract },
      { machine: "pc", since: 1, proto: 1, contract },
    ],
    sessions: [],
    clients: ["pult"],
  });

  type Plan = Record<string, { pin?: string; on?: boolean }>;
  /** Флот «Выпусков»: stable host +7, keeper 1.0.5; laptop держит keeper 1.0.4 закреплённым, pc отстал по host и уронил hello-daemon; old ушла. */
  function fleet(offline: string[] = [], hostsRefused = "") {
    const plans: Record<string, Plan> = { laptop: { keeper: { pin: "1.0.4" } }, pc: {}, old: {} };
    const passes = [
      { id: "kh1", role: "host", name: "laptop", person: null, addr: "@laptop", state: "ok", by: "агент", at: Date.UTC(2026, 10, 1) },
      { id: "kc1", role: "client", name: "pult", person: "you@mail", addr: "pult~you@mail", state: "ok", by: "@laptop", at: Date.UTC(2026, 10, 2) },
      { id: "kc2", role: "client", name: "phone", person: "you@mail", addr: "phone~you@mail", state: "ok", by: "pult~you@mail", at: Date.UTC(2026, 10, 2) },
    ];
    const relay = new FakeRelay(roster());
    relay.you = "pult~you@mail";
    relay.handlers["releases.list"] = () => ({
      ok: true,
      result: {
        parts: {
          host: { where: "machine", edge: "1.2.0+8", stable: "1.2.0+7", versions: ["1.2.0+5", "1.2.0+6", "1.2.0+7", "1.2.0+8"] },
          keeper: { where: "machine", edge: "1.0.5", stable: "1.0.5", versions: ["1.0.3", "1.0.4", "1.0.5"] },
          pult: { where: "cloud", edge: "1.2.0+13", stable: "1.2.0+12", versions: ["1.2.0+10", "1.2.0+11", "1.2.0+12", "1.2.0+13"] },
          relay: { where: "cloud", edge: "1.1.0", stable: "1.1.0", versions: ["1.1.0"] },
        },
        machines: Object.entries(plans).map(([machine, plan]) => ({ machine, plan })),
        rev: 9,
        modules: {
          "web-inbox": { into: ["pult", "phone"], built: { pult: "0.1.0", phone: "0.1.0" }, edge: "0.2.0" },
          "web-core": { into: ["pult", "phone"], built: { pult: "1.3.2", phone: "1.3.2" }, edge: "1.3.2" },
        },
      },
    });
    relay.handlers["keeper.state"] = (f: Frame) => {
      const m = String(f.to).split("@")[1];
      if (m === "laptop") return { ok: true, result: { keeper: "1.0.4", rev: 9, os: "windows", parts: [{ part: "host", version: "1.2.0+7", state: "running" }, { part: "keeper", version: "1.0.4", state: "running" }] } };
      return { ok: true, result: { keeper: "1.0.5", rev: 9, os: "linux", parts: [{ part: "host", version: "1.2.0+6", state: "running" }, { part: "keeper", version: "1.0.5", state: "running" }, { part: "hello-daemon", version: "0.1.0", state: "failed", error: "exit 1: нет файла конфигурации" }] } };
    };
    relay.handlers["releases.set"] = (f: Frame) => {
      const p = (plans[String(f.machine)] ??= {});
      const e = (p[String(f.part)] ??= {});
      if (f.pin === null) delete e.pin;
      else if (typeof f.pin === "string") e.pin = f.pin;
      if (typeof f.on === "boolean") e.on = f.on;
      return { ok: true, result: { machine: f.machine, rev: 10 } };
    };
    relay.handlers["releases.deploy"] = (f: Frame) =>
      f.part === "web-inbox" ? { ok: false, error: "check_failed" } : { ok: true, result: { parts: { [String(f.part)]: { from: "1.2.0+12", to: String(f.version) } } } };
    relay.handlers["keys.invite"] = (f: Frame) => ({ ok: true, result: { kid: "k9ab", invite: "k9ab.SECRETsecretSECRETsecretSECRETsecret1234567", addr: `${f.name}~${f.person}` } });
    relay.handlers["keys.revoke"] = (f: Frame) => ({ ok: true, result: { addr: passes.find((p) => p.id === f.kid)!.addr } });
    relay.handlers["github.app"] = () => ({ ok: true, result: { app: { slug: "switchboard-fleet" }, repos: ["you/switchboard", "you/profiles", "you/site"], install: "https://github.com/apps/switchboard-fleet/installations/new" } });
    relay.handlers["github.setup"] = (f: Frame) => ({ ok: true, result: { app: { slug: "switchboard-fleet" }, install: `https://github.com/apps/x?code=${f.code}` } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "you/profiles": { state: "ok" } } } });
    // пропуска клиентов: стенд сам отвечает на keys.list машинами — здесь весь список gate
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const f = JSON.parse(String(init?.body)) as Frame;
      if (String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === undefined) {
        relay.got.push(f);
        return Response.json({ type: "reply", id: f.id, ...(relay.handlers["keys.list"]?.(f) ?? { ok: true, result: { passes } }) });
      }
      // экран спрашивает машины сам; у клиента флота id со словом list
      if (hostsRefused && String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === "host" && !String(f.id).endsWith("-list")) return Response.json({ type: "reply", id: f.id, ok: false, error: hostsRefused });
      const r = await relay.fetch(url, init);
      // машина с пропуском, которой нет на связи: её знает только gate
      if (offline.length && String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === "host") {
        const b = await r.json();
        return Response.json({ ...b, result: { ...b.result, passes: [...b.result.passes, ...offline.map((name) => ({ name, role: "host", state: "ok" }))] } });
      }
      return r;
    }) as typeof globalThis.fetch;
    return { relay, plans, fetch };
  }

  async function settings(o: { wide?: boolean; url?: string; workers?: Record<string, string>; browser?: BrowserPush; hooks?(relay: FakeRelay): void; offline?: string[]; hostsRefused?: string } = {}) {
    const fl = fleet(o.offline, o.hostsRefused);
    o.hooks?.(fl.relay);
    const parts: AppPart[] = [
      { manifest: settingsM, module: createSettings },
      { manifest: alertsM, module: createAlerts(o.browser ?? fakeBrowser("granted")) },
    ];
    const t = await stand(parts, { relay: fl.relay, store: memoryStore({ key: "client.pult.k3f1.Qa7sig" }), wide: o.wide ?? true, url: o.url ?? "/#settings", options: { fetch: fl.fetch, ...(o.workers ? { workers: o.workers } : {}) } });
    await flush(10);
    const btn = (text: string | RegExp, scope: Element = t.root) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) ?? null;
    const go = async (hash: string) => {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await flush(10);
    };
    const sent = (type: string) => fl.relay.got.filter((f) => f.type === type);
    const cell = (m: string, p: string) => t.$(`tr[data-machine="${m}"] td[data-part="${p}"]`)?.textContent ?? "";
    return { ...t, ...fl, btn, go, sent, cell };
  }

  describe("pult-settings", () => {
    it("5501 · выпуски по машинам: stable и сколько машин его держат; матрица машина × часть — stable, отстаёт, 📌, сбой, ушла; план машины сбоку — закрепить версию", async () => {
      const t = await settings({ offline: ["old"] });
      expect(t.$('[data-tab="releases"]')!.getAttribute("aria-selected")).toBe("true");
      expect(t.$('[data-roll="host"]')!.textContent).toContain("1.2.0+7");
      expect(t.$('[data-roll="host"]')!.textContent).toContain("1 из 2");
      expect(t.cell("laptop", "host")).toBe("1.2.0+7");
      expect(t.cell("laptop", "keeper")).toBe("📌 1.0.4");
      expect(t.cell("pc", "host")).toBe("1.2.0+6 → 1.2.0+7");
      expect(t.$('tr[data-machine="pc"] td[data-part="hello-daemon"] .st-cell')!.className).toContain("fail");
      expect(t.$('tr[data-machine="old"]')!.textContent).toContain("не на связи");
      await t.click(t.btn("@laptop"));
      const side = t.$('[data-plan="laptop"]')!;
      expect(side.querySelector('[data-part="keeper"]')!.textContent).toContain("1.0.4");
      await t.click(t.btn("📌 +6", side.querySelector('[data-part="host"]')!));
      expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "laptop", part: "host", pin: "1.2.0+6", to: ".releases" });
      expect(t.plans.laptop.host.pin).toBe("1.2.0+6");
      // stable снимает закрепление
      await t.click(t.btn("stable 1.0.5", t.$('[data-plan="laptop"] [data-part="keeper"]')!));
      expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "laptop", part: "keeper", pin: null });
    });

    it("5502 · несколько машин: отметить laptop и pc — закрепить host разом и вернуть к stable; часть машины выключается планом", async () => {
      const t = await settings();
      await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
      await t.click(t.$('tr[data-machine="pc"] .st-ck'));
      expect(t.$("[data-bulk]")!.textContent).toContain("Выбрано 2");
      await t.click(t.btn("host: закрепить +6"));
      expect(t.sent("releases.set").map((f) => [f.machine, f.part, f.pin])).toEqual([
        ["laptop", "host", "1.2.0+6"],
        ["pc", "host", "1.2.0+6"],
      ]);
      expect(t.$("[data-bulk]")).toBeNull();
      await t.click(t.$('tr[data-machine="pc"] .st-ck'));
      await t.click(t.btn("host: к stable"));
      expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "pc", part: "host", pin: null });
      await t.click(t.btn("@pc"));
      await t.click(t.btn("включена", t.$('[data-plan="pc"] [data-part="hello-daemon"]')!));
      expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "pc", part: "hello-daemon", on: false });
      expect(t.cell("pc", "hello-daemon")).toBe("выключена");
    });

    it("5503 · каталог и сборки: «Выложить» edge — releases.deploy, итог словами; модуль сборки с отказом проверки — причина словами; «Вернуть» прежнюю сборку", async () => {
      const t = await settings();
      await t.click(t.btn("Каталог и сборки"));
      expect(t.$('tr[data-part="relay"]')!.textContent).not.toContain("Выложить");
      await t.click(t.btn("Выложить +13"));
      expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "pult", version: "1.2.0+13", to: ".releases" });
      expect(t.text()).toContain("Выложено: pult 1.2.0+12 → 1.2.0+13");
      // модули сборок: в сборке 0.1.0, в каталоге 0.2.0 — «Выложить 0.2.0»; у web-core новее нет
      expect(t.$('tr[data-module="web-core"]')!.textContent).not.toContain("Выложить");
      await t.click(t.btn("Выложить 0.2.0", t.$('tr[data-module="web-inbox"]')!));
      expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "web-inbox" });
      expect(t.text()).toContain("Не выложен web-inbox 0.2.0: проверка флота не прошла");
      await t.click(t.btn("Вернуть +11", t.$('tr[data-part="pult"]')!));
      expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "pult", version: "1.2.0+11" });
      // история: вернуть можно и более раннюю сборку
      expect(t.btn("Вернуть +10", t.$('tr[data-part="pult"]')!)).not.toBeNull();
    });

    it("5504 · пропуска: пригласить устройство — keys.invite и ссылки #invite= на пульт и телефон, каждая копируется; отозвать с подтверждением — keys.revoke у relay; это устройство не отзывается", async () => {
      // источник: слово пользователя 3 нояб. — «отдавала инвайт сразу и линком на пульт и на телефон, копия по выбору»
      const writes: string[] = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } });
      const t = await settings({ url: "/#settings?tab=passes", workers: { ...FakeRelay.WORKERS, phone: "https://phone.test/" } });
      expect(t.$('[data-passes="Машины"]')!.textContent).toContain("@laptop");
      const me = t.$('tr[data-pass="kc1"]')!;
      expect(me.textContent).toContain("это устройство");
      expect(t.btn("Отозвать…", me)).toBeNull();
      // колонки таблиц одинаковые
      expect(t.$$(".st-tbl colgroup").length).toBe(2);
      await t.click(t.btn("Пригласить"));
      const nameIn = t.$<HTMLInputElement>('[aria-label="Имя"]')!;
      nameIn.value = "laptop2";
      nameIn.dispatchEvent(new Event("input", { bubbles: true }));
      const who = t.$<HTMLInputElement>('[aria-label="Почта"]')!;
      who.value = "you@mail";
      who.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
      expect(t.sent("keys.invite").at(-1)).toMatchObject({ role: "client", name: "laptop2", person: "you@mail", to: ".gate" });
      const inv = "k9ab.SECRETsecretSECRETsecretSECRETsecret1234567";
      expect(t.$("[data-link=\"Пульт\"] code")!.textContent).toBe(`${location.origin}/#invite=${inv}`);
      expect(t.$("[data-link=\"Телефон\"] code")!.textContent).toBe(`https://phone.test/#invite=${inv}`);
      // QR — ссылки на телефон (слово пользователя 3 нояб.)
      expect(t.$("[data-qr] svg")).not.toBeNull();
      expect(t.$("[data-qr]")!.dataset.qr).toBe(`https://phone.test/#invite=${inv}`);
      await t.click(t.btn("Копировать", t.$("[data-link=\"Телефон\"]")!));
      expect(writes).toEqual([`https://phone.test/#invite=${inv}`]);
      expect(t.$("[data-invited]")!.textContent).toContain("laptop2~you@mail");
      await t.click(t.btn("Готово"));
      const phone = t.$('tr[data-pass="kc2"]')!;
      await t.click(t.btn("Отозвать…", phone));
      await t.click(t.btn("Отозвать", t.$('tr[data-pass="kc2"]')!));
      expect(t.sent("keys.revoke").at(-1)).toMatchObject({ kid: "kc2", to: ".relay" });
    });

    it("5505 · GitHub и устройство: репозитории приложения с поиском, профилей на экране нет; устройство — адрес, пропуск, уведомления; телефон — только устройство", async () => {
      const t = await settings({ url: "/#settings?tab=general" });
      expect(t.$$("[data-github] .st-repo").map((r) => r.dataset.repo)).toEqual(["you/switchboard", "you/profiles", "you/site"]);
      expect(t.$("[data-profiles]")).toBeNull();
      expect(t.btn("Синхронизировать")).toBeNull();
      expect(t.sent("machine.profiles")).toHaveLength(0);
      const dev = t.$("[data-device]")!;
      expect(dev.textContent).toContain("pult~you@mail");
      expect(dev.textContent).toContain("действует");
      expect(dev.querySelector("[data-push]")!.textContent).toBe("выключены");

      const p = await settings({ wide: false, url: "/#settings" });
      expect(p.$("[data-device]")).not.toBeNull();
      expect(p.$("[data-github]")).toBeNull();
      expect(p.$('[data-tab="releases"]')).toBeNull();
      expect(p.sent("releases.list")).toHaveLength(0);
    });

    it("7356 · github.app несёт redirect — адрес пульта: при открытии и при создании; без него Worker отказывает bad_frame", async () => {
      // источник: контракт workers/github — redirect обязателен, туда GitHub вернёт браузер с code; стенд поля не проверяет
      const t = await settings({ url: "/#settings?tab=general", hooks: (r) => void (r.handlers["github.app"] = () => ({ ok: true, result: { app: null } })) });
      const redirect = location.origin + location.pathname;
      expect(t.sent("github.app").at(-1)).toMatchObject({ redirect });
      await t.click(t.btn("Создать приложение GitHub"));
      expect(t.sent("github.app").at(-1)).toMatchObject({ redirect });
    });

    it("7357 · это устройство — адрес пропуска от gate: второе устройство с тем же именем у другого человека не «это»", async () => {
      // источник: контракт workers/gate — keys.list отдаёт you; gate допускает phone~a и phone~b одновременно
      const twin = { id: "kc9", role: "client", name: "pult", person: "anna@mail", addr: "pult~anna@mail", state: "ok", by: "@laptop", at: Date.UTC(2026, 10, 2) };
      const t = await settings({ url: "/#settings?tab=passes", hooks: (r) => void (r.handlers["keys.list"] = () => ({ ok: true, result: { passes: [twin, { ...twin, id: "kc1", person: "you@mail", addr: "pult~you@mail" }] } })) });
      expect(t.$('tr[data-pass="kc1"]')!.textContent).toContain("это устройство");
      expect(t.$('tr[data-pass="kc9"]')!.textContent).not.toContain("это устройство");
    });

    it("6104 · форма создания приложения GitHub уходит один раз: новое открытие экрана её не повторяет", async () => {
      const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
      const t = await settings();
      t.relay.handlers["github.app"] = () => ({ ok: true, result: { app: null, form: { action: "https://github.com/settings/apps/new", manifest: { name: "x" } } } });
      await t.go("#settings?tab=general");
      await t.click(t.btn("Создать приложение GitHub"));
      expect(submit).toHaveBeenCalledTimes(1);
      await t.go("#settings?tab=releases");
      await t.go("#settings?tab=general");
      expect(submit).toHaveBeenCalledTimes(1);
      submit.mockRestore();
    });

    it("7253 · машина из адреса выбрана при открытии; поиск и выбор — местные: окно плана закрывается, поиск сужает таблицу", async () => {
      // источник: чьё: код — машина из адреса открывает план; поиск экрана держит сам экран
      const t = await settings({ url: "/#settings?tab=releases&machine=pc" });
      await flush(10);
      expect(t.$('.st-mx tr[data-machine="pc"]')!.getAttribute("aria-current")).toBe("true");
      await t.click(t.$('[aria-label="Закрыть"]'));
      expect(t.$('.st-mx tr[aria-current="true"]')).toBeNull();
      const q = t.$<HTMLInputElement>('[data-f="rq"]')!;
      q.value = "lapt";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$$('.st-mx tbody tr').map((x) => x.getAttribute("data-machine"))).toEqual(["laptop"]);
    });

    it("7270 · итог выкладки переживает смену вкладки: выкладка идёт десятки секунд, человек успевает уйти", async () => {
      // источник: чьё: код — итог лежал в сторе; факт: сборка страницы идёт 22–45 с
      const t = await settings({ hooks: (r) => void (r.handlers["releases.deploy"] = () => undefined) });
      await t.click(t.btn("Каталог и сборки"));
      await t.click(t.btn("Выложить +13"));
      const id = t.sent("releases.deploy").at(-1)!.id as string;
      await t.click(t.$('[data-tab="passes"]'));
      await flush(10);
      t.relay.reply(id, { ok: true, result: { parts: { pult: { from: "1.2.0+12", to: "1.2.0+13" } } } });
      await flush(10);
      await t.click(t.$('[data-tab="releases"]'));
      await flush(10);
      expect(t.text()).toContain("Выложено: pult 1.2.0+12 → 1.2.0+13");
    });

    it("5506 · GitHub вернул ?code= — «Сохранить приложение» сохраняет его github.setup; поиск Ctrl K находит вкладки настроек", async () => {
      const t = await settings({ url: "/?code=gh123#settings?tab=general" });
      await t.click(t.btn("Сохранить приложение"));
      expect(t.sent("github.setup").at(-1)).toMatchObject({ code: "gh123", to: ".github" });
      expect(location.search).toBe("");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
      await flush();
      const q = document.querySelector<HTMLInputElement>(".sb-palin")!;
      q.value = "пропуска";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toContain("Настройки: пропуска");
    });

    it("7295 · GitHub вернул ?code= без адреса экрана — страница сама открывает «GitHub и устройство»", async () => {
      // источник: чьё: код — раньше это знала оболочка пульта; устав: оболочка модулей не знает
      const t = await settings({ url: "/?code=gh123" });
      expect(t.btn("Сохранить приложение")).toBeTruthy();
    });

    it("6946 · вкладки: «Выпуски» — releases.list и keeper.state; «Пропуска» — keys.list; «GitHub и устройство» — keys.list и github.app", async () => {
      // источник: факт — при открытии ответы владельцев своей вкладки
      const t = await settings();
      expect(t.sent("releases.list").length).toBeGreaterThan(0);
      expect(t.sent("keeper.state").length).toBeGreaterThan(0);
      expect(t.sent("github.app")).toHaveLength(0);
      const t2 = await settings({ url: "/#settings?tab=passes" });
      expect(t2.sent("keys.list").length).toBeGreaterThan(0);
      expect(t2.sent("releases.list")).toHaveLength(0);
      const t3 = await settings({ url: "/#settings?tab=general" });
      expect(t3.sent("keys.list").length).toBeGreaterThan(0);
      expect(t3.sent("github.app").length).toBeGreaterThan(0);
    });

    it("6947 · телефон: keys.list; github.app и keeper.state нет; виден раздел «Это устройство»", async () => {
      // источник: чьё: код
      const t = await settings({ wide: false });
      expect(t.sent("keys.list").length).toBeGreaterThan(0);
      expect(t.sent("github.app")).toHaveLength(0);
      expect(t.sent("keeper.state")).toHaveLength(0);
      expect(t.$("[data-device]")).not.toBeNull();
    });

    it("7343 · матрица: машины — пропуска у gate и roster; ушедшая машина без плана видна, строка плана без пропуска — нет", async () => {
      // источник: бэклог — «ответ releases.list несёт имена машин, хотя их знает gate»; машину не на связи матрица показывает (чьё: код)
      const t = await settings({ offline: ["gone"], hooks: (r) => (r.handlers["releases.list"] = () => ({ ok: true, result: { parts: {}, machines: [{ machine: "ghost", plan: {} }], rev: 1, modules: {} } })) });
      const mx = t.$(".st-mx")!;
      expect(mx.querySelector('[data-machine="laptop"]')).not.toBeNull();
      expect(mx.querySelector('[data-machine="gone"]')).not.toBeNull();
      expect(mx.querySelector('[data-machine="ghost"]')).toBeNull();
    });

    it("7355 · gate отказал экрану в списке машин: отказ словом, машины на связи на месте", async () => {
      // источник: устав — отказ словом, без молчаливого отказа; чьё: код — машины на связи матрица знает из roster
      const t = await settings({ hostsRefused: "denied" });
      expect(t.text()).toContain("keys.list: denied");
      expect(t.$('tr[data-machine="laptop"]')).not.toBeNull();
    });

    it("E33 · каталог молчит: слово над таблицей, машины и ответы keeper на месте", async () => {
      // источник: слово пользователя 4 нояб. — «таймаутить нужно конкретную машину а не весь запрос и отдавать результат частично»
      // сам предел запроса к службе — E2 у клиента флота; здесь — что экран делает со словом
      const t = await settings({ hooks: (r) => (r.handlers["releases.list"] = () => ({ ok: false, error: "timeout" })) });
      expect(t.text()).toContain("releases.list: timeout");
      const mx = t.$(".st-mx")!;
      expect(mx.textContent).toContain("laptop");
      expect(mx.textContent).toContain("pc");
      expect(mx.textContent).toContain("host");
      // части и кнопки, которым нужен каталог, не появляются из ниоткуда
      expect(t.text()).not.toContain("Stable флота");
    });

    it("6949 · владелец отказал: на своей вкладке «запрос: слово»", async () => {
      // источник: устав — отказ словом
      const t = await settings({ hooks: (r) => (r.handlers["releases.list"] = () => ({ ok: false, error: "denied" })) });
      expect(t.text()).toContain("releases.list: denied");
      const t3 = await settings({ url: "/#settings?tab=general", hooks: (r) => (r.handlers["github.app"] = () => ({ ok: false, error: "no_app" })) });
      expect(t3.text()).toContain("github.app: no_app");
      const t2 = await settings({ url: "/#settings?tab=passes", hooks: (r) => (r.handlers["keys.list"] = () => ({ ok: false, error: "denied" })) });
      expect(t2.text()).toContain("keys.list: denied");
    });

    it("6989 · уведомления на устройстве: подписан — «включены»; браузер не умеет — своё слово, ошибок нет", async () => {
      // источник: факт — off: браузер не умеет; разрешение спрашивается только по нажатию
      const sub = fakeBrowser("granted");
      await (await sub.sw!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(1) });
      const t = await settings({ url: "/#settings?tab=general", browser: sub });
      expect(t.$("[data-device]")!.textContent).toContain("включены");
      expect(sub.calls).not.toContain("requestPermission");
      const t2 = await settings({ url: "/#settings?tab=general", browser: {} });
      expect(t2.$("[data-device]")!.textContent).toContain("браузер не умеет");
    });
  });

  describe("видимое (чьё: код)", () => {
    it("V-S1 · слова отказа выкладки: у каждого своё; незнакомое — как есть", async () => {
      const words = [
        ["no_build", "приложение не собирается «Выпусками»"],
        ["cf_failed", "Cloudflare не принял"],
        ["bad_version", "номер версии не того вида"],
        ["strange_word", "strange_word"],
      ];
      const t = await settings();
      await t.click(t.btn("Каталог и сборки"));
      for (const [word, text] of words) {
        t.relay.handlers["releases.deploy"] = () => ({ ok: false, error: word });
        await t.click(t.btn("Выложить 0.2.0", t.$('tr[data-module="web-inbox"]')!));
        expect(t.text()).toContain(`Не выложен web-inbox 0.2.0: ${text}`);
      }
    });

    it("V-S2 · каталог: заголовки; пока идёт выкладка — «Выкладываю…» и кнопки неактивны", async () => {
      const t = await settings({ hooks: (r) => void (r.handlers["releases.deploy"] = () => undefined) });
      await t.click(t.btn("Каталог и сборки"));
      expect(t.$$(".st-cat .sb-sec > b").map((x) => x.textContent)).toEqual(["Части", "Модули сборок"]);
      expect(t.$$('.st-cat .st-tbl')[0].textContent).toContain("Cloudflare");
      expect(t.$$('.st-cat .st-tbl')[0].textContent).toContain("машины");
      expect(t.$$('.st-cat .st-tbl')[1].querySelector("thead")!.textContent).toBe("модульвходит вв сборкеновее");
      await t.click(t.btn("Выложить +13"));
      expect(t.$('tr[data-part="pult"]')!.textContent).toContain("Выкладываю…");
      expect(t.btn("Вернуть +11", t.$('tr[data-part="pult"]')!)!.disabled).toBe(true);
    });

    it("V-S3 · матрица и план: подписи; план меняется — тост «план rev»; разом — «машины: план изменён», отказ одной — словами; «Снять»", async () => {
      const t = await settings();
      expect(t.$<HTMLInputElement>('[data-f="rq"]')!.getAttribute("aria-label")).toBe("Найти машину");
      expect(t.$('tr[data-machine="pc"] .st-ck')!.getAttribute("aria-label")).toBe("Выбрать pc");
      expect(t.$(".st-matrix .st-end")!.textContent).toBe("2 машины");
      await t.click(t.btn("@laptop"));
      expect(t.$('[data-plan="laptop"]')!.textContent).toContain("план rev 9");
      expect(t.$('[data-plan="laptop"] [aria-label="Версия host"]')).not.toBeNull();
      await t.click(t.btn("📌 +6", t.$('[data-plan="laptop"] [data-part="host"]')!));
      expect(t.$(".sb-toast")!.textContent).toBe("@laptop: план rev 10");
      await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
      await t.click(t.$('tr[data-machine="pc"] .st-ck'));
      expect(t.$("[data-bulk]")!.textContent).toContain("@laptop, @pc");
      await t.click(t.btn("Снять", t.$("[data-bulk]")!));
      expect(t.$("[data-bulk]")).toBeNull();
      await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
      await t.click(t.$('tr[data-machine="pc"] .st-ck'));
      await t.click(t.btn("host: к stable"));
      await flush(5);
      expect(t.$$(".sb-toast").map((x) => x.textContent)).toContain("2 машины: план изменён");
      t.relay.handlers["releases.set"] = (f: Frame) => (f.machine === "pc" ? { ok: false, error: "no_release" } : { ok: true, result: { rev: 11 } });
      await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
      await t.click(t.$('tr[data-machine="pc"] .st-ck'));
      await t.click(t.btn("host: к stable"));
      await flush(5);
      expect(t.text()).toContain("1 машина: план изменён; @pc host: такой версии нет");
    });

    it("V-S4 · без «Выпусков» во флоте — строка вместо вкладки; план с отказом — слово у машины", async () => {
      const { releases: _r, ...workers } = FakeRelay.WORKERS;
      const t = await settings({ workers });
      expect(t.text()).toContain("«Выпусков» во флоте нет");
      expect(t.sent("releases.list")).toHaveLength(0);
      const t2 = await settings({ hooks: (r) => void (r.handlers["releases.set"] = () => ({ ok: false, error: "no_part" })) });
      await t2.click(t2.btn("@pc"));
      await t2.click(t2.btn("включена", t2.$('[data-plan="pc"] [data-part="hello-daemon"]')!));
      expect(t2.$('[data-plan="pc"]')!.textContent).toContain("@pc hello-daemon: такой части нет");
      // keeper не выключается планом; причина сбоя части — в плане
      expect(t2.btn("включена", t2.$('[data-plan="pc"] [data-part="keeper"]')!)).toBeNull();
      expect(t2.$('[data-plan="pc"] [data-part="hello-daemon"]')!.textContent).toContain("exit 1: нет файла конфигурации");
    });

    it("V-S5 · пропуска: заголовки таблиц, «ждёт приёма»; отзыв — тост и строка перечитана; отказ — словами; приглашение программе и машине", async () => {
      const passes = [
        { id: "kh1", role: "host", name: "laptop", person: null, addr: "@laptop", state: "ok", by: "агент", at: Date.UTC(2026, 10, 1) },
        { id: "kc2", role: "client", name: "phone", person: "you@mail", addr: "phone~you@mail", state: "wait", by: "pult~you@mail", at: Date.UTC(2026, 10, 2) },
      ];
      const t = await settings({ url: "/#settings?tab=passes", hooks: (r) => void (r.handlers["keys.list"] = () => ({ ok: true, result: { passes } })) });
      expect(t.$('[data-passes="Устройства и программы"] thead')!.textContent).toBe("адрессостояниекто пригласилкогда");
      expect(t.$('tr[data-pass="kc2"]')!.textContent).toContain("ждёт приёма");
      const read = t.sent("keys.list").length;
      await t.click(t.btn("Отозвать…", t.$('tr[data-pass="kc2"]')!));
      await t.click(t.btn("Отмена", t.$('tr[data-pass="kc2"]')!));
      expect(t.btn("Отозвать…", t.$('tr[data-pass="kc2"]')!)).not.toBeNull();
      await t.click(t.btn("Отозвать…", t.$('tr[data-pass="kc2"]')!));
      await t.click(t.btn("Отозвать", t.$('tr[data-pass="kc2"]')!));
      expect(t.$(".sb-toast")!.textContent).toBe("phone~you@mail отозван — соединения закрыты");
      expect(t.sent("keys.list").length).toBeGreaterThan(read);
      t.relay.handlers["keys.revoke"] = () => ({ ok: false, error: "unknown_key" });
      await t.click(t.btn("Отозвать…", t.$('tr[data-pass="kc2"]')!));
      await t.click(t.btn("Отозвать", t.$('tr[data-pass="kc2"]')!));
      expect(t.text()).toContain("phone~you@mail: такого пропуска нет");

      const typeIn = async (label: string, v: string) => {
        const el = t.$<HTMLInputElement>(`[aria-label="${label}"]`)!;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await flush();
      };
      await t.click(t.btn("Пригласить"));
      await t.click(t.btn("программа", t.$("[data-invite]")!));
      expect(t.$<HTMLInputElement>('[aria-label="Имя"]')!.placeholder).toBe("laptop");
      t.relay.handlers["keys.invite"] = () => ({ ok: false, error: "name_taken" });
      await typeIn("Имя", "bot");
      await typeIn("Почта", "you@mail");
      await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
      expect(t.$("[data-invite]")!.textContent).toContain("у адреса уже есть живой пропуск — сначала отзовите прежний");
      t.relay.handlers["keys.invite"] = (f: Frame) => ({ ok: true, result: { kid: "k1", invite: "k1.SECRET", addr: `${f.name}~${f.person}` } });
      await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
      expect(t.$("[data-invited]")!.textContent).toContain("Приглашение для bot~you@mail");
      expect(t.$("[data-invited] code")!.textContent).toBe("k1.SECRET");
      expect(t.$("[data-qr]")).toBeNull();
      await t.click(t.btn("Готово"));
      await t.click(t.btn("Пригласить"));
      await t.click(t.btn("машина", t.$("[data-invite]")!));
      expect(t.$<HTMLInputElement>('[aria-label="Имя"]')!.placeholder).toBe("имя машины");
      expect(t.$('[aria-label="Почта"]')).toBeNull();
      t.relay.handlers["keys.invite"] = (f: Frame) => ({ ok: true, result: { kid: "k2", invite: "k2.SECRET", addr: `@${f.name}` } });
      await typeIn("Имя", "edge");
      await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
      expect(t.sent("keys.invite").at(-1)).toMatchObject({ role: "host", name: "edge" });
      expect(t.sent("keys.invite").at(-1)).not.toHaveProperty("person");
      expect(t.$("[data-invited]")!.textContent).toContain("Приглашение машины @edge");
    });

    it("V-S6 · приглашение устройству: QR с подписью; приглашение переживает смену вкладки, пока не «Готово»", async () => {
      const t = await settings({ url: "/#settings?tab=passes", workers: { ...FakeRelay.WORKERS, phone: "https://phone.test/" } });
      await t.click(t.btn("Пригласить"));
      await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
      expect(t.$("[data-invited]")!.textContent).toContain("Ссылка для ");
      expect(t.$("[data-qr]")!.getAttribute("aria-label")).toBe("QR ссылки для телефона");
      await t.click(t.$('[data-tab="general"]'));
      await t.click(t.$('[data-tab="passes"]'));
      await flush(5);
      expect(t.$("[data-invited]")).not.toBeNull();
      await t.click(t.btn("Готово"));
      expect(t.$("[data-invited]")).toBeNull();
    });

    it("V-S7 · GitHub: заголовок, поиск репозитория и «Таких нет», ссылка доступа; нет приложения — организация; отказ создания; код из адреса — промежуточное и итог", async () => {
      const t = await settings({ url: "/#settings?tab=general" });
      expect(t.$("[data-github] > b")!.textContent).toBe("Приложение GitHub флота");
      expect(t.$("[data-github]")!.textContent).toContain("switchboard-fleet");
      expect(t.$("[data-github]")!.textContent).toContain("3 репозитория");
      expect(t.$<HTMLAnchorElement>("[data-github] a")!.textContent).toBe("Доступ на GitHub ↗");
      const q = t.$<HTMLInputElement>('[data-f="gq"]')!;
      expect([q.placeholder, q.getAttribute("aria-label")]).toEqual(["Найти репозиторий", "Найти репозиторий"]);
      q.value = "site";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$$("[data-repo]").map((x) => x.dataset.repo)).toEqual(["you/site"]);
      q.value = "нет такого";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$("[data-github]")!.textContent).toContain("Таких нет");

      const t2 = await settings({ url: "/#settings?tab=general", hooks: (r) => void (r.handlers["github.app"] = (f: Frame) => (f.org ? { ok: false, error: "app_exists" } : { ok: true, result: { app: null } })) });
      const org = t2.$<HTMLInputElement>('[data-f="org"]')!;
      expect([org.placeholder, org.getAttribute("aria-label")]).toEqual(["организация", "Организация"]);
      org.value = "acme";
      org.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await t2.click(t2.btn("Создать приложение GitHub"));
      expect(t2.sent("github.app").at(-1)).toMatchObject({ org: "acme" });
      expect(t2.$("[data-github]")!.textContent).toContain("приложение GitHub флота уже есть");

      const t3 = await settings({ url: "/?code=gh123#settings?tab=general", hooks: (r) => void (r.handlers["github.setup"] = () => undefined) });
      expect(t3.$("[data-github]")!.textContent).toContain("GitHub вернул код нового приложения.");
      await t3.click(t3.btn("Сохранить приложение"));
      expect(t3.$("[data-github]")!.textContent).toContain("Сохраняю приложение…");
      t3.relay.reply(t3.sent("github.setup").at(-1)!.id as string, { ok: true, result: { app: { slug: "x" }, install: "u" } });
      await flush(10);
      expect(t3.$("[data-github]")!.textContent).toContain("Приложение сохранено — установите его на репозитории.");
      expect(t3.btn("Сохранить приложение")).toBeNull();
      const t4 = await settings({ url: "/?code=gh1#settings?tab=general", hooks: (r) => void (r.handlers["github.setup"] = () => ({ ok: false, error: "not_installed" })) });
      await t4.click(t4.btn("Сохранить приложение"));
      expect(t4.$("[data-github]")!.textContent).toContain("приложение GitHub не допущено к репозиторию");
      expect(t4.btn("Сохранить приложение")).not.toBeNull();
    });

    it("V-S8 · уведомления устройства: слово на каждое состояние метки; пропуска нет — прочерк", async () => {
      const words: Array<[string | undefined, string]> = [["on", "включены"], ["ask", "выключены"], ["error", "не включились"], ["working", "включаю…"], ["denied", "запрещены в браузере"], ["off", "браузер не умеет"], [undefined, "—"]];
      for (const [state, word] of words) {
        const relay = fleet().relay;
        const part = { manifest: alertsM, module: () => ({ marks: { "alerts.state": () => state } }) } as unknown as AppPart;
        const t = await stand([{ manifest: settingsM, module: createSettings }, part], { relay, store: memoryStore({ key: "client.pult.k3f1.Qa7sig" }), wide: true, url: "/#settings?tab=general" });
        await flush(5);
        expect(t.$("[data-push]")!.textContent).toBe(word);
      }
      const t = await settings({ url: "/#settings?tab=general", hooks: (r) => void (r.handlers["keys.list"] = () => ({ ok: true, result: { passes: [] } })) });
      const dev = t.$("[data-device]")!;
      expect(dev.textContent).toContain("пропуск—");
      await t.click(t.btn("Пропуска", dev));
      expect(location.hash).toBe("#settings?tab=passes");
    });
  });

  it("V-S9 · своя версия в плане — закрепить; «Вернуть» в «Stable флота» — прежняя сборка", async () => {
    const t = await settings();
    await t.click(t.btn("Вернуть +6", t.$('[data-roll="host"]')!));
    expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "host", version: "1.2.0+6" });
    expect(t.text()).toContain("Выложено: host");
    await t.click(t.btn("@laptop"));
    const part = t.$('[data-plan="laptop"] [data-part="host"]')!;
    await t.click(t.btn("Закрепить", part));
    expect(t.sent("releases.set").filter((f) => f.machine === "laptop" && f.part === "host")).toHaveLength(0);
    const v = part.querySelector<HTMLInputElement>(".st-ver")!;
    expect(v.placeholder).toBe("версия");
    v.value = " 1.2.0+5 ";
    v.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await t.click(t.btn("Закрепить", t.$('[data-plan="laptop"] [data-part="host"]')!));
    expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "laptop", part: "host", pin: "1.2.0+5" });
  });
});

describe("Найдено сверкой деревьев", () => {
  // источник: чьё: код — разметка и правила, которые снимки и прежние леса не держали; сверка деревьев старого и нового кода 5 нояб.
  const cut = (...names: string[]) => {
    const r = fleetRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract };
      for (const n of names) delete m.contract[n];
    }
    return r;
  };

  it("машины: нет machine.login — нет «＋ войти»; нет ответа keeper — «…»; ушедшая — без кнопок", async () => {
    const r = cut("machine.login");
    const relay = fleetRelay(r);
    relay.handlers["keeper.state"] = () => undefined;
    const t = await pult({ relay, url: "/#accounts" });
    await flush(5);
    expect(t.$('[data-machine="laptop"] [data-login-start]')).toBeNull();
    await t.click(t.$('[data-machine="laptop"] .ac-mname'));
    expect(t.$('[data-machine-parts="laptop"] .sb-note')!.textContent).toBe("…");
    expect(t.btn(t.$('[data-machine-parts="laptop"]'), "План в «Выпусках»")).not.toBeNull();
    relay.setRoster({ ...r, machines: r.machines.filter((m) => m.machine !== "laptop") });
    await flush(5);
    expect(t.$('[data-machine-parts="laptop"] button')).toBeNull();
    expect(t.$('[data-machine="laptop"] [data-login-start]')).toBeNull();
  });

  it("настройки: вид и отметки переживают вкладку, поиск — нет; ячейка: keeper своим номером, обновляется — upd", async () => {
    const relay = fleetRelay();
    relay.handlers["releases.list"] = () => ({ ok: true, result: { parts: { host: { where: "machine", edge: "2", stable: "2", versions: ["1", "2"] }, keeper: { where: "machine", edge: "9", stable: "9", versions: ["9"] } }, machines: [], rev: 1, modules: {} } });
    relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "8", rev: 1, os: "linux", parts: [{ part: "host", version: "1", state: "updating" }, { part: "keeper", version: "9", state: "running" }] } });
    relay.handlers["keys.list"] = () => ({ ok: true, result: { passes: [] } });
    const t = await pult({ relay, url: "/#settings" });
    await flush(10);
    expect(t.$('tr[data-machine="pc"] td[data-part="host"] .st-cell')!.className).toContain("upd");
    expect(t.$('tr[data-machine="pc"] td[data-part="keeper"]')!.textContent).toBe("8 → 9");
    await t.click(t.$('tr[data-machine="pc"] .st-ck'));
    await t.type(t.$('[data-f="rq"]'), "pc");
    await t.click(t.$('[data-tab="passes"]'));
    await t.click(t.$('[data-tab="releases"]'));
    await flush(5);
    expect(t.$("[data-bulk]")).not.toBeNull();
    expect(t.$<HTMLInputElement>('[data-f="rq"]')!.value).toBe("");
    await t.click(t.btn(t.$(".sb-page"), "Каталог и сборки"));
    await t.click(t.$('[data-tab="general"]'));
    await t.click(t.$('[data-tab="releases"]'));
    await flush(5);
    expect(t.$(".st-cat")).not.toBeNull();
  });

  it("настройки: отказ правки нескольких машин при закрытом плане не пропадает молча", async () => {
    // источник: устав — ошибка словом; спорное место сноса, опыт: на старом коде строки не было
    const relay = fleetRelay();
    relay.handlers["releases.list"] = () => ({ ok: true, result: { parts: {}, machines: [], rev: 1, modules: {} } });
    relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1", rev: 1, os: "linux", parts: [] } });
    relay.handlers["releases.set"] = (f) => (f.machine === "pc" ? { ok: false, error: "no_release" } : { ok: true, result: { rev: 2 } });
    const t = await pult({ relay, url: "/#settings" });
    await flush(10);
    await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
    await t.click(t.$('tr[data-machine="pc"] .st-ck'));
    await t.click(t.btn(t.$("[data-bulk]"), "host: к stable"));
    await flush(10);
    expect(t.$(".sb-toast")!.textContent).toBe("1 машина: план изменён; @pc host: такой версии нет");
  });
});
