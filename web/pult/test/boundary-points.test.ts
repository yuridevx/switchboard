// Леса границы «точка сессии», сторона страницы: настоящий пульт на поддельном relay. Вход — экран и кадры контракта, исход — кадры relay, текст и якоря разметки.
// Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { pultParts } from "../stand/parts.ts";
import { fleetRelay, fleetRoster, flush, HOST, pointsRelay, pult, SID, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
const at = (hh: number, mm: number) => Date.UTC(2026, 9, 31, hh, mm);

/** Реестр с сессиями хозяина mac (mac не в roster) и ответы машин на пробы и подъём. */
function fireRelay(over: (r: Roster) => void = () => {}) {
  const r = fleetRoster();
  over(r);
  const relay = fleetRelay(r);
  relay.handlers["points.list"] = () => ({
    ok: true,
    result: {
      sessions: [
        { sid: "s1", callsign: "one@mac", dir: "~/p1", owner: "mac", head: { id: 5, at: at(9, 0) }, points: 5, branches: 0 },
        { sid: "s2", callsign: "two@mac", dir: "~/p2", owner: "mac", head: { id: 9, at: at(9, 30) }, points: 9, branches: 0 },
      ],
      r2: { bytes: 0, blocks: 0 },
      sweep: null,
    },
  });
  relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ id: 1, t: at(10, 0), ev: "machine.left", from: ".relay", text: "mac ушла" }], more: false } });
  relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: { [f.machine === "pc" ? "main" : "bot"]: {} } } });
  relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: `${String(f.sid) === "s1" ? "one" : "two"}@${f.machine}` } });
  return relay;
}

async function points(relay = fireRelay()) {
  const t = await pult({ relay });
  await t.click(t.$('.sb-navcol button[data-screen="points"]'));
  await flush(10);
  return t;
}

describe("обзор точек", () => {
  it("7251 · машина ушла до открытия: карточка «Вам» считает машины, а не сессии, и знает о ней без экрана точек", async () => {
    // источник: подпись карточки «машин не на связи»; ушедшие до открытия знает модуль точек
    const relay = pointsRelay();
    const row = (sid: string) => ({ sid, callsign: `${sid}@old`, dir: "~/x", owner: "old", head: { id: 1, at: at(8, 0) }, points: 1, branches: 0 });
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [row("a"), row("b"), row("c")], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    const t = await pult({ relay, url: "/#inbox" });
    await flush(10);
    expect(t.$('[data-kind="fire"]')!.textContent).toContain("машин не на связи: 1");
    // реестр спрошен один раз: новый roster его не перечитывает; журнал — только с экрана точек
    relay.setRoster(relay.roster);
    await flush();
    expect(relay.sent("points.list")).toHaveLength(1);
    expect(relay.sent("ledger.read")).toHaveLength(0);
  });

  it("4163 · обзор реестра: в R2, только в R2, не в R2, объём и уборка", async () => {
    const relay = pointsRelay();
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: {
        sessions: [
          { sid: SID, callsign: "site@laptop", dir: "~/Projects/site", owner: "laptop", head: { id: 41, at: at(14, 49) }, points: 41, branches: 1 },
          { sid: "old", callsign: "old-bot@pc", dir: "~/old", owner: "pc", head: { id: 3, at: at(8, 0) }, points: 3, branches: 0 },
        ],
        r2: { bytes: 432013312, blocks: 2410 },
        sweep: { at: at(3, 0), blocks: 12, bytes: 10485760 },
      },
    });
    const t = await points(relay);
    expect(relay.sent("points.list")[0]).toMatchObject({ to: ".points" });
    expect(t.$("[data-summary]")!.textContent).toBe("1 сессия в R2 из 6 на машинах· 1 только в R2");
    expect(t.$(`[data-sid="${SID}"]`)!.textContent).toContain("Сохранить сейчас");
    const only = t.$('[data-only] [data-sid="old"]')!;
    expect(only.textContent).toContain("Удалить…");
    expect(only.textContent).toContain("Перенести на машину…");
    expect(t.text()).toContain("не в R2");
    expect(t.text()).toMatch(/В R2 412 МБ · уборка \d+ окт\.? \d\d:\d\d — удалено 12 блоков, 10 МБ/);
  });

  it("4164 · «Сохранить сейчас» — points.save, тост «точка №N»; отказ — тост словами", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    const t = await points(relay);
    await t.click(t.btn(t.$(`[data-sid="${SID}"]`), "Сохранить сейчас"));
    expect(relay.sent("points.save")).toEqual([expect.objectContaining({ callsign: "site@laptop" })]);
    expect(t.$(".sb-toast")!.textContent).toBe("site@laptop: точка №42");
    expect(relay.sent("points.list").length).toBeGreaterThanOrEqual(2);
    relay.handlers["points.save"] = () => ({ ok: false, error: "waiting" });
    await t.click(t.btn(t.$(`[data-sid="${SID}"]`), "Сохранить сейчас"));
    expect(t.$(".sb-toast")!.textContent).toBe("site@laptop: site@laptop ждёт ответа человека — после ответа или с «прервать»");
  });

  it("4165 · отказ points.delete — «points.delete: слово», строка осталась", async () => {
    const relay = pointsRelay();
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [{ sid: "old", callsign: "old-bot@pc", dir: "~/old", owner: "pc", head: { id: 3, at: at(8, 0) }, points: 3, branches: 0 }], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    relay.handlers["points.delete"] = () => ({ ok: false, error: "not_found" });
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Удалить…"));
    await t.type(t.$('[data-f="del:old"]'), "old-bot");
    await t.click(t.$('[data-act="delete"]'));
    expect(t.text()).toContain("points.delete: not_found");
    expect(t.$('[data-only] [data-sid="old"]')).not.toBeNull();
  });

  it("4166 · отказ points.list — «points.list: слово» вместо «…»", async () => {
    const relay = pointsRelay();
    relay.handlers["points.list"] = () => ({ ok: false, error: "disconnected" });
    const t = await points(relay);
    expect(t.$(".sb-detail, .sb-view")!.textContent).toContain("points.list: disconnected");
  });
});

describe("«пожар»", () => {
  it("4167 · проба: другой репозиторий — переноса нет", async () => {
    const relay = fireRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: f.sid === "s2" ? "other" : "same" } } : { ok: true, result: { callsign: "x" } });
    const t = await points(relay);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    expect(t.$('[data-row="two"]')!.textContent).toContain("Другой репозиторий — выберите другую папку");
    expect(t.btn(t.$('[data-dlg="fire"]'), /^Перенести 2 из 2/)!.disabled).toBe(true);
    expect(relay.sent("points.raise").filter((f) => !f.dryRun)).toEqual([]);
  });

  it("4168 · сессию уже подняли — «уже подняли на другой машине», следующая всё равно идёт", async () => {
    const relay = fireRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : f.sid === "s1" ? { ok: false, error: "not_owner" } : { ok: true, result: { callsign: "two@laptop" } });
    const t = await points(relay);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="fire"]'), /^Перенести 2 из 2/));
    await flush(10);
    expect(t.$('[data-row="one"]')!.textContent).toContain("уже подняли на другой машине");
    expect(t.$('[data-row="two"]')!.textContent).toContain("готова — two@laptop");
    expect(t.$("[data-progress]")!.dataset.progress).toBe("1/2");
  });

  it("4196 · флот больше шести машин: машина подъёма — выбранная кнопкой, остальные списком «ещё N…»; выбор из списка — пробы на неё", async () => {
    // источник: подпись экрана p05 прототипа «Пульт и телефон» (подписан 2 нояб.): машины проекта кнопками, остальные списком
    const relay = fireRelay((r) => {
      const c = r.machines[0].contract;
      for (const m of ["b1", "b2", "b3", "b4", "b5", "b6"]) r.machines.push({ machine: m, since: 1, proto: 1, contract: { ...c } });
    });
    const t = await points(relay);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    const dlg = t.$('[data-dlg="fire"]')!;
    const sel = dlg.querySelector<HTMLSelectElement>('select[data-f="target"]')!;
    expect(sel.options[0].textContent).toBe("ещё 7…");
    expect(dlg.querySelectorAll('.sb-opts button[aria-pressed="true"]')).toHaveLength(1);
    sel.value = "b3";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(10);
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "b3" });
  });

  it("4169 · другая машина-цель — слоты и пробы заново, кнопка на неё", async () => {
    const t = await points();
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    // машина вне проекта — в списке «ещё N…» (подпись экрана p05)
    const sel = t.$<HTMLSelectElement>('[data-dlg="fire"] select[data-f="target"]')!;
    sel.value = "pc";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(10);
    expect(t.relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "pc" });
    expect(t.relay.sent("points.raise").filter((f) => f.machine === "pc" && f.dryRun)).toHaveLength(2);
    expect(t.btn(t.$('[data-dlg="fire"]'), "Перенести 2 из 2 на pc")).not.toBeNull();
  });
});

