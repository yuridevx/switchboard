// Флоу пульта по плану цикла тестов (web): новая сессия, вкладка «Точки», обзор точек, «пожар», перенос, диалоги точек.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { createCard } from "@switchboard/web-card";
import { pultParts } from "../stand/parts.ts";
import { fleetRelay, fleetRoster, flush, HOST, pointsRelay, pult, SID } from "./stand.ts";

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
  relay.handlers["machine.slots"] = (f) => ({ ok: true, result: { slots: { main: { account: "infirex", wait: null, sessions: f.machine === "laptop" ? ["site@laptop"] : [] }, night: { account: "work3", wait: 1793666400, sessions: [] } } } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high" }, "team/profiles/writer": { model: "haiku", effort: "low" } }, repos: {} } });
  relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["api", ".git", "site"] } });
  relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
  relay.handlers["session.r2"] = () => ({ ok: true, result: { point: 1 } });
  relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u1" } });
  return relay;
}

async function openScreen(relay = openRelay(), url = "/#open?project=site") {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
}

describe("новая сессия", () => {
  // источник: прототип «Пульт и телефон» (подписан 2 нояб.) и комментарии пользователя к нему: «имя сессии важно, что
  // делать не очень», «а где выбор профиля?», «покажи выбор папок»; машины проекта — фокус проекта
  it("5310 · имя — первым полем, позывной под ним с номером; профиль, папка и машина — из сессий проекта; остальные машины — списком", async () => {
    const t = await openScreen();
    const first = t.$(".op .op-fs input")!;
    expect(first.dataset.f).toBe("name");
    expect(first.getAttribute("placeholder")).toBe("site");
    expect(t.$(".op-at")!.textContent).toBe("→ site-2@laptop");
    expect(t.$('[data-profile="team/profiles/ops"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$$("[data-profile]").map((b) => b.textContent)).toEqual(["ops", "writer", "без профиля"]);
    expect(t.$$("[data-dir-pick]").map((b) => b.dataset.dirPick)).toEqual(["~/Projects/site", "~/projects/site"]);
    expect(t.$('[data-dir-pick="~/Projects/site"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$$("[data-machine]").map((b) => b.dataset.machine)).toEqual(["laptop"]);
    expect(t.$('[data-f="machine-more"]')!.textContent).toContain("pc");
    expect(t.$$("[data-slot]").map((b) => b.textContent)).toEqual(["main", `night · ждёт сброса ${new Date(1793666400 * 1000).toTimeString().slice(0, 5)}`]);
    expect(t.$(".op")!.textContent).not.toContain("null");
    await t.type(t.$('[data-f="name"]'), "fix");
    expect(t.$(".op-at")!.textContent).toBe("→ fix@laptop");
  });

  it("5311 · без сообщения — session.open (с профилем, папкой, слотом), «в R2» — session.r2, session.prompt нет; затем карточка", async () => {
    const t = await openScreen();
    await t.click(t.$('[data-act="open"]'));
    expect(t.relay.sent("session.open")).toEqual([expect.objectContaining({ v: 1, machine: "laptop", name: "site-2", dir: "~/Projects/site", slot: "main", profile: "team/profiles/ops" })]);
    expect(t.relay.sent("session.r2")).toEqual([expect.objectContaining({ callsign: "site-2@laptop", on: true })]);
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    expect(location.hash).toBe("#card?callsign=site-2%40laptop");
  });

  it("5312 · с сообщением — session.open → session.r2 → session.prompt { callsign, text }; Ctrl Enter открывает", async () => {
    const t = await openScreen();
    await t.type(t.$('[data-f="name"]'), "fix");
    await t.type(t.$('[data-f="text"]'), "Почини сценарий 4193");
    t.$('[data-f="text"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await flush(10);
    const types = t.relay.got.map((f) => f.type).filter((x) => ["session.open", "session.r2", "session.prompt"].includes(x));
    expect(types).toEqual(["session.open", "session.r2", "session.prompt"]);
    expect(t.relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "fix@laptop", text: "Почини сценарий 4193", attachments: [] })]);
    expect(location.hash).toBe("#card?callsign=fix%40laptop");
  });

  it("5313 · «другая папка…»: machine.dirs от папки на шаг выше, крошки, вложенные папки без скрытых, «Выбрать» ставит папку", async () => {
    const t = await openScreen();
    await t.click(t.btn(null, "другая папка…"));
    expect(t.relay.sent("machine.dirs").at(-1)).toMatchObject({ machine: "laptop", path: "~/Projects" });
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual(["api", "site"]);
    expect(t.$$("[data-crumb]").map((x) => x.dataset.crumb)).toEqual(["~", "~/Projects"]);
    await t.click(t.$('[data-dir="api"]'));
    expect(t.relay.sent("machine.dirs").at(-1)).toMatchObject({ path: "~/Projects/api" });
    await t.click(t.$('[data-crumb="~"]'));
    expect(t.relay.sent("machine.dirs").at(-1)).toMatchObject({ path: "~" });
    await t.click(t.$('[data-dir="site"]'));
    await t.click(t.$('[data-act="pick"]'));
    expect(t.$(".op-dirs")).toBeNull();
    expect(t.$('[data-dir-pick="~/site"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.click(t.$('[data-act="open"]'));
    expect(t.relay.sent("session.open")[0]).toMatchObject({ dir: "~/site" });
  });

  it("5314 · «Новая задача рядом» из меню ⋯ карточки — машина, папка и профиль той сессии", async () => {
    const t = await pult({ relay: openRelay(), url: "/#card?callsign=site%40laptop" });
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-screen="open.near"]'));
    await flush(10);
    expect(location.hash).toBe("#open-near?from=site%40laptop");
    expect(t.$('[data-machine="laptop"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-dir-pick="~/Projects/site"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-profile="team/profiles/ops"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("4121 · нет машин с session.open — «Нет машин на связи», «Открыть» недоступна, кадров нет", async () => {
    const r = projRoster();
    for (const m of r.machines) {
      m.contract = { ...HOST };
      delete m.contract["session.open"];
    }
    const t = await openScreen(openRelay(r));
    expect(t.text()).toContain("Нет машин на связи");
    expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(true);
    expect(t.relay.got.filter((f) => ["machine.slots", "machine.profiles", "machine.dirs"].includes(f.type))).toEqual([]);
  });

  it("4123 · отказ machine.dirs — строка со словом, папка прежняя", async () => {
    const relay = openRelay();
    relay.handlers["machine.dirs"] = () => ({ ok: false, error: "not_found" });
    const t = await openScreen(relay);
    await t.click(t.btn(null, "другая папка…"));
    expect(t.$(".op-dirs")!.textContent).toContain("machine.dirs: not_found");
    expect(t.$('[data-dir-pick="~/Projects/site"]')).not.toBeNull();
  });

  it("4124 · машина из адреса; смена машины — кадры новой, обзор закрыт, запоздалый ответ прежней не рисуется", async () => {
    const relay = openRelay();
    let late: (() => void) | null = null;
    relay.handlers["machine.slots"] = (f) => {
      if (f.machine === "pc" && !late) {
        late = () => relay.reply(f.id!, { ok: true, result: { slots: { pcslot: { account: null, wait: null, sessions: [] } } } });
        return undefined;
      }
      return { ok: true, result: { slots: { [`${f.machine}-main`]: { account: null, wait: null, sessions: [] } } } };
    };
    const t = await openScreen(relay, "/#open?machine=pc");
    expect(t.$('[data-machine="pc"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(relay.sent("machine.slots").find((f) => f.machine === "pc")).toMatchObject({ machine: "pc" });
    await t.click(t.btn(null, "другая папка…"));
    const sel = t.$<HTMLSelectElement>('[data-f="machine-more"]')!;
    sel.value = "laptop";
    sel.dispatchEvent(new Event("change"));
    await flush(10);
    expect(t.$(".op-dirs")).toBeNull();
    expect(relay.sent("machine.slots").at(-1)).toMatchObject({ machine: "laptop" });
    late!();
    await flush();
    expect(t.$$("[data-slot]").map((x) => x.dataset.slot)).toEqual(["laptop-main"]);
  });

  it("4125 · отказ machine.slots — слово на месте слотов; «Открыть» доступна", async () => {
    const relay = openRelay();
    relay.handlers["machine.slots"] = () => ({ ok: false, error: "offline" });
    const t = await openScreen(relay);
    expect(t.text()).toContain("machine.slots: offline");
    expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(false);
  });

  it("4127 · имя не по форме — строка под полем, session.open нет", async () => {
    const t = await openScreen();
    await t.type(t.$('[data-f="name"]'), "my board");
    await t.click(t.$('[data-act="open"]'));
    expect(t.$(".op-err")!.textContent).toBe("имя — латиница, цифры, точка, - и _");
    expect(t.relay.sent("session.open")).toHaveLength(0);
  });

  it("4128 · прочий отказ session.open — «session.open: слово», карточки, session.r2 и session.prompt нет", async () => {
    const relay = openRelay();
    relay.handlers["session.open"] = () => ({ ok: false, error: "bad_dir" });
    const t = await openScreen(relay);
    await t.type(t.$('[data-f="text"]'), "привет");
    await t.click(t.$('[data-act="open"]'));
    expect(t.$(".op-err")!.textContent).toBe("session.open: bad_dir");
    expect(relay.sent("session.r2")).toHaveLength(0);
    expect(relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".cw")).toBeNull();
  });

  it("4129 · повторное нажатие, пока session.open идёт, — «Открываю…», второго кадра нет", async () => {
    const relay = openRelay();
    relay.handlers["session.open"] = () => undefined;
    const t = await openScreen(relay);
    await t.click(t.$('[data-act="open"]'));
    const b = t.btn(null, "Открываю…")!;
    expect(b.disabled).toBe(true);
    await t.click(b);
    expect(relay.sent("session.open")).toHaveLength(1);
  });

  it("4130 · «в R2» не включилось — тост со словом, карточка новой сессии открыта; выключили в деталях — session.r2 нет", async () => {
    const relay = openRelay();
    relay.handlers["session.r2"] = () => ({ ok: false, error: "offline" });
    const t = await openScreen(relay);
    await t.type(t.$('[data-f="name"]'), "board");
    await t.click(t.$('[data-act="open"]'));
    expect(t.$(".sb-toast")!.textContent).toBe("board@laptop: «в R2» не включилось — offline");
    expect(location.hash).toBe("#card?callsign=board%40laptop");
    const t2 = await openScreen();
    await t2.click(t2.$('[data-act="more"]'));
    await t2.click(t2.$('[data-r2="off"]'));
    await t2.click(t2.$('[data-act="open"]'));
    expect(t2.relay.sent("session.r2")).toHaveLength(0);
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
  relay.handlers["machine.slots"] = (f) => ({ ok: true, result: { slots: { [f.machine === "pc" ? "main" : "bot"]: {} } } });
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
    expect(t.text()).toContain("не в R2 — точек и переноса у них нет");
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

  it("4169 · другая машина-цель — слоты и пробы заново, кнопка на неё", async () => {
    const t = await points();
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    await t.click(t.btn(t.$('[data-dlg="fire"]'), "pc"));
    await flush(10);
    expect(t.relay.sent("machine.slots").at(-1)).toMatchObject({ machine: "pc" });
    expect(t.relay.sent("points.raise").filter((f) => f.machine === "pc" && f.dryRun)).toHaveLength(2);
    expect(t.$('[data-row="one"]')!.textContent).toContain("Слот на pc: main");
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
    expect(relay.sent("points.raise").at(-1)).toMatchObject({ machine: "laptop", sid: "old", point: 4, slot: "bot" });
    expect(relay.sent("points.raise").at(-1)).not.toHaveProperty("dryRun");
    expect(t.$('[data-dlg="raise"]')!.textContent).toContain("old-bot поднята: old-bot@laptop");
    expect(relay.sent("points.list").length).toBe(lists + 1);
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
      [{ ok: false, error: "offline" }, "Машины нет на связи"],
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

  it("4175 · отказ session.r2 — «Машины нет на связи», пометки нет", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = () => ({ ok: false, error: "offline" });
    const t = await sessionTab(relay, "wiki@laptop");
    const box = t.$<HTMLInputElement>('[data-r2="off"] [data-act="r2"]')!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(t.$("[data-note]")!.textContent).toBe("Машины нет на связи");
    expect(t.$('[data-r2="off"]')).not.toBeNull();
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
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$$(".cw-tabs [data-tab]").map((x) => x.dataset.tab)).toContain("session.points");
    await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
    expect(t.$('.cw-place [data-r2="on"]')).not.toBeNull();
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    expect(t.$$(".cw-tabs [data-tab]").map((x) => x.dataset.tab)).not.toContain("session.points");
  });

  it("5124 · «Точки» — экран pult-points в месте card.tab: карточка без опций, вкладка между «Разговором» и «Настройками»", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): вкладка «Точки» через место card.tab; опций у карточки 0
    expect(createCard.length).toBe(0);
    const points = pultParts().find((p) => p.manifest.name === "pult-points")!;
    expect(points.module.screens!["session.points"].place).toBe("card.tab");
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
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await run(t);
    expect(relay.sent("points.save")[0]).toMatchObject({ callsign: "site@laptop", stop: true, interrupt: true });
  });

  it("4189 · отказ machine.slots цели — проверка словом, запуск недоступен, points.save нет", async () => {
    const relay = dialogRelay();
    relay.handlers["machine.slots"] = () => ({ ok: false, error: "offline" });
    const t = await sessionTab(relay);
    await t.click(t.btn(null, "Перенести…"));
    await flush(10);
    expect(t.$('[data-dlg="move"] [data-check="error"]')!.textContent).toBe("machine.slots: offline");
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
