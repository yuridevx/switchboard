// Леса границы «обзор флота на странице»: новая сессия. Экран снесёт своя волна: файл вынесен как есть — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createLabels, manifest as labelsM } from "@switchboard/web-labels";
import { FakeRelay, flush, homeRoster, stand } from "../../packages/core/stand/app.ts";
import { createOpen, manifest as openM } from "../modules/open/contract.ts";
import { fleetRelay, fleetRoster, pult, SLOTS } from "./stand.ts";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Новая сессия", () => {
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
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("без профиля");
    });

    it("6503 · профиль подхватывается только от сессии в этой же папке", async () => {
      const r = projRoster();
      r.sessions.find((s) => s.callsign === "site@laptop")!.profile = { id: "team/profiles/ops", state: "ok" };
      const t = await openScreen(openRelay(r));
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("ops");
      await go(t, "~/Projects/other");
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("без профиля");
    });

    it("6520 · профиль, выбранный вручную, переживает правку адреса", async () => {
      // источник: слепой архитектор 4 нояб.: поле profileSet в форме нигде не ставилось, адрес сбрасывал выбор человека
      const t = await openScreen();
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("ops");
      await go(t, "~/Projects/other");
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("ops");
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
      expect(t.$$(".op-set [data-profile]").map((b) => b.dataset.profile)).toEqual(["team/profiles/ops", "team/profiles/writer", ""]);
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent).toBe("ops");
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
      expect(c.$('[data-screen="open.near"]')).toBeNull();
    });

    it("V-O1 · подписи: поля, последние места; настройки на странице; поиск профиля; без окон — подписи и «Точки в R2»", async () => {
      const relay = openRelay();
      relay.values["pult-open.recent"] = [{ m: "pc", dir: "~/p" }];
      const t = await openScreen(relay);
      expect(addr(t).getAttribute("aria-label")).toBe("Адрес папки");
      expect(t.$(".op-rec")!.getAttribute("aria-label")).toBe("Последние места");
      const text = t.$<HTMLTextAreaElement>('[data-f="text"]')!;
      expect([text.placeholder, text.getAttribute("aria-label")]).toEqual(["Что сделать?", "Задача"]);
      expect(t.$('[data-place-machine="pc"]')!.textContent).toBe("@pc ~/p");
      expect(t.$(".op-bl")!.getAttribute("aria-label")).toBe("Машины");
      // слово пользователя 6 нояб.: без вложенности и окон — всё на странице
      expect(t.$(".op-pop, .op-shade, [role=dialog]")).toBeNull();
      expect(t.$$(".op-set > .lb").map((x) => x.textContent)).toEqual(["Профиль", "Модель", "Усилие", "Слот"]);
      const pq = t.$<HTMLInputElement>('[data-f="pq"]')!;
      expect([pq.placeholder, pq.getAttribute("aria-label")]).toEqual(["Найти профиль", "Найти профиль"]);
      await t.type(pq, "writer");
      expect(t.$$(".op-set [data-profile]").map((b) => b.dataset.profile)).toEqual(["team/profiles/writer", ""]);
      await t.click(t.$('[data-profile="team/profiles/writer"]'));
      expect(t.$('[data-profile="team/profiles/writer"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(t.$(".op-sw")!.textContent).toContain("Точки в R2");
      expect(t.$("[data-r2]")!.getAttribute("aria-label")).toBe("Точки в R2");
      await t.click(t.$("[data-r2]"));
      expect(t.$("[data-r2]")!.getAttribute("aria-checked")).toBe("true");
      // Ctrl Enter запускает
      const t2 = await openScreen(openRelay(), "/#open?machine=laptop&dir=~%2Fzz");
      await named(t2, "a");
      t2.$('[data-f="text"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      await flush(5);
      expect(t2.relay.sent("session.open")).toHaveLength(1);
    });
  });
});