describe("перенос сессии «только в R2»", () => {
  const onlyRelay = () => {
    const relay = fireRelay();
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [{ sid: "old", callsign: "old-bot@pc", dir: "~/b", owner: "pc", head: { id: 4, at: at(8, 0) }, points: 4, branches: 0 }], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    return relay;
  };

  it("4170 · проба, подъём — «old-bot поднята: …», реестр перечитан", async () => {
    const relay = onlyRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: "old-bot@laptop" } });
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    expect(relay.sent("points.raise")[0]).toMatchObject({ machine: "laptop", sid: "old", point: 4, dir: "~/b", files: "point", dryRun: true });
    const lists = relay.sent("points.list").length;
    await t.click(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop"));
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ machine: "laptop", sid: "old", point: 4 });
    expect(relay.sent("points.raise").at(-1)).not.toHaveProperty("slot");
    expect(relay.sent("points.raise").at(-1)).not.toHaveProperty("dryRun");
    expect(t.$('[data-dlg="raise"]')!.textContent).toContain("old-bot поднята: old-bot@laptop");
    expect(relay.sent("points.list").length).toBe(lists + 1);
  });

  it("6514 · подъём из точки на другой машине: новая сессия в проекте исходной; без проекта запись не меняется", async () => {
    const relay = onlyRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "work", name: "Работа", sessions: ["old-bot@pc"] }] };
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: "old-bot@laptop" } });
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop"));
    await flush(5);
    expect(relay.scoped.global["fleet.projects"]).toEqual([{ id: "work", name: "Работа", sessions: ["old-bot@pc", "old-bot@laptop"] }]);
  });

  it("4171 · подъём отказал — «Не поднялась на laptop», кнопка снова доступна", async () => {
    const relay = onlyRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: false, error: "open_failed" });
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop"));
    expect(t.$('[data-dlg="raise"]')!.textContent).toContain("Не поднялась на laptop");
    expect(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop")!.disabled).toBe(false);
  });

  it("4172 · проба: другой репозиторий или отказ — «Поднять» недоступна", async () => {
    for (const [answer, text] of [
      [{ ok: true, result: { folder: "other" } }, "Другой репозиторий — выберите другую папку"],
      [{ ok: false, error: "offline" }, "Машина не на связи"],
    ] as const) {
      const relay = onlyRelay();
      relay.handlers["points.raise"] = () => answer;
      const t = await points(relay);
      await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
      await flush(10);
      expect(t.$('[data-dlg="raise"]')!.textContent).toContain(text);
      expect(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop")!.disabled).toBe(true);
      expect(relay.sent("points.raise").filter((f) => !f.dryRun)).toEqual([]);
    }
  });
});

/** Вкладка «Точки» карточки site@laptop. */
async function sessionTab(relay = pointsRelay(), callsign = "site@laptop") {
  const t = await pult({ relay });
  await t.expand();
  await t.click(t.$(`[data-callsign="${callsign}"]`));
  await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
  await flush(10);
  return t;
}

describe("вкладка «Точки» сессии", () => {
  it("4173 · линия, ветки и первые слова; карточка точки — копия и откат", async () => {
    const t = await sessionTab();
    expect(t.relay.sent("points.list").at(-1)).toMatchObject({ sid: SID });
    expect(t.relay.sent("points.get")).toEqual([expect.objectContaining({ v: 2, ids: [41, 38, 33] })]);
    expect(t.$('[data-r2="on"] .sb-ph b')!.textContent).toMatch(/^Точка .+ · №41$/);
    expect(t.$('[data-point="33"]')!.textContent).toContain("ветка · №33");
    expect(t.$('[data-point="41"]')!.textContent).toContain("«обнови зависимости и прогони тесты»");
    await t.click(t.$('[data-point="38"]'));
    const c = t.$('[data-card="38"]')!;
    expect(c.textContent).toContain("№38");
    expect(t.btn(c, "Скопировать из этой точки…")).not.toBeNull();
    expect(t.btn(c, "Откатить к этой точке…")).not.toBeNull();
  });

  it("4174 · «Сохранить точку» — «Точка №N — та же», линия перечитана; отказ — слово", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: true } });
    const t = await sessionTab(relay);
    const lists = relay.sent("points.list").length;
    await t.click(t.btn(null, "Сохранить точку"));
    expect(t.$("[data-note]")!.textContent).toBe("Точка №42 — та же, файлы не менялись");
    expect(relay.sent("points.list").length).toBeGreaterThan(lists);
    relay.handlers["points.save"] = () => ({ ok: false, error: "running" });
    await t.click(t.btn(null, "Сохранить точку"));
    expect(t.$("[data-note]")!.textContent).toBe("Сессия ещё идёт — сначала точка со стопом");
  });

  it("4175 · отказ session.r2 — «Машина не на связи», пометки нет", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = () => ({ ok: false, error: "offline" });
    const t = await sessionTab(relay, "wiki@laptop");
    const box = t.$<HTMLInputElement>('[data-r2="off"] [data-act="r2"]')!;
    box.click();
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Машина не на связи");
    expect(t.$('[data-r2="off"]')).not.toBeNull();
    // 6111 · после отказа галочка снята: следующий клик снова означает «включить»
    expect(box.checked).toBe(false);
  });

  it("4176 · последняя точка не удалась — причина в заголовке вкладки", async () => {
    const relay = pointsRelay((r) => Object.assign(r.sessions[2], { r2: { error: "r2_unavailable" } }));
    const t = await sessionTab(relay);
    expect(t.$('[data-r2="on"]')!.textContent).toContain("последняя точка не удалась: r2_unavailable");
  });

  it("4177 · вкладка «Точки» — только у машины с session.r2", async () => {
    const relay = pointsRelay((r) => {
      const pc = { ...HOST };
      delete pc["session.r2"];
      r.machines[1].contract = pc;
    });
    const t = await pult({ relay });
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$$(".cw-tabs [data-tab]").map((x) => x.dataset.tab)).toContain("session.points");
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    expect(t.$('.cw-place [data-r2="on"]')).not.toBeNull();
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    expect(t.$$(".cw-tabs [data-tab]").map((x) => x.dataset.tab)).not.toContain("session.points");
  });

  it("5124 · «Точки» — экран pult-points в месте card.tab: карточка без опций, вкладка между «Разговором» и «Настройками»", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): вкладка «Точки» через место card.tab; опций у карточки 0
    expect(pultParts().find((p) => p.manifest.name === "pult-points")!.manifest.uses["card.tab@web-card"]).toBe(1);
    const t = await pult({ relay: pointsRelay() });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$$(".cw-tabs [data-tab]").map((x) => [x.dataset.tab, x.textContent])).toEqual([
      ["chat", "Разговор"],
      ["session.points", "Точки"],
      ["set", "Настройки"],
      ["log", "Журнал"],
    ]);
  });

  it("4195 · первые слова не отданы — «points.get: слово» на вкладке, линия видна", async () => {
    // источник: чьё: код (вкладка «Точки»: отказ реестра — словом, points.ts — refused)
    const relay = pointsRelay();
    relay.handlers["points.get"] = () => ({ ok: false, error: "disconnected" });
    const t = await sessionTab(relay);
    expect(t.$('[data-r2="on"]')!.textContent).toContain("points.get: disconnected");
    expect(t.$('[data-point="41"]')).not.toBeNull();
  });

  it("4178 · реестр не отдал линию — «points.list: слово» вместо «…», points.get нет", async () => {
    const relay = pointsRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => (f.sid ? { ok: false, error: "disconnected" } : list(f));
    const t = await sessionTab(relay);
    expect(t.$('[data-r2="on"]')!.textContent).toContain("points.list: disconnected");
    expect(relay.sent("points.get")).toHaveLength(0);
  });
});

