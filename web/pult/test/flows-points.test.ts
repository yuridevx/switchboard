// Флоу пульта по плану цикла тестов (web): новая сессия, вкладка «Точки», обзор точек, «пожар», перенос, диалоги точек.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { createCard } from "@switchboard/web-card";
import { defined } from "../../packages/core/stand/app.ts";
import { pultParts } from "../stand/parts.ts";
import { fleetRelay, fleetRoster, flush, HOST, pointsRelay, pult, SID, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
const at = (hh: number, mm: number) => Date.UTC(2026, 9, 31, hh, mm);

/** Флот с папками сессий: проект site — site@laptop (профиль ops) в ~/Projects/site и wiki@laptop в ~/projects/site. */
function projRoster(): Roster {
  const r = fleetRoster();
  for (const s of r.sessions) s.dir = `~/Projects/${s.callsign.split("@")[0]}`;
  // тот же проект — другая папка на той же машине
  r.sessions.find((s) => s.callsign === "wiki@laptop")!.dir = "~/projects/site";
  return r;
}

/** Ответы владельцев для экрана новой сессии. */
function openRelay(r = projRoster()) {
  const relay = fleetRelay(r);
  relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: { main: { account: "infirex", wait: null, sessions: f.machine === "laptop" ? ["site@laptop"] : [] }, night: { account: "work3", wait: 1793666400, sessions: [] } } } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high" }, "team/profiles/writer": { model: "haiku", effort: "low" } }, repos: {} } });
  relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["api", ".git", "site"] } });
  relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
  relay.handlers["session.r2"] = () => ({ ok: true, result: { point: 1 } });
  relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u1" } });
  return relay;
}

async function openScreen(relay = openRelay(), url = "/#open?machine=laptop&dir=~%2FProjects%2Fsite") {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
}

