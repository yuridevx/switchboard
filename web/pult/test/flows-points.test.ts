// Флоу экрана новой сессии: имя, адрес, профиль, отказы машины, места.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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