describe("диалоги точек", () => {
  const dialogRelay = () => {
    const relay = pointsRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: `${f.name ?? "site"}@${f.machine}`, point: f.point, folder: "same", branch: null } });
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    return relay;
  };
  const run = (t: P) => t.click(t.$('[data-act="run"]'));

  it("4179 · копия из точки — без points.save, своё имя и папка, copy", async () => {
    const relay = dialogRelay();
    const t = await sessionTab(relay);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.btn(t.$('[data-card="38"]'), "Скопировать из этой точки…"));
    await flush(10);
    await run(t);
    expect(relay.sent("points.save")).toHaveLength(0);
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ machine: "pc", sid: SID, point: 38, dir: "~/Projects/site-copy", files: "point", copy: true, name: "site-copy" });
    expect(t.$('[data-dlg="copy"] [data-phase]')!.textContent).toBe("Копия поднята: site-copy@pc. Исходная сессия не менялась.");
  });

  it("4180 · points.save отказал — подъём не уходит, слово отказа", async () => {
    const relay = dialogRelay();
    relay.handlers["points.save"] = () => ({ ok: false, error: "waiting" });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    await run(t);
    expect(relay.sent("points.raise").filter((f) => !f.dryRun)).toEqual([]);
    expect(t.$('[data-dlg="move"] [data-phase="err"]')!.textContent).toBe("site ждёт ответа человека — после ответа или с «прервать»");
  });

  it("4181 · проба: другой репозиторий — запуск недоступен, points.save нет", async () => {
    const relay = dialogRelay();
    relay.handlers["points.raise"] = () => ({ ok: true, result: { folder: "other" } });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    expect(t.$('[data-dlg="move"] [data-check]')!.textContent).toBe("Другой репозиторий — выберите другую папку");
    expect(t.$<HTMLButtonElement>('[data-act="run"]')!.disabled).toBe(true);
    expect(relay.sent("points.save")).toHaveLength(0);
  });

  it("4182 · копия «сейчас» — свежая точка без стопа, подъём с её номером", async () => {
    const relay = dialogRelay();
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Скопировать…"));
    await flush(10);
    await run(t);
    expect(relay.sent("points.save")).toEqual([{ type: "points.save", v: 1, id: expect.any(String), callsign: "site@laptop" }]);
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ machine: "pc", point: 42, copy: true, name: "site-copy" });
  });

  it("4183 · «прервать ответ и сделать сразу» — points.save со stop и interrupt", async () => {
    const relay = dialogRelay();
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    const box = [...t.$('[data-dlg="move"]')!.querySelectorAll("label")].find((l) => l.textContent === "прервать ответ и сделать сразу")!.querySelector("input")!;
    box.click();
    await flush();
    await run(t);
    expect(relay.sent("points.save")[0]).toMatchObject({ callsign: "site@laptop", stop: true, interrupt: true });
  });

  describe("E16 · окно смены папки", () => {
    // источник: факт — такая копия уходила со слота на общий вход
    const run = async (relay: ReturnType<typeof pointsRelay>, callsign = "site@laptop") => {
      relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
      relay.handlers["points.raise"] = () => ({ ok: true, result: { callsign: "site-v2@laptop", point: 1, folder: "keep", branch: null } });
      relay.handlers["session.remove"] = () => ({ ok: true });
      const t = await sessionTab(relay, callsign);
      await t.click(t.$('[data-act="dir"]'));
      expect(t.$("[data-slot-pick]")).toBeNull();
      await t.click(t.$('[data-dlg="dir"] [data-act="run"]'));
      await flush(10);
      return t;
    };
    const bare = () =>
      pointsRelay((r) => {
        for (const x of r.sessions) if (x.callsign === "site@laptop") delete x.slot;
      });

    it("сессия в слоте — текущий слот", async () => {
      const relay = pointsRelay();
      await run(relay);
      expect(relay.sent("points.raise").at(-1)).toMatchObject({ copy: true, slot: "main" });
    });

    it("сессия без слота, два слота на машине — первый", async () => {
      const relay = bare();
      relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", order: ["a"], wait: null, sessions: [] }, bot: { account: "b", order: ["b"], wait: null, sessions: [] } } } });
      await run(relay);
      expect(relay.sent("points.raise").at(-1)).toMatchObject({ copy: true, slot: "main" });
    });

    it("сессия без слота, один слот — поля нет, решает машина", async () => {
      const relay = bare();
      await run(relay);
      expect(relay.sent("points.raise").at(-1)).toMatchObject({ copy: true });
      expect(relay.sent("points.raise").at(-1)).not.toHaveProperty("slot");
    });

    it("сессия без слота, список не пришёл — сессия не остановлена, слово", async () => {
      const relay = bare();
      relay.handlers[SLOTS] = () => ({ ok: false, error: "timeout" });
      const t = await run(relay);
      expect(relay.sent("points.save")).toHaveLength(0);
      expect(relay.sent("points.raise")).toHaveLength(0);
      expect(t.$('[data-dlg="dir"] [data-phase="err"]')!.textContent).toContain("machine.accounts: timeout");
    });
  });

  it("E24 · окно переноса: два слота — отмечен текущий, выбранный уходит; варианта «без слота» нет", async () => {
    const relay = dialogRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { bot: { account: "b", order: ["b"], wait: null, sessions: [] }, main: { account: "a", order: ["a"], wait: null, sessions: [] } } } });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    expect(t.$('[data-dlg="move"] [data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-dlg="move"]')!.textContent).not.toContain("без слота");
  });

  it("E6 · реестр точек не ответил: слово на месте точек, а не «Точек ещё нет»", async () => {
    const relay = pointsRelay();
    relay.handlers["points.list"] = () => ({ ok: false, error: "timeout" });
    const t = await sessionTab(relay);
    expect(t.$('[data-r2="on"] .sb-ph b')!.textContent).toBe("points.list: timeout");
  });

  it("4189 · список слотов цели не пришёл — проверка словом, запуск недоступен, points.save нет", async () => {
    const relay = dialogRelay();
    relay.handlers[SLOTS] = () => ({ ok: false, error: "offline" });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    expect(t.$('[data-dlg="move"] [data-check="error"]')!.textContent).toBe("machine.accounts: offline");
    expect(t.$<HTMLButtonElement>('[data-act="run"]')!.disabled).toBe(true);
    expect(relay.sent("points.raise")).toHaveLength(0);
    expect(relay.sent("points.save")).toHaveLength(0);
  });

  it("4184 · перенос: подъём сорвался — «Не поднялась на pc — снова идёт на laptop», session.remove нет", async () => {
    const relay = dialogRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: false, error: "open_failed" });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    await run(t);
    expect(t.$('[data-dlg="move"] [data-phase="err"]')!.textContent).toBe("Не поднялась на pc — снова идёт на laptop");
    expect(t.$<HTMLButtonElement>('[data-act="run"]')!.disabled).toBe(false);
    expect(relay.sent("session.remove")).toHaveLength(0);
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

