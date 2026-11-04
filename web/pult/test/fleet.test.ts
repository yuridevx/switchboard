// Эталоны вида «Пульт: флот» — аккаунты, слоты, машины, точки. Стенд — поддельный relay с заданным roster
// и ответами владельцев; код пульта настоящий. Номер эталона — номер теста.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pointsRelay, pult, SID, SLOTS } from "./stand.ts";

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

describe("эталоны пульта: точки", () => {
  it("196 · перенос: dryRun к pc → «тот же репозиторий»; points.save со стопом → points.raise к pc с point 42 → «site перенесена на pc»; закрыли вкладку — новое «Перенести» снова с points.save, та же точка", async () => {
    const run = async (same: boolean) => {
      const relay = pointsRelay();
      relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same", branch: "main", sessions: [] } } : { ok: true, result: { callsign: "site@pc", point: 43, folder: "same", branch: "points-1031-1453" } });
      relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same } });
      const t = await pult({ relay });
      await t.click(t.$('[data-callsign="site@laptop"]'));
      await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
      await flush(10);
      await t.click(t.btn(null, "Перенести…"));
      await flush(10);
      expect(relay.sent("points.raise")[0]).toEqual(expect.objectContaining({ machine: "pc", sid: SID, point: 41, dir: "~/Projects/site", files: "point", dryRun: true }));
      expect(t.$('[data-dlg="move"] [data-check]')!.textContent).toBe("тот же репозиторий, своих правок нет — правки точки применятся");
      await t.click(t.$('[data-dlg="move"] [data-act="run"]'));
      return { t, relay };
    };
    const { t, relay } = await run(false);
    const steps = relay.got.filter((f) => f.type === "points.save" || (f.type === "points.raise" && !f.dryRun));
    expect(steps.map(({ id: _, ...f }) => f)).toEqual([
      { type: "points.save", v: 1, callsign: "site@laptop", stop: true },
      { type: "points.raise", v: 1, machine: "pc", sid: SID, point: 42, dir: "~/Projects/site", files: "point" },
    ]);
    expect(t.$('[data-dlg="move"] [data-phase="done"]')!.textContent).toContain("site перенесена на pc: site@pc");
    const again = await run(true);
    expect(again.relay.got.filter((f) => f.type === "points.save" || (f.type === "points.raise" && !f.dryRun)).map((f) => [f.type, f.point ?? null])).toEqual([
      ["points.save", null],
      ["points.raise", 42],
    ]);
  });

  it("197 · «пожар»: mac нет в roster — плашка «mac не на связи с ЧЧ:ММ · 2 сессии ждут»; dryRun на каждую; points.raise по одной, scrape — после ответа notes; points.save нет; open_failed — строка «не поднялась»", async () => {
    const relay = fleetRelay();
    const left = Date.UTC(2026, 9, 31, 3, 12);
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: {
        sessions: [
          { sid: "77ae", callsign: "notes@mac", dir: "~/notes", owner: "mac", head: { id: 88, at: Date.UTC(2026, 9, 31, 3, 5) }, points: 88, branches: 0 },
          { sid: "51cd", callsign: "scrape@mac", dir: "~/scrape", owner: "mac", head: { id: 61, at: Date.UTC(2026, 9, 31, 2, 50) }, points: 61, branches: 0 },
        ],
        r2: { bytes: 1, blocks: 1 },
        sweep: null,
      },
    });
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ id: 812, t: left, ev: "machine.left", from: "ledger", machine: "mac", text: "mac пропала" }], more: true } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "empty", sessions: [] } } : f.sid === "51cd" ? { ok: false, error: "open_failed" } : undefined);
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    expect(relay.sent("ledger.read")).toEqual([expect.objectContaining({ to: ".ledger", machine: "mac", limit: 1 })]);
    const d = new Date(left);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(t.$('[data-fire="mac"] b')!.textContent).toBe(`mac не на связи с ${hm} · 2 сессии ждут на последних точках`);
    expect(t.$('.sb-navcol button[data-screen="points"]')!.textContent).toBe("Точки");
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    expect(relay.sent("points.raise").map((f) => [f.machine, f.sid, f.dryRun])).toEqual([
      ["laptop", "77ae", true],
      ["laptop", "51cd", true],
    ]);
    await t.click(t.btn(null, "Перенести 2 из 2 на laptop"));
    const real = () => relay.sent("points.raise").filter((f) => !f.dryRun);
    expect(real().map((f) => f.sid)).toEqual(["77ae"]);
    expect(t.$('[data-dlg="fire"] [data-progress]')!.textContent).toContain("0 из 2 готовы — не закрывайте страницу");
    relay.reply(String(real()[0].id), { ok: true, result: { callsign: "notes@laptop", point: 89, folder: "empty" } });
    await flush(10);
    expect(real().map((f) => [f.sid, f.point, f.slot, f.files])).toEqual([
      ["77ae", 88, undefined, "point"],
      ["51cd", 61, undefined, "point"],
    ]);
    expect(relay.sent("points.save")).toHaveLength(0);
    expect(t.$('[data-dlg="fire"] [data-progress]')!.textContent).toContain("1 из 2 готовы");
    expect(t.$('[data-row="notes"]')!.textContent).toContain("готова — notes@laptop");
    expect(t.$('[data-row="scrape"]')!.textContent).toContain("не поднялась");
  });

  const fireRelay = () => {
    const relay = fleetRelay();
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: {
        sessions: [
          { sid: "77ae", callsign: "notes@mac", dir: "~/notes", owner: "mac", head: { id: 88, at: Date.UTC(2026, 9, 31, 3, 5) }, points: 88, branches: 0 },
          { sid: "51cd", callsign: "scrape@mac", dir: "~/scrape", owner: "mac", head: { id: 61, at: Date.UTC(2026, 9, 31, 2, 50) }, points: 61, branches: 0 },
        ],
        r2: { bytes: 1, blocks: 1 },
        sweep: null,
      },
    });
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [], more: false } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "empty", sessions: [] } } : undefined);
    return relay;
  };

  it("7292 · закрыли окно переноса: идущая доходит, оставшиеся ждут, второй перенос не начать, пока идёт", async () => {
    // источник: слово интерфейса «Закроете — оставшиеся ждут на точках, плашка останется»; слепой архитектор 4 нояб.
    const relay = fireRelay();
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    await t.click(t.btn(null, "Перенести 2 из 2 на laptop"));
    const real = () => relay.sent("points.raise").filter((f) => !f.dryRun);
    expect(real().map((f) => f.sid)).toEqual(["77ae"]);
    await t.click(t.btn(t.$('[data-dlg="fire"]'), "Закрыть"));
    expect(t.btn(null, "Перенести на другую машину…")).toBeFalsy();
    relay.reply(String(real()[0].id), { ok: true, result: { callsign: "notes@laptop", point: 89, folder: "empty" } });
    await flush(10);
    expect(real().map((f) => f.sid)).toEqual(["77ae"]);
    expect(t.btn(null, "Перенести на другую машину…")).toBeTruthy();
  });

  it("7293 · отказ удаления точек — словом отказа, а не зелёной карточкой", async () => {
    // источник: устав — отказ словом; слепой архитектор 4 нояб.: зелёная карточка «Запись — в „Журнале флота“» на отказ
    const relay = fleetRelay();
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: { sessions: [{ sid: "9f03", callsign: "old-bot@laptop", dir: "~/Projects/bot", owner: "laptop", head: { id: 212, at: Date.UTC(2026, 8, 2) }, points: 57, branches: 0 }], r2: { bytes: 1, blocks: 1 }, sweep: null },
    });
    relay.handlers["points.delete"] = () => ({ ok: false, error: "not_owner" });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    await t.click(t.btn(t.$('[data-sid="9f03"]'), "Удалить…"));
    await t.type(t.$('[data-f="del:9f03"]'), "old-bot");
    await t.click(t.$('[data-act="delete"]'));
    await flush(10);
    expect(t.$('[data-only] [role="alert"]')!.textContent).toBe("points.delete: not_owner");
    expect(t.$("[data-only]")!.textContent).not.toContain("Журнале флота");
  });

  it("7294 · вкладка точек сессии: реестр без журнала флота", async () => {
    // источник: слепой архитектор 4 нояб. — sidOf звал обзор и лишние ledger.read
    const relay = pointsRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [], more: false } });
    relay.handlers["points.list"] = (f) =>
      f.sid
        ? { ok: true, result: { owner: "laptop", head: null, points: [] } }
        : { ok: true, result: { sessions: [{ sid: "77ae", callsign: "notes@mac", dir: "~/notes", owner: "mac", head: { id: 88, at: 1 }, points: 88, branches: 0 }], r2: { bytes: 1, blocks: 1 }, sweep: null } };
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    await flush(10);
    expect(relay.sent("points.list").length).toBeGreaterThan(0);
    expect(relay.sent("ledger.read")).toHaveLength(0);
  });

  it("198 · «только в R2»: с «old-bo» кнопка недоступна, запросов нет; с «old-bot» — points.delete { sid } → строка пропала, «old-bot удалена — 57 точек»", async () => {
    const relay = fleetRelay();
    let gone = false;
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: { sessions: gone ? [] : [{ sid: "9f03", callsign: "old-bot@laptop", dir: "~/Projects/bot", owner: "laptop", head: { id: 212, at: Date.UTC(2026, 8, 2) }, points: 57, branches: 0 }], r2: { bytes: 1, blocks: 1 }, sweep: null },
    });
    relay.handlers["points.delete"] = () => ((gone = true), { ok: true, result: { points: 57, blocks: 9, bytes: 1 } });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    expect(t.$('[data-only] [data-sid="9f03"]')).not.toBeNull();
    await t.click(t.btn(t.$('[data-sid="9f03"]'), "Удалить…"));
    const before = relay.got.length;
    await t.type(t.$('[data-f="del:9f03"]'), "old-bo");
    expect(t.$<HTMLButtonElement>('[data-act="delete"]')!.disabled).toBe(true);
    expect(relay.got.length).toBe(before);
    await t.type(t.$('[data-f="del:9f03"]'), "old-bot");
    await t.click(t.$('[data-act="delete"]'));
    expect(relay.sent("points.delete")).toEqual([expect.objectContaining({ to: ".points", sid: "9f03" })]);
    await flush(10);
    expect(t.$('[data-sid="9f03"]')).toBeNull();
    expect(t.$("[data-only]")!.textContent).toContain("old-bot удалена — 57 точек");
  });

  it("6105 · повторное «Удалить…» очищает поле имени: поле и кнопка показывают одно", async () => {
    const relay = fleetRelay();
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: { sessions: [{ sid: "9f03", callsign: "old-bot@laptop", dir: "~/Projects/bot", owner: "laptop", head: { id: 212, at: Date.UTC(2026, 8, 2) }, points: 57, branches: 0 }], r2: { bytes: 0 } },
    });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    await t.click(t.btn(t.$('[data-sid="9f03"]'), "Удалить…"));
    await t.type(t.$('[data-f="del:9f03"]'), "old-bot");
    expect(t.$<HTMLButtonElement>('[data-act="delete"]')!.disabled).toBe(false);
    await t.click(t.btn(t.$('[data-sid="9f03"]'), "Удалить…"));
    expect(t.$<HTMLInputElement>('[data-f="del:9f03"]')!.value).toBe("");
    expect(t.$<HTMLButtonElement>('[data-act="delete"]')!.disabled).toBe(true);
  });

  it("262 · не в R2: points.list и points.get не шлются, переноса и отката нет; «Хранить в R2» — session.r2 on; второй прогон: «wik» — недоступно, «wiki» — session.r2 off → «12 точек удалено», points.delete нет", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = (f) => ({ ok: true, result: f.on ? { point: 1 } : { deleted: 12 } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    expect(t.$('[data-r2="off"] b')!.textContent).toBe("wiki@laptop не в R2");
    // реестр прочитан один раз при первом roster; линия сессии не спрашивалась
    expect(relay.sent("points.list").filter((f) => f.sid)).toHaveLength(0);
    expect(relay.sent("points.get")).toHaveLength(0);
    expect(t.btn(null, "Перенести…")).toBeNull();
    expect(t.btn(null, "Сменить папку…")).toBeNull();
    await t.click(t.$('[data-r2="off"] [data-act="r2"]'));
    expect(relay.sent("session.r2")).toEqual([expect.objectContaining({ v: 1, callsign: "wiki@laptop", on: true })]);
    expect(t.$("[data-note]")!.textContent).toContain("Первая точка — №1");

    const relay2 = pointsRelay((r) => Object.assign(r.sessions[4], { r2: {} }));
    relay2.handlers["session.r2"] = relay.handlers["session.r2"];
    const t2 = await pult({ relay: relay2 });
    await t2.click(t2.$('[data-callsign="wiki@laptop"]'));
    await t2.click(t2.$('.cw-tabs [data-tab="session.points"]'));
    await flush(10);
    await t2.click(t2.$('[data-r2="on"] ~ .sb-sec [data-act="r2"]'));
    await t2.type(t2.$('[data-f="unmark"]'), "wik");
    expect(t2.$<HTMLButtonElement>('[data-act="unmark"]')!.disabled).toBe(true);
    expect(relay2.sent("session.r2")).toHaveLength(0);
    await t2.type(t2.$('[data-f="unmark"]'), "wiki");
    await t2.click(t2.$('[data-act="unmark"]'));
    expect(relay2.sent("session.r2")).toEqual([expect.objectContaining({ callsign: "wiki@laptop", on: false })]);
    expect(t2.$("[data-note]")!.textContent).toContain("12 точек удалено из R2 — сразу, без отмены");
    expect(relay2.sent("points.delete")).toHaveLength(0);
  });

  it("261 · смена папки: points.save со стопом → points.raise copy в новую папку, files keep → session.remove прежней; open_failed — «Копия не поднялась», session.remove нет", async () => {
    const run = async (raise: { ok: true; result: unknown } | { ok: false; error: string }) => {
      const relay = pointsRelay();
      relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
      relay.handlers["points.raise"] = () => raise;
      relay.handlers["session.remove"] = () => ({ ok: true });
      const t = await pult({ relay });
      await t.click(t.$('[data-callsign="site@laptop"]'));
      await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
      await flush(10);
      await t.click(t.$('[data-act="dir"]'));
      expect(t.$<HTMLInputElement>('[data-dlg="dir"] [data-f="dir"]')!.value).toBe("~/Projects/site-v2");
      expect(t.$<HTMLInputElement>('[data-dlg="dir"] [data-f="name"]')!.value).toBe("site-v2");
      await t.click(t.$('[data-dlg="dir"] [data-act="run"]'));
      return { t, relay };
    };
    const { relay } = await run({ ok: true, result: { callsign: "site-v2@laptop", point: 1, folder: "keep", branch: null } });
    const steps = relay.got.filter((f) => ["points.save", "points.raise", "session.remove"].includes(f.type)).map(({ id: _, ...f }) => f);
    expect(steps).toEqual([
      { type: "points.save", v: 1, callsign: "site@laptop", stop: true },
      { type: "points.raise", v: 1, machine: "laptop", sid: SID, point: 42, dir: "~/Projects/site-v2", files: "keep", copy: true, name: "site-v2", slot: "main" },
      { type: "session.remove", v: 1, callsign: "site@laptop" },
    ]);
    const bad = await run({ ok: false, error: "open_failed" });
    expect(bad.t.$('[data-dlg="dir"] [data-phase="err"]')!.textContent).toContain("Копия не поднялась");
    expect(bad.relay.sent("session.remove")).toHaveLength(0);
  });

  it("263 · откат к 10:00: «Привязка к claude.ai снимется»; points.save со стопом, затем points.raise с точкой 38; новая remote.url из roster — в «В claude.ai»; remote пульт не зовёт", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    relay.handlers["points.raise"] = () => ({ ok: true, result: { callsign: "site@laptop", point: 43, folder: "keep", branch: null } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    await flush(10);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.$('[data-card="38"] [data-act="rb"]'));
    expect(t.$('[data-dlg="rb"] [data-remote]')!.textContent).toContain("Привязка к claude.ai снимется");
    await t.click(t.$('[data-dlg="rb"] [data-act="run"]'));
    const steps = relay.got.filter((f) => f.type === "points.save" || f.type === "points.raise");
    expect(steps.map((f) => [f.type, f.stop ?? null, f.point ?? null])).toEqual([
      ["points.save", true, null],
      ["points.raise", null, 38],
    ]);
    const r = fleetRoster();
    Object.assign(r.sessions[2], { r2: {}, remote: { url: "https://claude.ai/code/session_02Qx" } });
    relay.setRoster(r);
    await flush();
    await t.click(t.$('[data-pop="menu"]'));
    expect(t.$<HTMLAnchorElement>('.cw-pop a[href^="https://claude.ai/"]')!.getAttribute("href")).toBe("https://claude.ai/code/session_02Qx");
    expect(relay.got.some((f) => f.type.startsWith("remote"))).toBe(false);
  });
});
