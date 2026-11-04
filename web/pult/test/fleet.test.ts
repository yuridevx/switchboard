// Эталоны вида «Пульт: флот» — аккаунты, слоты, машины. Стенд — поддельный relay с заданным roster
// и ответами владельцев; код пульта настоящий. Номер эталона — номер теста.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

const T = (hh: number, mm: number) => Math.floor(Date.UTC(2026, 9, 31, hh, mm) / 1000);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны пульта: аккаунты и слоты", () => {
  async function newLogin(code: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?x" } });
    relay.handlers["machine.login_code"] = () => code;
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await t.click(t.btn(null, "+ Новый аккаунт"));
    await t.click(t.btn(t.$(".sb-sec.dlg"), "laptop"));
    await t.type(t.$('[data-f="account"]'), "corp");
    await t.click(t.btn(t.$(".sb-sec.dlg"), "Войти"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ v: 1, machine: "laptop", account: "corp" })]);
    expect(t.$('[data-login="laptop:corp"] a')!.getAttribute("href")).toBe("https://claude.ai/oauth/authorize?x");
    await t.type(t.$('[data-f="code"]'), "Xk2p…#Qm9w…");
    await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Отправить"));
    return t;
  }

  it("190 · вход: machine.login → ссылка; один machine.login_code с кодом как есть; кода нет в хранилище, поле пустое; «Вошёл: corp@… · max»", async () => {
    const t = await newLogin({ ok: true, result: { email: "corp@x.io", plan: "max" } });
    expect(t.relay.sent("machine.login_code")).toEqual([{ type: "machine.login_code", id: expect.any(String), v: 1, machine: "laptop", account: "corp", code: "Xk2p…#Qm9w…" }]);
    expect(JSON.stringify(t.store.data)).not.toContain("Xk2p");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.$('[data-login="laptop:corp"]')!.textContent).toContain("Вошёл: corp@x.io · max");
  });

  it("191 · bad_code: «Код не принят — вход закрыт», второго machine.login_code нет; «Войти заново» — новый machine.login", async () => {
    const t = await newLogin({ ok: false, error: "bad_code" });
    const card = t.$('[data-login="laptop:corp"]')!;
    expect(card.textContent).toContain("Код не принят — вход закрыт");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
    await t.click(t.btn(card, "Войти заново"));
    expect(t.relay.sent("machine.login")).toHaveLength(2);
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
  });

  it("192 · лимиты по почте: machine.accounts { max_age: 120 } каждой машине; расход между машинами пульт не пересылает — его читает Host у Claude", async () => {
    // источник: дизайн «Пульт и телефон» (подписан 2 нояб.): «пересылки account.usage нет»; Host — эталон slots 3047
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: {
        accounts:
          f.machine === "laptop"
            ? { y0902: { email: "y0902@x.io", plan: "max", login: "ok", links: [], limits: { five_hour: { utilization: 0.04, resetsAt: T(16, 20), at: T(14, 40), src: "poll" } } } }
            : {
                y0902: {
                  email: "y0902@x.io",
                  plan: "max",
                  login: "ok",
                  links: [],
                  limits: { five_hour: { utilization: 0.09, resetsAt: T(16, 20), at: T(14, 55), src: "event" }, seven_day: { utilization: 0.66, resetsAt: T(20, 0), at: T(14, 58), src: "laptop" } },
                },
              },
      },
    });
    relay.handlers["account.usage"] = () => ({ ok: true });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await flush(10);
    expect(relay.sent("machine.accounts").map((f) => [f.machine, f.max_age])).toEqual([
      ["laptop", 120],
      ["pc", 120],
    ]);
    expect(relay.sent("account.usage")).toEqual([]);
    // одна карточка на почту; окна — запись одной машины, как пришла
    expect(t.$$("[data-account]")).toHaveLength(1);
    expect(t.$$('[data-account] [data-window]').map((x) => x.textContent!.split(" · ")[0])).toEqual(["5 ч4 %"]);
  });

  async function slots(swap: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers[SLOTS] = (f) =>
      ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: "y0902", order: ["y0902", "infirex", "work3"], wait: null, sessions: ["site@laptop", "profiles@laptop"] } } : {} } });
    relay.handlers["slot.swap"] = () => swap;
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await t.click(t.$('[data-slot="laptop:main"] [data-act="swap"]'));
    return t;
  }

  it("193 · «Сменить сейчас» → «следующего по порядку»: slot.swap без account, ответ to — в карточке; no_reserve — словами, слот прежний, повтора нет", async () => {
    const t = await slots({ ok: true, result: { from: "y0902", to: "infirex" } });
    expect(t.relay.sent("slot.swap")).toEqual([{ type: "slot.swap", id: expect.any(String), v: 1, machine: "laptop", slot: "main" }]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    const t2 = await slots({ ok: false, error: "no_reserve" });
    expect(t2.$('[data-slot="laptop:main"]')!.textContent).toContain("В запасе нет вошедшего ниже порога — слот прежний");
    expect(t2.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    expect(t2.relay.sent("slot.swap")).toHaveLength(1);
  });

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

  it("268 · один аккаунт в двух слотах: «в слотах main, bot» и «Сессии main/bot»; в слоте — «сейчас и в слоте bot»; удаление меняет его в обоих слотах по очереди", async () => {
    const relay = fleetRelay();
    const both = { main: ["infirex", "y0902"], bot: ["infirex", "y0902"] };
    const current: Record<string, string> = { main: "infirex", bot: "infirex" };
    relay.handlers[SLOTS] = (f) => ({
      ok: true,
      result: { slots: f.machine === "laptop" ? Object.fromEntries(Object.entries(both).map(([n, o]) => [n, { account: current[n], order: o, wait: null, sessions: [`${n}-s@laptop`] }])) : {} },
    });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: { accounts: f.machine === "laptop" ? { infirex: { login: "ok", limits: {} }, y0902: { login: "ok", limits: {} } } : {} },
    });
    relay.handlers["slot.swap"] = (f) => ((current[f.slot as string] = "y0902"), { ok: true, result: { from: "infirex", to: "y0902" } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "y0902" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await flush(10);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте bot");
    expect(t.$('[data-slot="laptop:bot"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте main");
    await t.go("#accounts?view=accounts");
    await flush(10);
    const row = t.$$('[data-machine="laptop"]').find((x) => x.textContent!.startsWith("@laptop") && x.textContent!.includes("в слотах"))!;
    expect(row.textContent).toContain("в слотах main, bot");
    expect(t.$$("[data-sess]").map((b) => b.textContent)).toEqual(["Сессии main (1)…", "Сессии bot (1)…"]);
    await t.click(t.btn(row, "Удалить…"));
    expect(t.$('[data-dlg="rm"]')!.textContent).toContain("infirex сейчас в слотах main, bot");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    await flush(10);
    // шаги выполняет машина: один запрос (слово пользователя 4 нояб.)
    expect(relay.sent("slot.swap")).toHaveLength(0);
    expect(relay.sent("slot.set")).toHaveLength(0);
    expect(relay.sent("machine.account_remove")).toEqual([expect.objectContaining({ machine: "laptop", account: "infirex" })]);
  });

  it("194 · подмену делает Host: до roster запросов нет; сменился account — один machine.accounts к laptop; «в слоте: y0902»; в чате site — «⇄ аккаунт: infirex → y0902»", async () => {
    const r = fleetRoster();
    for (const s of r.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "infirex", slot: { name: "main", wait: null } });
    const relay = fleetRelay(r);
    let inSlot = "infirex";
    relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: inSlot, order: ["infirex", "y0902"], wait: null, sessions: ["site@laptop", "wiki@laptop", "profiles@laptop"] } } : {} } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.go("#accounts?view=slots");
    await flush(10);
    const before = relay.got.length;
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    inSlot = "y0902";
    const r2 = fleetRoster();
    for (const s of r2.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "y0902", slot: { name: "main", wait: null } });
    relay.setRoster(r2);
    await flush(10);
    const after = relay.got.slice(before);
    expect(after.map((f) => `${f.type} ${f.machine}`)).toEqual(["machine.accounts laptop"]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$(".chat-sys.swap")!.textContent).toBe("аккаунт: infirex → y0902");
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
    await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
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
    await t.click(t.$('[data-row="pc"] .mc-head'));
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
    expect(t.$('[data-row="pc"]')!.getAttribute("data-state")).toBe("fail");
  });
});