describe("новая сессия", () => {
  // источник: дизайн «Новая сессия как проводник»; слово пользователя 3 нояб.: «Имя нужно в верху без имени по умолчанию. Папки проект разные вещи», «писать несуществующий путь который авто создастся»
  const addr = (t: Awaited<ReturnType<typeof openScreen>>) => t.$<HTMLInputElement>('[data-f="addr"]')!;
  const go = async (t: Awaited<ReturnType<typeof openScreen>>, v: string) => {
    await t.type(addr(t), v);
    await flush(5);
  };
  const named = async (t: Awaited<ReturnType<typeof openScreen>>, v: string) => t.type(t.$('[data-f="name"]'), v);

  it("6501 · открыт экран: имя — первое поле, пустое и в фокусе; вкладок и раздела мест нет; адрес и машина из параметров", async () => {
    const t = await openScreen();
    const name = t.$<HTMLInputElement>('[data-f="name"]')!;
    expect(name.value).toBe("");
    expect(document.activeElement).toBe(name);
    expect(name.compareDocumentPosition(addr(t)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(t.$('[role="tablist"][aria-label="Где"]')).toBeNull();
    expect(t.$(".op-plc")).toBeNull();
    expect(addr(t).value).toBe("~/Projects/site");
    expect(t.$('.op-bl [data-machine="laptop"]')!.getAttribute("aria-selected")).toBe("true");
    expect(t.$$('[data-f="q"], [data-f="dq"], [data-f="mq"], [data-f="path"]')).toHaveLength(0);
  });

  it("6502 · папка с именем профиля и без сессий: имя пустое, «без профиля» — имя папки ничего не значит", async () => {
    const relay = openRelay();
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/reviewer": { model: "opus" } }, repos: {} } });
    const t = await openScreen(relay, "/#open?machine=laptop&dir=~%2Freviewer");
    expect(t.$<HTMLInputElement>('[data-f="name"]')!.value).toBe("");
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("без профиля");
  });

  it("6503 · профиль подхватывается только от сессии в этой же папке", async () => {
    const r = projRoster();
    r.sessions.find((s) => s.callsign === "site@laptop")!.profile = { id: "team/profiles/ops", state: "ok" };
    const t = await openScreen(openRelay(r));
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("ops");
    await go(t, "~/Projects/other");
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("без профиля");
  });

  it("6520 · профиль, выбранный вручную, переживает правку адреса", async () => {
    // источник: слепой архитектор 4 нояб.: поле profileSet в форме нигде не ставилось, адрес сбрасывал выбор человека
    const t = await openScreen();
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("ops");
    await go(t, "~/Projects/other");
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("ops");
  });

  it("6504 · «Открыть» без имени: «нужно имя» у поля; 0 запросов к машине; кнопка не отключена", async () => {
    const relay = openRelay();
    const t = await openScreen(relay);
    const b = t.$<HTMLButtonElement>('[data-act="open"]')!;
    expect(b.disabled).toBe(false);
    await t.click(b);
    expect(t.$('[data-err="name"]')!.textContent).toBe("нужно имя");
    expect(relay.sent("session.open")).toHaveLength(0);
  });

  it("6505 · адрес существующей папки: один запрос с просьбой создать, сессия в этой папке; затем карточка", async () => {
    const relay = openRelay();
    const t = await openScreen(relay, "/#open?machine=laptop&dir=~");
    await go(t, "~/site/");
    await named(t, "a");
    await t.click(t.$('[data-act="open"]'));
    expect(relay.sent("session.open")).toEqual([expect.objectContaining({ machine: "laptop", name: "a", dir: "~/site", mkdir: true })]);
    expect(relay.sent("machine.mkdir")).toHaveLength(0);
    expect(location.hash).toBe("#card?callsign=a%40laptop");
  });

  it("6506 · новый путь ~/new/deep/path: кнопка «Создать и открыть», пометка; один запрос", async () => {
    const relay = openRelay();
    relay.handlers["machine.dirs"] = (f) => (String(f.path).startsWith("~/new") ? { ok: false, error: "not_found" } : { ok: true, result: { path: f.path, dirs: [] } });
    const t = await openScreen(relay, "/#open?machine=laptop&dir=~");
    expect(t.$('[data-act="open"]')!.textContent).toBe("Открыть");
    await go(t, "~/new/deep/path");
    expect(t.$('[data-act="open"]')!.textContent).toBe("Создать и открыть");
    await named(t, "a");
    await t.click(t.$('[data-act="open"]'));
    expect(relay.sent("session.open")).toEqual([expect.objectContaining({ dir: "~/new/deep/path", mkdir: true })]);
  });

  it("6507 · отказы машины: имя занято и неверное — у имени; папка — на экране; следующее открытие работает; задача остаётся", async () => {
    const relay = openRelay();
    const t = await openScreen(relay);
    await named(t, "site");
    await t.type(t.$('[data-f="text"]'), "задача");
    for (const [word, at, text] of [["name_taken", '[data-err="name"]', "на laptop уже есть site"], ["bad_name", '[data-err="name"]', "латиница, цифры, точка, - и _"], ["bad_dir", ".op-err", "session.open: bad_dir"]] as const) {
      relay.handlers["session.open"] = () => ({ ok: false, error: word });
      await t.click(t.$('[data-act="open"]'));
      expect(t.$(at)!.textContent).toBe(text);
      expect(t.$('[data-screen="open"]')).not.toBeNull();
      await named(t, "site");
    }
    expect(t.$<HTMLTextAreaElement>('[data-f="text"]')!.value).toBe("задача");
    relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
    await t.click(t.$('[data-act="open"]'));
    expect(location.hash).toBe("#card?callsign=site%40laptop");
  });

  it("6508 · набор по буквам: один запрос списка на одного родителя; хвост фильтрует; Tab дополняет; скрытые видны с точки", async () => {
    const relay = openRelay();
    const t = await openScreen(relay, "/#open?machine=laptop&dir=~");
    const n = relay.sent("machine.dirs").length;
    await go(t, "~/s");
    await go(t, "~/si");
    expect(relay.sent("machine.dirs").length - n).toBe(0);
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual(["site"]);
    await go(t, "~/.");
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual([".git"]);
    await go(t, "~/s");
    addr(t).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await flush(5);
    expect(addr(t).value).toBe("~/site/");
    expect(relay.sent("machine.dirs").at(-1)).toMatchObject({ path: "~/site" });
  });

  it("6509 · 7 открытий, одно повторно: 5 мест без повторов, новое первым; у второго устройства те же; места ушедшей машины не видны", async () => {
    const relay = openRelay();
    for (const d of ["a", "b", "c", "d", "e", "f", "a"]) {
      const t = await openScreen(relay, `/#open?machine=laptop&dir=~%2F${d}`);
      await named(t, `n${d}${Math.random().toString(36).slice(2, 6)}`);
      await t.click(t.$('[data-act="open"]'));
      await flush(5);
    }
    expect(relay.values["pult-open.recent"]).toEqual(["a", "f", "e", "d", "c"].map((d) => ({ m: "laptop", dir: `~/${d}` })));
    const two = await openScreen(relay, "/#open");
    expect(addr(two).value).toBe("~/a");
    expect(two.$$("[data-place]").map((x) => x.dataset.place)).toEqual(["~", "~/a", "~/f", "~/e", "~/d", "~/c"]);
    relay.values["pult-open.recent"] = [{ m: "gone", dir: "~/x" }];
    const three = await openScreen(relay, "/#open");
    expect(three.$('[data-place="~/x"]')).toBeNull();
    expect(addr(three).value).toBe("~");
  });

  it("6510 · уход со страницы посреди записи места: остановка ждёт записи, место сохранено", async () => {
    const relay = openRelay();
    // карточка после открытия спрашивает многое: остановка ждёт и этих ответов, отказ словом экраны принимают
    relay.handlers = new Proxy(relay.handlers, { get: (h, k: string) => h[k] ?? (k.startsWith("prefs.") ? undefined : () => ({ ok: false, error: "stand_no_handler" })) });
    const t = await openScreen(relay);
    await named(t, "a");
    await t.click(t.$('[data-act="open"]'));
    await t.run.hide();
    expect(relay.values["pult-open.recent"]).toEqual([{ m: "laptop", dir: "~/Projects/site" }]);
  });

  it("6511 · нет машин с session.open: «машин нет», «Открыть» недоступна; запоздалый ответ прежней машины не рисуется", async () => {
    const r = projRoster();
    for (const m of r.machines) {
      const { "session.open": _o, ...rest } = m.contract as Record<string, number>;
      m.contract = rest;
    }
    const off = await openScreen(openRelay(r), "/#open");
    expect(off.$(".op-none")!.textContent).toBe("машин нет");
    expect(off.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(true);
    const relay = openRelay();
    let late: (() => void) | null = null;
    relay.handlers["machine.dirs"] = (f) => {
      if (f.machine === "laptop") {
        late = () => relay.reply(f.id!, { ok: true, result: { path: f.path, dirs: ["old"] } });
        return undefined;
      }
      return { ok: true, result: { path: f.path, dirs: ["new"] } };
    };
    const t = await openScreen(relay);
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    late!();
    await flush(5);
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual(["new"]);
  });

  it("6512 · профиль и модель: чип показывает профили машины; повторное нажатие «Открыть», пока идёт запрос, второго кадра не даёт", async () => {
    const relay = openRelay();
    relay.handlers["session.open"] = () => undefined;
    const t = await openScreen(relay);
    await t.click(t.$('[data-pop="prof"]'));
    expect(t.$$(".op-pr[data-profile]").map((b) => b.dataset.profile)).toEqual(["team/profiles/ops", "team/profiles/writer", ""]);
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    expect(t.$('[data-pop="prof"] b')!.textContent).toBe("ops");
    await named(t, "a");
    await t.click(t.$('[data-act="open"]'));
    const b = t.$<HTMLButtonElement>('[data-act="open"]')!;
    expect(b.disabled).toBe(true);
    await t.click(b);
    expect(relay.sent("session.open")).toHaveLength(1);
    expect(relay.sent("session.open")[0]).toMatchObject({ profile: "team/profiles/ops" });
  });

  it("4130 · «в R2» не включилось — тост со словом, карточка новой сессии открыта", async () => {
    const relay = openRelay();
    relay.handlers["session.r2"] = () => ({ ok: false, error: "offline" });
    const t = await openScreen(relay);
    await named(t, "a");
    await t.click(t.$('[data-pop="model"]'));
    await t.click(t.$("[data-r2]"));
    await t.click(t.$('[data-act="open"]'));
    expect(t.$(".sb-toast")!.textContent).toBe("a@laptop: «в R2» не включилось — offline");
    expect(location.hash).toBe("#card?callsign=a%40laptop");
  });

  it("6513 · «+» у проекта: форма с местом его верхней сессии; после открытия сессия последняя в проекте; страница номера не читает", async () => {
    const relay = openRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "work", name: "Работа", sessions: ["site@laptop"] }] };
    const t = await pult({ relay });
    await flush(5);
    await t.click(t.$(".fc[data-fid=all]"));
    await t.click(t.$('.pj-add[data-proj="work"]'));
    await flush(10);
    expect(location.hash).toContain("project=work");
    expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~/Projects/site");
    await t.type(t.$('[data-f="name"]'), "fresh");
    await t.click(t.$('[data-act="open"]'));
    await flush(5);
    expect(relay.scoped.global["fleet.projects"]).toEqual([{ id: "work", name: "Работа", sessions: ["site@laptop", "fresh@laptop"] }]);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("project");
    const c = await pult({ relay: openRelay(), url: "/#card?callsign=site%40laptop" });
    await c.click(c.$('[data-pop="menu"]'));
    expect(c.$('[data-screen="open.near"]')).toBeNull();
  });
});

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
    expect(createCard.length).toBe(1);
    const points = pultParts().find((p) => p.manifest.name === "pult-points")!;
    expect(defined([points])[0].module.screens!["session.points"].place).toBe("card.tab");
    expect(points.manifest.uses["card.tab@web-card"]).toBe(1);
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