describe("поле папки в точках", () => {
  it("6939 · папку набрали и ушли с поля: проба по новому значению, запрос один", async () => {
    // источник: чьё: код
    const relay = pointsRelay();
    relay.handlers["points.raise"] = () => ({ ok: true, result: { folder: "same" } });
    const t = await pult({ relay });
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    await flush(10);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    const dir = t.$<HTMLInputElement>('[data-f="dir"]')!;
    const before = relay.sent("points.raise").length;
    dir.value = "~/новая";
    dir.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    dir.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush(5);
    const asked = relay.sent("points.raise").slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ dryRun: true, dir: "~/новая" });
  });
});

/** Сессия «только в R2» в обзоре и ответы подъёма. */
const oneOnly = (extra: Partial<{ dir: string; callsign: string; at: number }> = {}) => {
  const relay = fireRelay();
  relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [{ sid: "old", callsign: extra.callsign ?? "old-bot@pc", dir: extra.dir ?? "~/b", owner: "pc", head: { id: 4, at: extra.at ?? at(8, 0) }, points: 4, branches: 0 }], r2: { bytes: 0, blocks: 0 }, sweep: null } });
  relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: "old-bot@laptop" } });
  return relay;
};

describe("видимое: обзор", () => {
  it("пустой обзор: заголовок, сводка, строка «нет», объём без уборки, строка не в R2", async () => {
    const relay = fleetRelay();
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    const t = await points(relay);
    const page = t.$(".sb-detail, .sb-view")!.textContent!;
    expect(page).toContain("Точки");
    expect(t.$("[data-summary]")!.textContent).toBe("0 сессий в R2 из 6 на машинах· 0 только в R2");
    expect(page).toContain("Последняя точка");
    expect(page).toContain("Сессий в R2 на связи нет.");
    expect(page).toContain("Только в R2 · 0");
    expect(page).toMatch(/[\w@, -]*site@laptop[\w@, -]* не в R2/);
    expect(page).toContain("В R2 0 МБ");
    expect(page).not.toContain("уборка");
    expect(t.$<HTMLInputElement>('[data-only] [data-f="q"]')!.placeholder).toBe("⌕ имя, папка или месяц…");
  });

  it("реестр ещё не ответил — «…»; отказ при открытом обзоре — слово, данные остаются", async () => {
    const relay = fleetRelay();
    relay.handlers["points.list"] = () => undefined;
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    expect(t.$(".sb-detail, .sb-view")!.textContent).toContain("…");
    expect(t.$("[data-summary]")).toBeNull();
    relay.reply(String(relay.sent("points.list").at(-1)!.id), { ok: true, result: { sessions: [], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    await flush(10);
    relay.reply(String(relay.sent("points.list").at(-1)!.id), { ok: true, result: { sessions: [], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    await flush(10);
    expect(t.$("[data-summary]")).not.toBeNull();
    relay.handlers["points.list"] = () => ({ ok: false, error: "timeout" });
    await t.click(t.$('.sb-navcol button[data-screen="inbox"]'));
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    expect(t.$('.sb-detail [role="alert"], .sb-view [role="alert"]')!.textContent).toBe("points.list: timeout");
    expect(t.$("[data-summary]")).not.toBeNull();
  });

  it("строка сессии в R2: имя метки, давность и номер; старые сверху; без points.save кнопки нет", async () => {
    const relay = pointsRelay((r) => Object.assign(r.machines[0], { contract: Object.fromEntries(Object.entries(HOST).filter(([k]) => k !== "points.save")) }));
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: {
        sessions: [
          { sid: "a", callsign: "site@laptop", dir: "~/s", owner: "laptop", head: { id: 7, at: Date.now() - 60_000 }, points: 7, branches: 0 },
          { sid: "b", callsign: "poe-bot@pc", dir: "~/p", owner: "pc", head: { id: 3, at: Date.now() - 3_600_000 }, points: 3, branches: 0 },
        ],
        r2: { bytes: 0, blocks: 0 },
        sweep: null,
      },
    });
    const t = await points(relay);
    expect(t.$$(".pt-row[data-sid]").map((x) => x.dataset.sid)).toEqual(["b", "a"]);
    expect(t.$('.pt-row[data-sid="a"] b')!.textContent).toBe("site");
    expect(t.$('.pt-row[data-sid="a"] span')!.textContent).toMatch(/^site .+ · №7$/);
    expect(t.btn(t.$('.pt-row[data-sid="a"]'), "Сохранить сейчас")).toBeNull();
    expect(t.btn(t.$('.pt-row[data-sid="b"]'), "Сохранить сейчас")).not.toBeNull();
    expect(t.$("[data-summary]")!.textContent).toContain("2 сессии в R2 из 6 на машинах");
  });

  it("«Сохранить сейчас» та же точка — «— та же» в тосте, тост ok", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 41, same: true } });
    const t = await points(relay);
    await t.click(t.btn(t.$(`[data-sid="${SID}"]`), "Сохранить сейчас"));
    expect(t.$(".sb-toast")!.textContent).toBe("site@laptop: точка №41 — та же");
  });

  it("«только в R2»: строка, поиск по имени, папке и месяцу, новые сверху; итог удаления с журналом", async () => {
    const relay = fleetRelay();
    const row = (sid: string, name: string, dir: string, month: number) => ({ sid, callsign: `${name}@pc`, dir, owner: "pc", head: { id: 1, at: Date.UTC(2026, month, 15) }, points: 1, branches: 0 });
    let sessions = [row("a", "alpha", "~/one", 2), row("b", "beta", "~/two", 8)];
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions, r2: { bytes: 0, blocks: 0 }, sweep: null } });
    relay.handlers["points.delete"] = () => ((sessions = [row("b", "beta", "~/two", 8)]), { ok: true, result: { points: 2, blocks: 0, bytes: 0 } });
    const t = await points(relay);
    expect(t.$$("[data-only] [data-sid]").map((x) => x.dataset.sid)).toEqual(["b", "a"]);
    expect(t.$('[data-only] [data-sid="a"] span')!.textContent).toMatch(/^alpha ~\/one · последняя точка /);
    const q = t.$('[data-only] [data-f="q"]');
    await t.type(q, "ALPH");
    expect(t.$$("[data-only] [data-sid]").map((x) => x.dataset.sid)).toEqual(["a"]);
    await t.type(q, "two");
    expect(t.$$("[data-only] [data-sid]").map((x) => x.dataset.sid)).toEqual(["b"]);
    await t.type(q, "");
    await t.click(t.btn(t.$('[data-sid="a"]'), "Удалить…"));
    const dlg = t.$('[data-dlg="delete"]')!;
    expect(dlg.textContent).toContain("Удалить точки «alpha» насовсем");
    expect(dlg.textContent).toContain("Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет.");
    expect(dlg.textContent).toContain("Введите имя сессии: alpha");
    expect(t.$<HTMLInputElement>('[data-f="del:a"]')!.placeholder).toBe("alpha");
    expect(t.$('[data-act="delete"]')!.textContent).toBe("Удалить насовсем");
    await t.click(t.btn(dlg, "Отмена"));
    expect(t.$('[data-dlg="delete"]')).toBeNull();
    await t.click(t.btn(t.$('[data-sid="a"]'), "Удалить…"));
    await t.type(t.$('[data-f="del:a"]'), "alpha");
    await t.click(t.$('[data-act="delete"]'));
    await flush(10);
    const ok = t.$('[data-only] [role="status"]')!;
    expect(ok.textContent).toContain("alpha удалена — 2 точки");
    expect(ok.textContent).toContain("Запись — в «Журнале флота».");
    expect(t.$("[data-only]")!.textContent).toContain("Только в R2 · 1");
  });

  it("сессия реестра без имени: строка по sid; нет папки — «~»", async () => {
    const relay = fireRelay();
    relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: [{ sid: "12345678", owner: "pc", head: { id: 4, at: at(8, 0) }, points: 4, branches: 0 }], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    const t = await points(relay);
    expect(t.$('[data-only] [data-sid="12345678"] b')!.textContent).toBe("12345678");
    await t.click(t.btn(t.$('[data-sid="12345678"]'), "Перенести на машину…"));
    await flush(10);
    expect(relay.sent("points.raise")[0]).toMatchObject({ dir: "~" });
  });

  it("окно подъёма: заголовок, машина, папка, ход и «Закрыть»; нет машин с подъёмом — переноса нет", async () => {
    const relay = oneOnly();
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    const d = () => t.$('[data-dlg="raise"]')!;
    expect(d().querySelector("b")!.textContent).toBe("Поднять old-bot из точки №4");
    expect(d().textContent).toContain("Машина");
    expect(d().textContent).toContain("Папка");
    expect(d().textContent).toContain("~/b");
    expect(d().querySelector("[data-check]")!.getAttribute("data-check")).toBe("same");
    relay.handlers["points.raise"] = () => undefined;
    await t.click(t.btn(d(), "Поднять на laptop"));
    expect(d().querySelector('[role="status"]')!.textContent).toBe("laptop поднимает сессию из точки…");
    expect(t.btn(d(), "Поднять на laptop")!.disabled).toBe(true);
    relay.reply(String(relay.sent("points.raise").at(-1)!.id), { ok: true, result: { callsign: "old-bot@laptop" } });
    await flush(10);
    expect(t.btn(d(), "Поднять на laptop")).toBeNull();
    await t.click(t.btn(d(), "Закрыть"));
    expect(t.$('[data-dlg="raise"]')).toBeNull();

    const none = oneOnly();
    none.roster.machines.forEach((m) => void delete m.contract!["points.raise"]);
    const n = await points(none);
    expect(n.btn(n.$('[data-sid="old"]'), "Перенести на машину…")).toBeNull();
  });

  it("окно подъёма: выбор слота уходит в запрос; отмена закрывает", async () => {
    const relay = oneOnly();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", order: ["a"], wait: null, sessions: [] }, bot: { account: "b", order: ["b"], wait: null, sessions: [] } } } });
    const t = await points(relay);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    await t.click(t.$('[data-dlg="raise"] [data-slot="bot"]'));
    await t.click(t.btn(t.$('[data-dlg="raise"]'), "Поднять на laptop"));
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ slot: "bot" });
    await flush(10);
    await t.click(t.btn(t.$('[data-sid="old"]'), "Перенести на машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="raise"]'), "Отмена"));
    expect(t.$('[data-dlg="raise"]')).toBeNull();
  });
});

