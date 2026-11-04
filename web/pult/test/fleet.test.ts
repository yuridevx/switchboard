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