describe("Новая сессия: выбор и запуск", () => {
  type T = Awaited<ReturnType<typeof pult>>;

  function openRelay(r: Roster = fleetRoster()) {
    const relay = fleetRelay(r);
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", wait: null, sessions: [] }, night: { account: "b", wait: null, sessions: [] } } } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high" } }, repos: {} } });
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["api", "site"] } });
    relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
    relay.handlers["session.r2"] = () => ({ ok: true, result: { point: 1 } });
    relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u1" } });
    return relay;
  }

  async function openScreen(relay = openRelay(), url = "/#open?machine=laptop&dir=~%2Fsite") {
    const t = await pult({ relay, url });
    await flush(10);
    return t;
  }
  const named = (t: T, v: string) => t.type(t.$('[data-f="name"]'), v);
  const modelNow = (t: T) => t.$('.op-set [data-model][aria-pressed="true"]')?.textContent;
  const chipProf = (t: T) => t.$('.op-set [data-profile][aria-pressed="true"]')!.textContent;
  const start = (t: T) => t.click(t.$('[data-act="open"]'));

  describe("новая сессия: выбор", () => {
    it("7254 · машина научилась точкам при открытой форме — переключатель становится доступен", async () => {
      // источник: чьё: код — переключатель виден, когда машина умеет session.r2; roster меняется и при открытом окне
      const relay = openRelay();
      const without = fleetRoster();
      without.machines = without.machines.map((m) => {
        const contract = { ...m.contract };
        delete contract["session.r2"];
        return { ...m, contract };
      });
      relay.setRoster(without);
      const t = await openScreen(relay);
      expect(t.$<HTMLButtonElement>("[data-r2]")!.disabled).toBe(true);
      relay.setRoster(fleetRoster());
      await flush(5);
      expect(t.$<HTMLButtonElement>("[data-r2]")!.disabled).toBe(false);
    });

    it("6910 · другая машина: профиль и слот снова по умолчанию", async () => {
      // источник: чьё: код — выбранных там может не быть
      const t = await openScreen();
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      await t.click(t.$('[data-slot="night"]'));
      expect(t.$('[data-slot="night"]')!.getAttribute("aria-pressed")).toBe("true");
      await t.click(t.$('.op-bl [data-machine="pc"]'));
      await flush(5);
      expect(chipProf(t)).toBe("без профиля");
      expect(t.$('[data-slot="night"]')?.getAttribute("aria-pressed") ?? "false").toBe("false");
    });

    it("6911 · модель выбрана человеком: не следует за профилем; не выбрана — следует", async () => {
      // источник: чьё: код
      const t = await openScreen();
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(modelNow(t)).toBe("opus");
      await t.click(t.$('[data-model="sonnet"]'));
      await t.click(t.$('[data-profile=""]'));
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(modelNow(t)).toBe("sonnet");
    });

    it("6912 · slots и profiles отказали: слово в окне своего чипа; форма работает, запуск доступен", async () => {
      // источник: устав — отказ словом
      const relay = openRelay();
      relay.handlers[SLOTS] = () => ({ ok: false, error: "offline" });
      relay.handlers["machine.profiles"] = () => ({ ok: false, error: "no_repo" });
      const t = await openScreen(relay);
      expect(t.$(".op-set")!.textContent).toContain("machine.profiles: no_repo");
      expect(t.$(".op-set")!.textContent).toContain("machine.accounts: offline");
      await named(t, "a");
      await start(t);
      expect(relay.sent("session.open")).toEqual([expect.objectContaining({ machine: "laptop", name: "a" })]);
    });

    it("6915 · модель уходит в session.open, только если выбрана", async () => {
      // источник: факт — модель значит, когда выбрана человеком
      const first = openRelay();
      const t = await openScreen(first);
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      await named(t, "a");
      await start(t);
      expect(first.sent("session.open")[0]).toMatchObject({ profile: "team/profiles/ops" });
      expect(first.sent("session.open")[0]).not.toHaveProperty("model");
      expect(first.sent("session.open")[0]).not.toHaveProperty("effort");
      const second = openRelay();
      const t2 = await openScreen(second);
      await t2.click(t2.$('[data-model="sonnet"]'));
      await named(t2, "b");
      await start(t2);
      expect(second.sent("session.open")[0]).toMatchObject({ model: "sonnet" });
    });

    it("6918 · машина не умеет slots, profiles и r2: запросов нет, слов отказа нет, переключатель неактивен", async () => {
      // источник: факт — машина такого запроса не умеет: не спрашиваем, данных нет
      const r = fleetRoster();
      for (const n of ["machine.accounts", "machine.profiles", "session.r2"]) delete r.machines[0].contract![n];
      const relay = openRelay(r);
      const t = await openScreen(relay);
      expect(t.$(".op-set .op-err")).toBeNull();
      expect(t.$<HTMLButtonElement>("[data-r2]")!.disabled).toBe(true);
      await named(t, "a");
      await start(t);
      expect(relay.sent("machine.accounts")).toHaveLength(0);
      expect(relay.sent("machine.profiles")).toHaveLength(0);
      expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
      expect(relay.sent("session.open")[0]).not.toHaveProperty("profile");
    });

    it("6922 · другая машина отказала: слоты и профиль прежней не показаны и не уходят в её session.open", async () => {
      // источник: факт — другая машина снова по умолчанию: выбранных там может не быть
      const relay = openRelay();
      const of = relay.handlers[SLOTS];
      relay.handlers[SLOTS] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : of(f));
      const op = relay.handlers["machine.profiles"];
      relay.handlers["machine.profiles"] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : op(f));
      const t = await openScreen(relay);
      await t.click(t.$('.op-bl [data-machine="pc"]'));
      await flush(5);
      expect(t.$('[data-slot="main"]')).toBeNull();
      expect(t.$('[data-profile="team/profiles/ops"]')).toBeNull();
      await named(t, "a");
      await start(t);
      expect(relay.sent("session.open")[0]).toMatchObject({ machine: "pc" });
      expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
    });

    it("6924 · ответ другой машины ещё идёт: слот прежней в её session.open не уходит", async () => {
      // источник: то же; окно между выбором машины и ответом
      const relay = openRelay();
      const t = await openScreen(relay);
      relay.handlers[SLOTS] = () => undefined;
      await t.click(t.$('.op-bl [data-machine="pc"]'));
      await flush(5);
      await named(t, "a");
      await start(t);
      expect(relay.sent("session.open")[0]).toMatchObject({ machine: "pc" });
      expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
    });
  });

  describe("новая сессия: старт формы", () => {
    it("6916 · адрес страницы: машины ещё нет — запуск неактивен; пришла — машина и папка из адреса", async () => {
      // источник: факт — машина может прийти своим соединением позже первого roster
      const r = fleetRoster();
      r.machines = r.machines.filter((m) => m.machine !== "pc");
      const relay = openRelay(r);
      const t = await openScreen(relay, "/#open?machine=pc&dir=~%2Fx");
      expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(true);
      // машина pc вошла гостем: клиент флота открыл соединение с её relay
      const full = fleetRoster();
      full.clients = [...full.clients, "@pc"];
      relay.setRoster(full);
      await flush(10);
      expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(false);
      expect(t.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
      expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~/x");
    });

    it("6917 · без адреса: последнее своё место; мест нет — машина с большим числом сессий и домашняя папка; новый roster выбор не меняет", async () => {
      // источник: факт — правило старта, выбирается один раз
      const relay = openRelay();
      relay.values["pult-open.recent"] = [{ m: "pc", dir: "~/p" }];
      const t = await openScreen(relay, "/#open");
      expect(t.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
      expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~/p");

      const r = fleetRoster();
      r.sessions = r.sessions.filter((s) => s.callsign !== "site@laptop" && s.callsign !== "wiki@laptop");
      const relay2 = openRelay(r);
      const t2 = await openScreen(relay2, "/#open");
      expect(t2.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
      expect(t2.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~");
      relay2.setRoster(fleetRoster({ sessions: r.sessions.filter((s) => s.callsign.endsWith("@laptop")) }));
      await flush(10);
      expect(t2.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
    });
  });

  describe("новая сессия: запуск", () => {
    it("6913 · без задачи: session.prompt нет, место в последних, открыта карточка", async () => {
      // источник: факт — задача необязательна; запрос один, исхода два
      const relay = openRelay();
      const t = await openScreen(relay);
      await named(t, "a");
      await start(t);
      await flush(5);
      expect(relay.sent("session.open")).toHaveLength(1);
      expect(relay.sent("session.prompt")).toHaveLength(0);
      expect(relay.values["pult-open.recent"]).toEqual([{ m: "laptop", dir: "~/site" }]);
      expect(location.hash).toBe("#card?callsign=a%40laptop");
    });

    it("6914 · с задачей и R2: session.open, затем session.r2 и session.prompt с текстом; открыта карточка", async () => {
      // источник: чьё: код
      const relay = openRelay();
      const t = await openScreen(relay);
      await t.click(t.$("[data-r2]"));
      await named(t, "a");
      await t.type(t.$('[data-f="text"]'), "  почини сборку ");
      expect(t.$('[data-act="open"]')!.textContent).toBe("Начать");
      await start(t);
      await flush(5);
      const types = relay.got.map((f) => f.type).filter((x) => ["session.open", "session.r2", "session.prompt"].includes(x));
      expect(types).toEqual(["session.open", "session.r2", "session.prompt"]);
      expect(relay.sent("session.prompt")[0]).toMatchObject({ callsign: "a@laptop", text: "почини сборку" });
      expect(location.hash).toBe("#card?callsign=a%40laptop");
    });

    it("6919 · машина отказала в открытии: слово над кнопкой; карточки нет, место не запомнено, набранное на месте", async () => {
      // источник: устав — прямой запрос не прошёл, отказ словом
      const relay = openRelay();
      relay.handlers["session.open"] = () => ({ ok: false, error: "offline" });
      const t = await openScreen(relay);
      await named(t, "a");
      await t.type(t.$('[data-f="text"]'), "задача");
      await start(t);
      await flush(5);
      expect(t.$(".op-foot")!.previousElementSibling!.textContent).toBe("session.open: offline");
      expect(location.hash).toContain("#open");
      expect(relay.values["pult-open.recent"]).toBeUndefined();
      expect(t.$<HTMLTextAreaElement>('[data-f="text"]')!.value).toBe("задача");
      expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(false);
    });

    it("6920 · задача не ушла: тост со словом, карточка новой сессии открыта", async () => {
      // источник: факт — без неё сессия открыта и ждёт ввода; устав — отказ словом
      const relay = openRelay();
      relay.handlers["session.prompt"] = () => ({ ok: false, error: "offline" });
      const t = await openScreen(relay);
      await named(t, "a");
      await t.type(t.$('[data-f="text"]'), "задача");
      await start(t);
      await flush(5);
      expect(t.$(".sb-toast")!.textContent).toBe("a@laptop: задача не ушла — offline");
      expect(location.hash).toBe("#card?callsign=a%40laptop");
    });

    it("6921 · список папок отказал: слово на экране; session.open уходит — решает машина", async () => {
      // источник: устав — отказ словом; факт — запрос один, решает машина
      const relay = openRelay();
      relay.handlers["machine.dirs"] = () => ({ ok: false, error: "no_access" });
      const t = await openScreen(relay);
      expect(t.$(".op-bf")!.textContent).toContain("нет доступа к этой папке");
      await named(t, "a");
      await start(t);
      expect(relay.sent("session.open")).toHaveLength(1);
      const relay2 = openRelay();
      relay2.handlers["machine.dirs"] = () => ({ ok: false, error: "offline" });
      const t2 = await openScreen(relay2);
      expect(t2.$(".op-bf")!.textContent).toContain("machine.dirs: offline");
    });

    it("6923 · запись места отказала: сессия открыта, тост словом", async () => {
      // источник: факт — отказ записи словом на экране
      const relay = openRelay();
      relay.handlers["prefs.set"] = () => ({ ok: false, error: "denied" });
      const t = await openScreen(relay);
      await named(t, "a");
      await start(t);
      await flush(10);
      expect(relay.sent("session.open")).toHaveLength(1);
      expect(location.hash).toBe("#card?callsign=a%40laptop");
      expect(t.$(".sb-toast")!.textContent).toBe("Настройка не сохранилась: denied");
    });
  });
});

describe("Новая сессия и карточка с «Работы»", () => {
  /** Ответы владельцев для новой сессии на laptop. */
  function openRelay(roster = fleetRoster()) {
    const relay = fleetRelay(roster);
    relay.handlers[SLOTS] = () => ({
      ok: true,
      result: { slots: { main: { account: "infirex", order: ["infirex"], wait: null, sessions: ["site@laptop", "profiles@laptop"] }, bot: { account: "work3", order: ["work3"], wait: null, sessions: ["wiki@laptop"] } } },
    });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { infirex: { login: "ok", limits: { five_hour: { utilization: 0.82, resetsAt: 1, at: 1, src: "event" } } } } } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high", sessions: [] } }, repos: {} } });
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: f.path === "~" ? ["Projects"] : f.path === "~/Projects" ? ["api", "poe2", "profiles", "site", "switchboard", "wiki"] : [] } });
    relay.handlers["session.open"] = (f) => (f.name === "site" ? { ok: false, error: "name_taken" } : { ok: true, result: { callsign: `${f.name}@${f.machine}`, session_id: "s-1" } });
    relay.handlers["session.r2"] = () => ({ ok: true, result: { point: 1 } });
    return relay;
  }

  /** Заполнить «Новую сессию»: машина laptop, адрес ~/Projects/switchboard, профиль ops, слот main, имя. */
  async function fillOpen(t: Awaited<ReturnType<typeof pult>>, name: string) {
    await t.go("#open");
    await flush(5);
    await t.click(t.$('.op-bl [data-machine="laptop"]'));
    await t.click(t.$('[data-dir="Projects"]'));
    await t.click(t.$('[data-dir="switchboard"]'));
    await flush(5);
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    await t.click(t.$('[data-slot="main"]'));
    await t.type(t.$('[data-f="name"]'), name);
  }

  it("181 · «Новая»: один session.open с машиной, именем, папкой, слотом и профилем → чат board@laptop; pc не на связи — нет в выборе; name_taken — под полем имени", async () => {
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    const t = await pult({ relay: openRelay(r) });
    await fillOpen(t, "board");
    expect(t.$('[data-machine="pc"]')).toBeNull();
    expect(t.relay.sent("machine.dirs").map((f) => f.path).slice(-3)).toEqual(["~", "~/Projects", "~/Projects/switchboard"]);
    expect(t.relay.sent("machine.mkdir")).toHaveLength(0);
    await t.click(t.$('[data-act="open"]'));
    expect(t.relay.sent("session.open")).toEqual([
      expect.objectContaining({ v: 2, machine: "laptop", name: "board", dir: "~/Projects/switchboard", slot: "main", profile: "team/profiles/ops" }),
    ]);
    expect(location.hash).toBe("#card?callsign=board%40laptop");
    expect(t.$(".cw-cs")!.textContent).toBe("board");
    expect(t.$(".sb-detail .chat")).not.toBeNull();

    const t2 = await pult({ relay: openRelay(r) });
    await fillOpen(t2, "site");
    await t2.click(t2.$('[data-act="open"]'));
    expect(t2.relay.sent("session.open")).toHaveLength(1);
    expect(t2.$(".op-err")!.textContent).toBe("на laptop уже есть site");
    expect(t2.$('.sb-detail [data-screen="open"]')).not.toBeNull();
  });

  it("260 · «Точки в R2» по умолчанию выключены: session.r2 нет; включили — после reply session.r2 { callsign, on: true }; поля r2 в session.open нет", async () => {
    // источник: слово пользователя 3 нояб.: «точка р2 по умолчанию выключено»
    const t = await pult({ relay: openRelay() });
    await fillOpen(t, "board");
    await t.click(t.$('[data-act="open"]'));
    expect(t.relay.sent("session.open")).toHaveLength(1);
    expect(t.relay.sent("session.r2")).toHaveLength(0);
    expect(t.relay.sent("session.open")[0]).not.toHaveProperty("r2");

    const t2 = await pult({ relay: openRelay() });
    await fillOpen(t2, "board");
    await t2.click(t2.$("[data-r2]"));
    await t2.click(t2.$('[data-act="open"]'));
    const types = t2.relay.got.map((f) => f.type);
    expect(types.indexOf("session.r2")).toBeGreaterThan(types.indexOf("session.open"));
    expect(t2.relay.sent("session.r2")).toEqual([expect.objectContaining({ v: 1, callsign: "board@laptop", on: true })]);
    expect(t2.relay.sent("session.open")[0]).not.toHaveProperty("r2");
    expect(location.hash).toBe("#card?callsign=board%40laptop");
  });

  it("V-O2 · новая сессия на пульте: ✕ — назад; Ctrl Enter в поле имени запускает", async () => {
    const relay = openRelay();
    const t = await pult({ relay, url: "/#sessions" });
    await t.go("#open?machine=laptop&dir=~");
    await flush(5);
    await t.type(t.$('[data-f="name"]'), "a");
    t.$('[data-f="name"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await flush(5);
    expect(relay.sent("session.open")).toHaveLength(1);
    await t.go("#open?machine=laptop&dir=~");
    await flush(5);
    await t.click(t.$('.op-x[aria-label="Закрыть"]'));
    await flush(10);
    expect(location.hash).not.toContain("#open");
  });
});