describe("видимое: «пожар»", () => {
  it("плашка, сводка и окно: подписи и счёт; нет ухода в журнале — без времени", async () => {
    const relay = fireRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [], more: false } });
    const t = await points(relay);
    expect(t.$('[data-fire="mac"] b')!.textContent).toBe("mac не на связи · 2 сессии ждут на последних точках");
    expect(t.$('[data-fire="mac"]')!.textContent).toContain("Что mac допишет после точек, вернётся веткой, если он появится.");
    expect(t.$("[data-summary]")!.textContent).toContain("· 2 на mac — нет связи");
    relay.handlers["points.raise"] = () => undefined;
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(5);
    const d = t.$('[data-dlg="fire"]')!;
    expect(d.querySelector("h4")!.textContent).toBe("Перенести сессии mac на другую машину");
    expect(d.textContent).toContain("Куда");
    expect(d.textContent).toContain("проверяю папку…");
    expect(d.querySelector('[data-row="one"]')!.textContent).toMatch(/^oneточка \d\d:\d\d · №5~\/p1/);
    expect(d.textContent).toContain("Каждая поднимется из своей последней точки, по одной, пока страница открыта. Закроете — оставшиеся ждут на точках, плашка останется.");
    await t.click(t.btn(d, "Отмена"));
    expect(t.$('[data-dlg="fire"]')).toBeNull();
  });

  it("окно: слот и проверка папки строкой; слово отказа пробы; конец переноса — зелёная карточка без «не закрывайте»", async () => {
    const relay = fireRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", order: ["a"], wait: null, sessions: [] }, bot: { account: "b", order: ["b"], wait: null, sessions: [] } } } });
    const t = await points(relay);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    const d = () => t.$('[data-dlg="fire"]')!;
    expect(d().textContent).toContain("Слот на laptop");
    expect(d().querySelector('[data-row="one"]')!.textContent).toContain("тот же репозиторий, своих правок нет — правки точки применятся");
    await t.click(d().querySelector('[data-slot="bot"]'));
    await t.click(t.btn(d(), "Перенести 2 из 2 на laptop"));
    await flush(10);
    expect(relay.sent("points.raise").filter((f) => !f.dryRun).map((f) => f.slot)).toEqual(["bot", "bot"]);
    const pr = d().querySelector<HTMLElement>("[data-progress]")!;
    expect(pr.dataset.progress).toBe("2/2");
    expect(pr.textContent).toBe("Перенос с mac на laptop: 2 из 2 готовы");

    const bad = fireRelay();
    bad.handlers["points.raise"] = (f) => (f.dryRun ? (f.sid === "s1" ? { ok: false, error: "waiting" } : { ok: true, result: { folder: "same" } }) : { ok: true, result: { callsign: "x" } });
    const b = await points(bad);
    await b.click(b.btn(null, "Перенести на другую машину…"));
    await flush(10);
    expect(b.$('[data-row="one"]')!.textContent).toContain("Сессия ждёт ответа человека — после ответа или с «прервать»");
    expect(b.btn(b.$('[data-dlg="fire"]'), /^Перенести 2 из 2/)!.disabled).toBe(true);
  });

  it("одна сессия ждёт, пять сессий ждут: числа словами", async () => {
    const list = (n: number) => {
      const relay = fireRelay();
      relay.handlers["points.list"] = () => ({ ok: true, result: { sessions: Array.from({ length: n }, (_, i) => ({ sid: `s${i}`, callsign: `n${i}@mac`, owner: "mac", head: { id: i + 1, at: at(9, 0) }, points: 1, branches: 0 })), r2: { bytes: 0, blocks: 0 }, sweep: null } });
      return relay;
    };
    const one = await points(list(1));
    expect(one.$('[data-fire="mac"] b')!.textContent).toContain("1 сессия ждёт на последних точках");
    const five = await points(list(5));
    expect(five.$('[data-fire="mac"] b')!.textContent).toContain("5 сессий ждут на последних точках");
  });

  it("перенос: нет машин с подъёмом — кнопки нет; отказ подъёма — слово строки", async () => {
    const none = fireRelay((r) => r.machines.forEach((m) => void delete m.contract!["points.raise"]));
    const n = await points(none);
    expect(n.btn(null, "Перенести на другую машину…")).toBeNull();
    const relay = fireRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: false, error: "name_taken" });
    const t = await points(relay);
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="fire"]'), /^Перенести 2 из 2/));
    await flush(10);
    expect(t.$('[data-row="one"]')!.textContent).toContain("не поднялась: Имя занято на этой машине");
    expect(t.btn(t.$('[data-dlg="fire"]'), "Закрыть")).not.toBeNull();
  });
});