describe("Новая сессия: строка слота", () => {
  const slot = (wait: number | null = null) => ({ account: "a", order: ["a"], wait, sessions: [] });
  const named = async (t: Awaited<ReturnType<typeof pult>>, name: string) => {
    const nm = t.$<HTMLInputElement>('[data-f="name"]')!;
    await t.type(nm, name);
  };
  const start = (t: Awaited<ReturnType<typeof pult>>) => t.click(t.$('[data-act="open"]'));

  function openRelay(slots: Record<string, unknown> | null) {
    const relay = fleetRelay();
    if (slots) relay.handlers[SLOTS] = () => ({ ok: true, result: { slots } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: [] } });
    relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
    return relay;
  }
  async function openForm(relay: ReturnType<typeof fleetRelay>) {
    const t = await pult({ relay });
    await t.go("#open?machine=laptop");
    await flush(10);
    return t;
  }

  it("8 · на машине нет слотов: форма говорит об этом и запуск закрыт, session.open не уходит", async () => {
    // источник: слово пользователя 5 нояб.: стандартная папка не используется, без слота сессии нет
    const relay = openRelay({});
    const t = await openForm(relay);
    expect(t.$("[data-no-slots]")!.textContent).toBe("На laptop нет слотов: войдите в аккаунт на этой машине");
    await named(t, "a");
    expect(t.$('[data-act="open"]')!.hasAttribute("disabled")).toBe(true);
    expect(relay.sent("session.open")).toHaveLength(0);
  });

  it("E24 · форма: 1 слот — строки нет, запрос без поля", async () => {
    const relay = openRelay({ main: slot() });
    const t = await openForm(relay);
    expect(t.$("[data-slot-pick]")).toBeNull();
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
  });

  it("E24 · форма: 2 слота, человек не менял выбор — отмечен первый, запрос с ним; выбрал другой — с другим", async () => {
    const relay = openRelay({ main: slot(), bot: slot() });
    const t = await openForm(relay);
    expect(t.$('[data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.click(t.$('[data-slot="bot"]'));
    expect(t.$('[data-slot="bot"]')!.getAttribute("aria-pressed")).toBe("true");
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).toMatchObject({ slot: "bot" });
  });

  it("E24 · единственный слот ждёт сброса: выбора нет, подпись в ряду слота", async () => {
    const relay = openRelay({ main: slot(1793666400) });
    const t = await openForm(relay);
    expect(t.$("[data-slot-wait]")!.textContent).toContain("main · ждёт сброса");
  });

  it("E15 · список слотов не пришёл, машина с двумя слотами: запрос без поля, «Выберите слот», список перечитан один раз", async () => {
    // источник: чьё: код; дизайн — форма не заходит в тупик
    const relay = openRelay({ main: slot(), bot: slot() });
    const of = relay.handlers[SLOTS];
    let silent = true;
    relay.handlers[SLOTS] = (f) => (silent ? { ok: false, error: "timeout" } : of(f));
    relay.handlers["session.open"] = () => ({ ok: false, error: "slot_required", why: "Слоты машины: main, bot" });
    const t = await openForm(relay);
    await named(t, "a");
    silent = false;
    const asked = relay.sent("machine.accounts").length;
    await start(t);
    await flush(10);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
    expect(t.text()).toContain("Выберите слот");
    expect(relay.sent("machine.accounts").length).toBe(asked + 1);
    expect(t.$('[data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("E21 · отказ машины с причиной виден на форме", async () => {
    const relay = openRelay({ main: slot() });
    relay.handlers["session.open"] = () => ({ ok: false, error: "not_logged_in", why: "в слоте main никого" });
    const t = await openForm(relay);
    await named(t, "a");
    await start(t);
    await flush(5);
    expect(t.text()).toContain("session.open: not_logged_in — в слоте main никого");
  });
});

describe("Новая сессия: телефон", () => {
  const phoneParts = () => [
    { manifest: labelsM, module: createLabels },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
    { manifest: openM, module: createOpen },
  ];

  it("5319 · новая сессия на телефоне: имя сверху, машина кнопкой, адрес и папки", async () => {
    const r = homeRoster();
    for (const m of r.machines) m.contract = { ...m.contract, "session.open": 1, "machine.dirs": 1 };
    const relay = new FakeRelay(r);
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["src"] } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const t = await stand(phoneParts(), { relay, url: "/#open" });
    await flush(5);
    // машина — кнопкой над адресом; список машин открывается по ней
    expect(t.$('.op-bl')).toBeNull();
    await t.click(t.$('[data-act="pick-machine"]'));
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    expect(t.$(".op-bl")).toBeNull();
    expect(t.$(".op-bk")!.textContent).toBe("@pc");
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual(["src"]);
    expect(t.$<HTMLInputElement>('[data-f="name"]')!.value).toBe("");
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

  it("новая сессия: машины — где больше сессий; другая машина — домашняя папка; пустая папка — «пусто»; новый путь важнее задачи; машины нет — адрес домашний", async () => {
    const relay = fleetRelay(cut("session.foo"));
    relay.handlers["machine.dirs"] = (f) => (f.path === "~/none" ? { ok: false, error: "not_found" } : { ok: true, result: { path: f.path, dirs: [] } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const r = fleetRoster();
    r.sessions = r.sessions.filter((s) => s.callsign !== "site@laptop" && s.callsign !== "wiki@laptop");
    relay.setRoster(r);
    const t = await pult({ relay, url: "/#open?machine=laptop&dir=~%2Fnone%2Fx" });
    await flush(5);
    expect(t.$$(".op-bl [data-machine]").map((x) => x.dataset.machine)).toEqual(["pc", "laptop"]);
    await t.type(t.$('[data-f="text"]'), "задача");
    expect(t.$('[data-act="open"]')!.textContent).toBe("Создать и открыть");
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~");
    expect(t.$(".op-dl .op-none")!.textContent).toBe("пусто");
    const absent = await pult({ relay, url: "/#open?machine=nosuch&dir=~%2Fx" });
    await flush(5);
    expect(absent.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~");
    expect(absent.$('[data-act="open"]')!.textContent).toBe("Открыть");
  });
});