describe("видимое: слова", () => {
  it.each([
    ["waiting", "site ждёт ответа человека — после ответа или с «прервать»"],
    ["bad_dir", "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»"],
    ["bad_point", "Точка не открылась — причина в журнале машины"],
    ["not_owner", "Сессию уже подняли на другой машине"],
    ["open_failed", "Не поднялась на pc — снова идёт на laptop"],
    ["not_r2", "Сессия не в R2"],
    ["running", "Сессия ещё идёт — сначала точка со стопом"],
    ["name_taken", "Имя занято на этой машине"],
    ["slot_required", "Выберите слот"],
    ["no_slot", "Такого слота нет на pc"],
    ["not_logged_in", "В слоте нет вошедшего аккаунта"],
    ["zzz", "zzz"],
    ["offline", "Машина не на связи"],
  ])("слово отказа %s в окне переноса — %s", async (word, text) => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: false, error: word });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    await t.click(t.$('[data-act="run"]'));
    expect(t.$('[data-dlg="move"] [data-phase="err"]')!.textContent).toBe(text);
  });

  it.each([
    [{ folder: "same" }, "same", "тот же репозиторий, своих правок нет — правки точки применятся", "ok"],
    [{ folder: "dirty", files: 1 }, "dirty", "тот же репозиторий, но в нём свои правки (1 файл): правки точки НЕ применятся, ваши файлы останутся", "wait"],
    [{ folder: "dirty", files: 3 }, "dirty", "тот же репозиторий, но в нём свои правки (3 файла): правки точки НЕ применятся, ваши файлы останутся", "wait"],
    [{ folder: "dirty" }, "dirty", "тот же репозиторий, но в нём свои правки (? файлов): правки точки НЕ применятся, ваши файлы останутся", "wait"],
    [{ folder: "empty" }, "empty", "нет на pc — будет клон репозитория и правки точки поверх", "ok"],
    [{ folder: "shared", sessions: ["a@pc", "b@pc"] }, "shared", "здесь же a@pc, b@pc — в этой папке будут 3 сессии", "ok"],
    [{ folder: "nogit" }, "nogit", "в точке нет git — файлы останутся как есть", "ok"],
    [{ folder: "other" }, "other", "Другой репозиторий — выберите другую папку", "bad"],
    [{ folder: "новое" }, "новое", "новое", "ok"],
  ])("проверка папки %j — %s: текст и тон", async (answer, key, text, tone) => {
    const relay = pointsRelay();
    relay.handlers["points.raise"] = () => ({ ok: true, result: answer });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    const c = t.$('[data-dlg="move"] [data-check]')!;
    expect(c.getAttribute("data-check")).toBe(key);
    expect(c.textContent).toBe(text);
    expect(c.className).toContain(tone);
    expect(t.$<HTMLButtonElement>('[data-act="run"]')!.disabled).toBe(key === "other");
  });
});

describe("видимое: вкладка «Точки»", () => {
  it("не в R2: подписи; пока идёт — «Включаю…»; после отказа машины без session.r2 галочки нет", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = () => undefined;
    const t = await sessionTab(relay, "wiki@laptop");
    const off = t.$('[data-r2="off"]')!;
    expect(off.textContent).toContain("Точек нет: перенос, копия, откат, смена папки и «пожар» — только у сессий в R2.");
    expect(off.textContent).toContain("Хранить в R2");
    expect(off.textContent).toContain("Включите — Host сразу положит первую точку.");
    t.$<HTMLInputElement>('[data-act="r2"]')!.click();
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Включаю…");
    relay.reply(String(relay.sent("session.r2")[0].id), { ok: true, result: { point: 7 } });
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Первая точка — №7, только что; дальше Host кладёт их сам.");
  });

  it("в R2: шапка с размером, подпись, кнопки по умениям машины; нет головы — кнопки выключены; «Точек ещё нет»", async () => {
    const relay = pointsRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => {
      const a = list(f) as { ok: true; result: { points?: Array<{ id: number; bytes?: number }> } };
      if (f.sid) a.result.points![0].bytes = 1572864;
      return a;
    };
    const t = await sessionTab(relay);
    const on = t.$('[data-r2="on"]')!;
    expect(on.querySelector(".sb-ph b")!.textContent).toMatch(/^Точка .+ · №41 · 1,5 МБ$/);
    expect(on.textContent).toContain("сохраняются сами: в разговоре новое и ответ кончился — Host кладёт точку сам");
    for (const b of ["Сохранить точку", "Перенести…", "Скопировать…", "Сменить папку…"]) expect(t.btn(on, b)!.disabled).toBe(false);
    expect(t.$("[data-points] h4")!.textContent).toBe("Линия и ветки");

    const fresh = pointsRelay();
    fresh.handlers["points.list"] = () => ({ ok: true, result: { sessions: [], r2: { bytes: 0, blocks: 0 }, sweep: null } });
    const n = await sessionTab(fresh);
    expect(n.$('[data-r2="on"] .sb-ph b')!.textContent).toBe("Точек ещё нет");
    for (const b of ["Перенести…", "Скопировать…", "Сменить папку…"]) expect(n.btn(n.$('[data-r2="on"]'), b)!.disabled).toBe(true);

    const strip = pointsRelay((r) => {
      for (const m of r.machines) m.contract = Object.fromEntries(Object.entries(HOST).filter(([k]) => !["points.save", "points.raise"].includes(k)));
    });
    const s = await sessionTab(strip);
    for (const b of ["Сохранить точку", "Перенести…", "Скопировать…", "Сменить папку…"]) expect(s.btn(s.$('[data-r2="on"]'), b)).toBeNull();
    await s.click(s.$('[data-point="38"]'));
    expect(s.btn(s.$('[data-card="38"]'), "Скопировать из этой точки…")).toBeNull();
    expect(s.btn(s.$('[data-card="38"]'), "Откатить к этой точке…")).toBeNull();
  });

  it("«Сохранить точку»: ход «Сохраняю точку…», итог «Точка №N»", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => undefined;
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Сохранить точку"));
    expect(t.$("[data-note]")!.textContent).toBe("Сохраняю точку…");
    relay.reply(String(relay.sent("points.save")[0].id), { ok: true, result: { point: 42, same: false } });
    await flush(5);
    expect(t.$("[data-note]")!.textContent).toBe("Точка №42");
  });

  it("линия: дни подписаны, ветка в своём классе, первые слова или повод, нажатие раскрывает и сворачивает карточку", async () => {
    const relay = pointsRelay();
    relay.handlers["points.get"] = (f) => ({ ok: true, result: { owner: "laptop", points: (f.ids as number[]).map((id) => ({ id, ...(id === 41 ? { last: [["первое", "ответ"], ["второе", ""]] } : {}) })) } });
    const t = await sessionTab(relay);
    expect(t.$$(".pt-day")).toHaveLength(1);
    const row = t.$('[data-point="33"]')!;
    expect(row.className).toContain("pt-pt br");
    expect(t.$('[data-point="41"]')!.className).not.toContain(" br");
    expect(row.querySelector("em")!.textContent).toBe("ветка · №33");
    expect(t.$('[data-point="41"] em')!.textContent).toBe("№41");
    expect(t.$('[data-point="38"] span:nth-of-type(2)')!.textContent).toBe("rule");
    expect(t.$('[data-point="41"] span:nth-of-type(2)')!.textContent).toBe("«первое»");
    expect(t.$('[data-point="41"]')!.getAttribute("aria-pressed")).toBe("false");
    await t.click(t.$('[data-point="41"]'));
    expect(t.$('[data-point="41"]')!.getAttribute("aria-pressed")).toBe("true");
    const c = t.$('[data-card="41"]')!;
    expect(c.textContent).toContain("· №41 · последняя");
    expect(c.textContent).toContain("почемуrule");
    expect(c.textContent).toContain("разговор212 сообщений");
    expect(c.textContent).toContain("с машиныlaptop");
    expect(c.textContent).toContain("папкаgit: 2 файла не закоммичено · main");
    expect(c.textContent).toContain("срокхранится, пока есть сессия");
    expect(c.textContent).toContain("первое → ответ · второе → ");
    expect(t.btn(c, "Откатить к этой точке…")).toBeNull();
    await t.click(t.$('[data-point="38"]'));
    const c2 = t.$('[data-card="38"]')!;
    expect(t.$('[data-card="41"]')).toBeNull();
    expect(c2.textContent).toContain("папкаgit: чисто · main");
    expect(c2.textContent).toMatch(/срокхранится до .+ 2027/);
    await t.click(t.$('[data-point="38"]'));
    expect(t.$('[data-card="38"]')).toBeNull();
  });

  it("снятие пометки: подписи, ход «Удаляю точки…», отмена; отказ — слово и окно остаётся", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = () => undefined;
    const t = await sessionTab(relay);
    const box = () => t.$('[data-r2="on"] ~ .sb-sec [data-act="r2"]')!;
    expect(box().parentElement!.parentElement!.textContent).toContain("Снять — точки сессии удалятся из R2 сразу, без отмены.");
    await t.click(box());
    const d = t.$('[data-dlg="unmark"]')!;
    expect(d.querySelector("b")!.textContent).toBe("Убрать site@laptop из R2");
    expect(d.textContent).toContain("Точки и ветки сессии удалятся из R2 сразу; отменить нельзя. Сессия на laptop продолжит работу — без точек и переноса.");
    expect(d.textContent).toContain("Введите имя сессии: site");
    expect(t.$('[data-act="unmark"]')!.textContent).toBe("Убрать из R2");
    await t.click(t.btn(d, "Отмена"));
    expect(t.$('[data-dlg="unmark"]')).toBeNull();
    await t.click(box());
    await t.type(t.$('[data-f="unmark"]'), "site");
    await t.click(t.$('[data-act="unmark"]'));
    expect(t.$("[data-note]")!.textContent).toBe("Удаляю точки…");
    relay.reply(String(relay.sent("session.r2")[0].id), { ok: false, error: "not_owner" });
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Сессию уже подняли на другой машине");
    expect(t.$('[data-dlg="unmark"]')).not.toBeNull();
  });

  it("снятие: одна точка удалена, две удалено — числа словами, сессия работает дальше", async () => {
    for (const [n, word] of [[1, "1 точка удалена"], [2, "2 точки удалено"]] as const) {
      const relay = pointsRelay();
      relay.handlers["session.r2"] = () => ({ ok: true, result: { deleted: n } });
      const t = await sessionTab(relay);
      await t.click(t.$('[data-r2="on"] ~ .sb-sec [data-act="r2"]'));
      await t.type(t.$('[data-f="unmark"]'), "site");
      await t.click(t.$('[data-act="unmark"]'));
      expect(t.$("[data-note]")!.textContent).toBe(`${word} из R2 — сразу, без отмены. Сессия на laptop работает дальше, без точек.`);
    }
  });
});

describe("видимое: окна точки", () => {
  const dialogs = () => {
    const relay = pointsRelay();
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: `${f.name ?? "site"}@${f.machine}`, point: f.point, folder: "same", branch: null } });
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    relay.handlers["session.remove"] = () => ({ ok: true });
    return relay;
  };

  it("перенос: заголовок, машины, откуда, папка, предупреждение; кнопка несёт цель; выбор машины и «сейчас»", async () => {
    const relay = dialogs();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", order: ["a"], wait: null, sessions: [] }, bot: { account: "b", order: ["b"], wait: null, sessions: [] } } } });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    const d = t.$('[data-dlg="move"]')!;
    expect(d.querySelector("h4")!.textContent).toBe("Перенести site@laptop");
    expect(d.textContent).toContain("Машина");
    expect(t.btn(d, "pc")!.getAttribute("aria-pressed")).toBe("true");
    expect(t.btn(d, "laptop")!.getAttribute("aria-pressed")).toBe("false");
    expect(d.textContent).toContain("Из точки");
    expect(t.btn(d, "сейчас — сохранится свежая")!.getAttribute("aria-pressed")).toBe("true");
    expect(d.textContent).toContain("Папка на pc");
    expect(d.textContent).toContain("Слот на pc");
    expect(d.textContent).toContain("Сначала laptop остановит сессию и снимет точку, потом pc поднимет её. Сорвётся подъём — сессия снова пойдёт на laptop.");
    expect(d.textContent).toContain("прервать ответ и сделать сразу");
    expect(d.querySelector('[data-act="run"]')!.textContent).toBe("Перенести на pc");
    await t.click(t.btn(d, "laptop"));
    await flush(10);
    expect(t.$('[data-dlg="move"] [data-act="run"]')!.textContent).toBe("Перенести на laptop");
    expect(t.$('[data-dlg="move"]')!.textContent).toContain("Папка на laptop");
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "laptop" });
    await t.click(t.btn(t.$('[data-dlg="move"]'), "Отмена"));
    expect(t.$('[data-dlg="move"]')).toBeNull();
  });

  it("перенос: ход по шагам и итог; «Закрыть»; линия перечитана", async () => {
    const relay = dialogs();
    relay.handlers["points.save"] = () => undefined;
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    await t.click(t.$('[data-act="run"]'));
    const ph = () => t.$('[data-dlg="move"] [data-phase]')!;
    expect(ph().textContent).toBe("laptop дожидается конца ответа, останавливает сессию и кладёт точку…");
    expect(t.$<HTMLButtonElement>('[data-act="run"]')!.disabled).toBe(true);
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : undefined);
    relay.reply(String(relay.sent("points.save")[0].id), { ok: true, result: { point: 42, same: false } });
    await flush(5);
    expect(ph().textContent).toBe("pc поднимает сессию из точки №42…");
    const lists = relay.sent("points.list").length;
    relay.reply(String(relay.sent("points.raise").at(-1)!.id), { ok: true, result: { callsign: "site@pc", point: 43, folder: "same", branch: null } });
    await flush(10);
    expect(ph().textContent).toBe("site перенесена на pc: site@pc. laptop её отпустил.");
    expect(relay.sent("points.list").length).toBeGreaterThan(lists);
    expect(t.$('[data-act="run"]')).toBeNull();
    await t.click(t.btn(t.$('[data-dlg="move"]'), "Закрыть"));
    expect(t.$('[data-dlg="move"]')).toBeNull();
  });

  it("копия: заголовок, имя и предупреждение; ход «кладёт свежую точку»; копия не несёт стопа; подъём встаёт в проект", async () => {
    const relay = dialogs();
    relay.handlers["points.save"] = () => undefined;
    relay.scoped.global = { "fleet.projects": [{ id: "work", name: "Работа", sessions: ["site@laptop"] }] };
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Скопировать…"));
    await flush(10);
    const d = t.$('[data-dlg="copy"]')!;
    expect(d.querySelector("h4")!.textContent).toBe("Скопировать site@laptop");
    expect(d.textContent).toContain("Имя копии");
    expect(d.textContent).toContain("→ site-copy@pc");
    expect(d.textContent).toContain("Исходная сессия не меняется. У копии своё имя и своя сессия в claude.ai.");
    expect(d.textContent).not.toContain("прервать ответ");
    expect(d.querySelector('[data-act="run"]')!.textContent).toBe("Скопировать на pc");
    await t.type(d.querySelector('[data-f="name"]'), "my");
    expect(t.$('[data-dlg="copy"]')!.textContent).toContain("→ my@pc");
    await t.click(t.$('[data-act="run"]'));
    expect(t.$('[data-dlg="copy"] [data-phase]')!.textContent).toBe("laptop кладёт свежую точку…");
    relay.reply(String(relay.sent("points.save")[0].id), { ok: true, result: { point: 42, same: false } });
    await flush(10);
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ name: "my", copy: true, point: 42 });
    expect(relay.scoped.global["fleet.projects"]).toEqual([{ id: "work", name: "Работа", sessions: ["site@laptop", "my@pc"] }]);
  });

  it("копия из точки: кнопка номера выбрана; «сейчас» переключает на свежую и проверяет заново", async () => {
    const relay = dialogs();
    const t = await sessionTab(relay);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.btn(t.$('[data-card="38"]'), "Скопировать из этой точки…"));
    await flush(10);
    const d = () => t.$('[data-dlg="copy"]')!;
    expect(t.btn(d(), "№38")!.getAttribute("aria-pressed")).toBe("true");
    expect(t.btn(d(), "сейчас — сохранится свежая")!.getAttribute("aria-pressed")).toBe("false");
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ dryRun: true, point: 38 });
    await t.click(t.btn(d(), "сейчас — сохранится свежая"));
    await flush(5);
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ dryRun: true, point: 41 });
    expect(t.btn(d(), "№38")).toBeNull();
  });

  it("смена папки: подписи окна, та же машина, ход «Забыть», итог; отказ «Забыть» — слово", async () => {
    const relay = dialogs();
    const t = await sessionTab(relay);
    await t.click(t.$('[data-act="dir"]'));
    const d = t.$('[data-dlg="dir"]')!;
    expect(d.querySelector("h4")!.textContent).toBe("Сменить папку site@laptop");
    expect(d.textContent).toContain("laptop — та же");
    expect(d.textContent).toContain("Новая папка");
    expect(d.textContent).toContain("Имя");
    expect(d.textContent).toContain("папка — как есть: правки точки не применяются. Папку живой сессии не меняют: claude держит её с запуска. Не поднялась копия — «Забыть» не шлётся.");
    expect(d.querySelector('[data-act="run"]')!.textContent).toBe("Скопировать и забыть");
    expect(relay.sent("points.raise").filter((f) => f.dryRun)).toHaveLength(0);
    relay.handlers["session.remove"] = () => undefined;
    await t.click(t.$('[data-act="run"]'));
    await flush(5);
    expect(t.$('[data-dlg="dir"] [data-phase]')!.textContent).toBe("«Забыть» site@laptop…");
    relay.reply(String(relay.sent("session.remove")[0].id), { ok: true });
    await flush(10);
    expect(t.$('[data-dlg="dir"] [data-phase]')!.textContent).toBe("Копия в новой папке: site-v2@laptop; site@laptop забыта, её точки остались в R2.");

    const bad = dialogs();
    bad.handlers["session.remove"] = () => ({ ok: false, error: "offline" });
    const b = await sessionTab(bad);
    await b.click(b.$('[data-act="dir"]'));
    await b.click(b.$('[data-act="run"]'));
    await flush(5);
    expect(b.$('[data-dlg="dir"] [data-phase="err"]')!.textContent).toBe("Машина не на связи");
  });

  it("откат: подписи, папка как есть или папка точки, предупреждение; итог с веткой git; без claude.ai нет плашки", async () => {
    const relay = dialogs();
    relay.handlers["points.raise"] = () => ({ ok: true, result: { callsign: "site@laptop", point: 43, folder: "same", branch: "points-2026-10-31-1453" } });
    const t = await sessionTab(relay);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.$('[data-card="38"] [data-act="rb"]'));
    const d = t.$('[data-dlg="rb"]')!;
    expect(d.querySelector("h4")!.textContent).toBe("Откатить site@laptop к точке №38");
    expect(d.textContent).toContain("laptop — та же");
    expect(d.textContent).toContain("~/Projects/site");
    expect(t.btn(d, "Оставить как есть")!.getAttribute("aria-pressed")).toBe("true");
    expect(t.btn(d, "Вернуть к папке точки")!.getAttribute("aria-pressed")).toBe("false");
    expect(d.textContent).toContain("Нынешнее сначала сохранится веткой «до отката» — из неё можно скопировать или продолжить ею.");
    expect(d.textContent).toContain("прервать идущий ответ и откатить сразу (иначе — после конца ответа)");
    expect(d.querySelector("[data-remote]")!.textContent).toContain("После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была.");
    expect(d.querySelector('[data-act="run"]')!.textContent).toBe("Откатить к №38");
    await t.click(t.btn(d, "Вернуть к папке точки"));
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ machine: "laptop", point: 38, files: "point" });
    expect(t.$('[data-dlg="rb"] [data-phase]')!.textContent).toBe("Откат: site@laptop поднята из точки №38; нынешнее — веткой «до отката», папка на ветке git points-2026-10-31-1453. Новая ссылка claude.ai придёт в roster.");

    const plain = dialogs();
    const r = pointsRelay((x) => {
      delete x.sessions[2].remote;
    });
    r.handlers["points.raise"] = plain.handlers["points.raise"];
    const p = await sessionTab(r);
    await p.click(p.$('[data-point="38"]'));
    await p.click(p.$('[data-card="38"] [data-act="rb"]'));
    expect(p.$('[data-dlg="rb"] [data-remote]')).toBeNull();
  });

  it("откат без ветки git: итог без неё", async () => {
    const relay = dialogs();
    const t = await sessionTab(relay);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.$('[data-card="38"] [data-act="rb"]'));
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(t.$('[data-dlg="rb"] [data-phase]')!.textContent).toBe("Откат: site@laptop поднята из точки №38; нынешнее — веткой «до отката». Новая ссылка claude.ai придёт в роster.".replace("роster", "roster"));
  });
});

describe("стили экрана точек", () => {
  it("строки обзора и линии — якоря стилей pt-*", async () => {
    const t = await points(oneOnly());
    expect(t.$('[data-only] [data-sid="old"]')!.className).toBe("pt-row");
    const s = await sessionTab();
    expect(s.$$(".pt-day").length).toBeGreaterThan(0);
    expect(s.$$(".pt-pt").length).toBe(3);
    expect(s.$$(".pt-pt i").length).toBe(3);
  });
});

describe("видимое: остатки", () => {
  it("раздел «Точки» в группе «Флот»; строка «поднимается…» на время подъёма; список машин подписан", async () => {
    const relay = fireRelay((r) => {
      const c = r.machines[0].contract;
      for (const m of ["b1", "b2", "b3", "b4", "b5", "b6"]) r.machines.push({ machine: m, since: 1, proto: 1, contract: { ...c } });
    });
    const t = await points(relay);
    expect(t.$(".sb-navcol")!.textContent).toContain("Флот");
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    expect(t.$<HTMLSelectElement>('[data-dlg="fire"] select[data-f="target"]')!.getAttribute("aria-label")).toBe("Другая машина");
    relay.handlers["points.raise"] = () => undefined;
    await t.click(t.btn(t.$('[data-dlg="fire"]'), /^Перенести 2 из 2/));
    expect(t.$('[data-row="one"]')!.textContent).toContain("поднимается…");
  });

  it("карточка точки: «когда», одно и два сообщения", async () => {
    for (const [msgs, word] of [[1, "1 сообщение"], [2, "2 сообщения"]] as const) {
      const relay = pointsRelay();
      const list = relay.handlers["points.list"];
      relay.handlers["points.list"] = (f) => {
        const a = list(f) as { ok: true; result: { points?: Array<{ msgs?: number }> } };
        if (f.sid) a.result.points![0].msgs = msgs;
        return a;
      };
      const t = await sessionTab(relay);
      await t.click(t.$('[data-point="41"]'));
      expect(t.$('[data-card="41"]')!.textContent).toContain("когда");
      expect(t.$('[data-card="41"]')!.textContent).toContain(`разговор${word}`);
    }
  });

  it("смена папки: копия не поднялась — сессия остаётся остановленной, «Забыть» не отправлен", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    relay.handlers["points.raise"] = () => ({ ok: false, error: "open_failed" });
    const t = await sessionTab(relay);
    await t.click(t.$('[data-act="dir"]'));
    await t.click(t.$('[data-act="run"]'));
    await flush(5);
    expect(t.$('[data-dlg="dir"] [data-phase="err"]')!.textContent).toBe("Копия не поднялась — «Забыть» не отправлен, site@laptop остаётся остановленной");
  });
});

describe("спорные места", () => {
  it.each([[1, "1 файл не закоммичен"], [5, "5 файлов не закоммичено"]])("карточка точки: %i правок — число склоняется", async (files, text) => {
    const relay = pointsRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => {
      const a = list(f) as { ok: true; result: { points?: Array<{ git?: { files?: number } }> } };
      if (f.sid) a.result.points![0].git!.files = files;
      return a;
    };
    const t = await sessionTab(relay);
    await t.click(t.$('[data-point="41"]'));
    expect(t.$('[data-card="41"]')!.textContent).toContain(`папкаgit: ${text} · main`);
  });
  it("«Хранить в R2» у сессии без хода: машина ответила без номера — первая точка на первом конце хода", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = () => ({ ok: true, result: { point: null } });
    const t = await sessionTab(relay, "wiki@laptop");
    t.$<HTMLInputElement>('[data-act="r2"]')!.click();
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Первая точка — на первом конце хода.");
  });
});
