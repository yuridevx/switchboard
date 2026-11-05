// Леса границы «обзор флота на странице»: список сессий, карточка, новая сессия, машины, настройки — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код. Жесты перетаскивания указателем проверяются в браузере: npm run drag.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModule, AppPart, Frame, Manifest, Roster } from "@switchboard/web-core";
import { memoryStore } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM, type BrowserPush } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createInbox, manifest as inboxM } from "@switchboard/web-inbox";
import { createLabels, manifest as labelsM } from "@switchboard/web-labels";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";
import { createMachines, manifest as machinesM } from "../modules/machines/contract.ts";
import { createOpen, manifest as openM } from "../modules/open/contract.ts";
import { createSettings, manifest as settingsM } from "../modules/settings/contract.ts";
import { fleetRelay, fleetRoster, pult, SLOTS } from "./stand.ts";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Работа", () => {
  const parts = () => [
    { manifest: labelsM, module: createLabels },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  /** switchboard на laptop, pc и build; pfarm на pc; чужая сессия anna. Я — phone~you@mail. */
  function fleet(): Roster {
    const r = homeRoster();
    r.machines = [...r.machines, { machine: "build", since: 1, proto: 1, contract: r.machines[0].contract }];
    r.sessions = [
      { callsign: "refactor@laptop", state: "busy", dir: "~/Projects/switchboard", by: "pult~you@mail", model: "opus", profile: { id: "you/profiles/switchboard", state: "ok" } },
      { callsign: "tests@pc", state: "busy", dir: "~/projects/switchboard", parent: "refactor@laptop", by: "refactor@laptop", model: "sonnet", profile: { id: "you/profiles/ci", state: "ok" } },
      { callsign: "migrate@laptop", state: "waiting", dir: "~/Projects/switchboard", by: "phone~you@mail", model: "opus", profile: { id: "you/profiles/switchboard", state: "ok" } },
      { callsign: "build@build", state: "idle", dir: "~/src/switchboard", by: "pult~you@mail", model: "sonnet", profile: { id: "you/profiles/ci", state: "ok" } },
      { callsign: "api@pc", state: "idle", dir: "~/projects/pfarm", by: "alerts~you@mail", model: "opus" },
      { callsign: "docs@pc", state: "idle", dir: "~/projects/pfarm", by: "laptop~anna@mail", model: "sonnet" },
      { callsign: "note@pc", state: "idle", dir: "~/notes", parent: "docs@pc", by: "docs@pc", model: "haiku" },
    ];
    r.clients = ["phone~you@mail", "pult~you@mail", "laptop~anna@mail"];
    return r;
  }

  type T = Awaited<ReturnType<typeof stand>>;
  const rows = (t: T) => t.$$(".bd-row").map((x) => x.dataset.callsign);
  const projects = (t: T) => t.$$(".pjs").map((x) => x.dataset.proj);
  const chips = (t: T) => t.$$(".fscroll > .fc").map((x) => x.dataset.fid);
  /** Запись проектов флота: проект — группа, собранная вручную; здесь она совпала с папками. */
  const PROJECTS = () => [
    { id: "switchboard", name: "switchboard", sessions: ["migrate@laptop", "refactor@laptop", "tests@pc", "build@build"] },
    { id: "pfarm", name: "pfarm", sessions: ["api@pc", "docs@pc"] },
    { id: "notes", name: "notes", sessions: ["note@pc"] },
  ];
  const relayWith = (values: Record<string, unknown> = {}, projects: unknown = PROJECTS()) => Object.assign(new FakeRelay(fleet()), { values, scoped: { global: { "fleet.projects": projects } } as Record<string, Record<string, unknown>> });
  /** Записи области флота поверх записи проектов. */
  const withLabels = (labels: unknown, values: Record<string, unknown> = {}) => {
    const relay = relayWith(values);
    relay.scoped.global["fleet.labels"] = labels;
    return relay;
  };
  const press = async (el: Element, key: string) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await flush(3);
  };
  const start = (o: Parameters<typeof stand>[1] = {}) => stand(parts(), { relay: relayWith(), ...o }).then(async (t) => (await flush(5), t));

  describe("список", () => {
    it("5210 · проект — последнее имя папки на любой машине; разделы: ждёт вас → работает → остальные; числа сессий в заголовке нет (слово пользователя 3 нояб.: «цифер не нужно»)", async () => {
      const t = await start();
      expect(projects(t)).toEqual(["switchboard", "pfarm"]);
      expect(t.$(".pj-t .n")).toBeNull();
    });

    it("5211 · «Моё»: чужой сессии нет (чьё: код — whyMine); во «Всё» — владелец вместо метки «чужая», чужая дочь чужой — тоже", async () => {
      const t = await start();
      await t.expand();
      expect(rows(t)).toContain("api@pc");
      expect(rows(t)).toContain("tests@pc");
      expect(rows(t)).not.toContain("docs@pc");
      await t.click(t.$('[data-fid="all"]'));
      await t.expand();
      expect(t.$('[data-callsign="docs@pc"] .own')!.textContent).toBe("anna");
      expect(t.$('[data-callsign="note@pc"] .own')!.textContent).toBe("anna");
      expect(t.$('[data-callsign="api@pc"] .own')).toBeNull();
    });

    it("5212 · впервые увиденный проект развёрнут, только если в нём ждут вас или сбой; свёрнутый остаётся свёрнутым после перезапуска; ответ на вопрос не сворачивает", async () => {
      const store = memoryStore({ key: KEY });
      const relay = relayWith();
      const t = await start({ relay, store });
      expect(t.$('.pj-t[data-proj="switchboard"]')!.getAttribute("aria-expanded")).toBe("true");
      expect(t.$('.pj-t[data-proj="pfarm"]')!.getAttribute("aria-expanded")).toBe("false");
      expect(t.$$('.pjs[data-proj="pfarm"] .bd-row')).toHaveLength(0);
      expect(t.$$('.pjs[data-proj="pfarm"] .lamps .sb-dot')).toHaveLength(1);
      // вопрос отвечен: проект остаётся развёрнутым
      relay.setRoster({ ...relay.roster, sessions: relay.roster.sessions.map((s) => (s.state === "waiting" ? { ...s, state: "busy" } : s)) });
      await flush(5);
      expect(t.$('.pj-t[data-proj="switchboard"]')!.getAttribute("aria-expanded")).toBe("true");
      await t.click(t.$('.pj-t[data-proj="switchboard"]'));
      const t2 = await start({ relay: relayWith(), store });
      expect(t2.$('.pj-t[data-proj="switchboard"]')!.getAttribute("aria-expanded")).toBe("false");
    });

    it("5213 · дочь — сразу под родителем с отступом (чьё: код — tree); без «Дочерних» — ровный список", async () => {
      const r = fleet();
      r.sessions[1] = { ...r.sessions[1], callsign: "tests@laptop" };
      const t = await start({ relay: Object.assign(new FakeRelay(r), { scoped: { global: { "fleet.projects": [{ id: "switchboard", name: "switchboard", sessions: ["migrate@laptop", "refactor@laptop", "build@build"] }] } } }) });
      // дочерняя без своего места — в проекте родителя, под ним
      expect(rows(t).slice(0, 4)).toEqual(["migrate@laptop", "refactor@laptop", "tests@laptop", "build@build"]);
      const kid = t.$('[data-callsign="tests@laptop"]')!;
      expect(kid.classList.contains("kid")).toBe(true);
      expect(kid.style.paddingLeft).toBe("32px");
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('[data-v="tree"]'));
      expect(t.$('[data-callsign="tests@laptop"]')!.classList.contains("kid")).toBe(false);
    });

    it("5214 · в строках нет слов о состоянии — только лампа; под списком нет строки «ещё N»; вторая строка: вопрос → сбой → профиль и модель (чьё: код — line)", async () => {
      const r = fleet();
      r.sessions[0] = { ...r.sessions[0], state: "failed", failed: { start: "нет слота" } };
      const t = await start({ relay: new FakeRelay(r) });
      const text = t.$(".bd-body")!.textContent!;
      for (const w of ["свободна", "остановлена", "работает", "ждёт", "Ещё", "ещё"]) expect(text).not.toContain(w);
      expect(t.$('[data-callsign="refactor@laptop"] .tx.f')!.textContent).toBe("start: нет слота");
      expect(t.$('[data-callsign="build@build"] .bd-t2')!.textContent).toBe("cisonnet");
      expect(t.$('[data-callsign="refactor@laptop"] .sb-dot.bad')).not.toBeNull();
    });

    it("5215 · Ctrl K: сессия находится по имени и по проекту, строк «проект» нет; открытие разворачивает свёрнутый проект", async () => {
      const t = await start({ wide: true, options: { beside: { card: "board" } } });
      t.relay.handlers["session.watch"] = () => ({ ok: true });
      t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      expect(t.$('.pj-t[data-proj="pfarm"]')!.getAttribute("aria-expanded")).toBe("false");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
      await flush();
      const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
      input.value = "pfarm";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toEqual(["api", "docs"]);
      input.value = "api";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flush(5);
      expect(location.hash).toBe("#card?callsign=api%40pc");
      expect(t.$('.pj-t[data-proj="pfarm"]')!.getAttribute("aria-expanded")).toBe("true");
      expect(t.$('.bd-row[aria-current="true"]')!.dataset.callsign).toBe("api@pc");
    });

    it("7308 · «Моё» — по адресу пропуска от gate: два устройства phone разных людей, первое в roster чужое", async () => {
      // источник: бэклог 3 нояб., слепой архитектор «Сессии, проекты и профили»: gate допускает phone~a и phone~b одновременно
      let board!: AppModule;
      const relay = relayWith();
      relay.roster.clients = ["phone~anna@mail", "phone~you@mail"];
      relay.you = "phone~you@mail";
      await stand([parts()[0], { manifest: boardM, module: (app) => (board = createBoard(app)) }, ...parts().slice(2)], { relay });
      await flush(5);
      const m = board.marks!;
      expect(m.mine("migrate@laptop")).toBe("задачу дали вы");
      expect(m.mine("docs@pc")).toBe("");
    });

    it("5216 · метки: mine — почему моя; project.machines — машины сессий проекта; project.current — последний открытый", async () => {
      let board!: AppModule;
      const t = await stand([parts()[0], { manifest: boardM, module: (app) => (board = createBoard(app)) }, ...parts().slice(2)], { relay: relayWith() });
      await flush(5);
      const m = board.marks!;
      expect(m.mine("migrate@laptop")).toBe("задачу дали вы");
      expect(m.mine("tests@pc")).toBe("открыла ваша refactor@laptop");
      expect(m.mine("docs@pc")).toBe("");
      expect(m["project.machines"]("switchboard")).toEqual(["laptop", "pc", "build"]);
      await t.click(t.$('[data-callsign="migrate@laptop"]'));
      expect(m["project.current"]()).toBe("switchboard");
    });

    it("5217 · телефон: в шапке «Работы» — поиск ядра и «+»; возврат из карточки — список на той же прокрутке", async () => {
      const t = await start();
      t.relay.handlers["session.watch"] = () => ({ ok: true });
      t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      expect(t.$("[data-find]")).not.toBeNull();
      expect(t.$("[data-new]")!.textContent).toBe("+");
      t.$(".bd-body")!.scrollTop = 120;
      await t.click(t.$('[data-callsign="migrate@laptop"]'));
      expect(location.hash).toContain("#");
      history.back();
      await flush(10);
      await new Promise((r) => setTimeout(r, 20));
      expect(t.$(".bd-body")!.scrollTop).toBe(120);
    });
  });

  describe("поиск на телефоне", () => {
    it("5218 · карточка из поиска, «Назад» — список, карточка снова не открывается; тот же запрос открывает её ещё раз", async () => {
      const t = await start();
      t.relay.handlers["session.watch"] = () => ({ ok: true });
      t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      const find = async () => {
        t.$("[data-find]")!.click();
        await flush();
        const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
        input.value = "api";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flush();
        document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await flush(5);
        await new Promise((r) => setTimeout(r, 5));
        expect(location.hash).toBe("#card?callsign=api%40pc");
      };
      await find();
      await t.click(t.button("‹"));
      await flush(5);
      expect(location.hash).not.toContain("card");
      expect(t.$(".bd-list")).not.toBeNull();
      await find();
    });
  });

  describe("фильтры", () => {
    it("5220 · внутри поля «или», между полями «и», пустое не сужает; «моё» в «Чьи» — whyMine; почта — та же цепочка, что у «моё»", async () => {
      const relay = relayWith({
        "web-board.filters": [
          { id: "a", name: "Две машины", machines: ["laptop", "build"] },
          { id: "b", name: "Моё на pc", who: ["mine"], machines: ["pc"] },
          { id: "c", name: "Анна", who: ["~anna@mail"] },
          { id: "d", name: "Ждут", states: ["waiting", "failed"] },
        ],
      });
      const t = await start({ relay });
      const n = (id: string) => t.$(`[data-fid="${id}"] .n`)!.textContent;
      expect(n("a")).toBe("3");
      expect(n("b")).toBe("2");
      expect(n("c")).toBe("2");
      expect(n("d")).toBe("1");
      expect(n("mine")).toBe("5");
      expect(n("all")).toBe("7");
      await t.click(t.$('[data-fid="c"]'));
      await t.expand();
      expect(rows(t).sort()).toEqual(["docs@pc", "note@pc"]);
    });

    it("5221 · фильтр сохранён на одном устройстве — есть на другом той же почты; выбранный у каждого свой; пишется только web-board.filters", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$(".fc.add"));
      const name = t.$<HTMLInputElement>('[data-editor] [data-f="name"]')!;
      name.value = "pfarm";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await t.click(t.$('[data-field="projects"] [data-v="pfarm"]'));
      expect(t.$(".fe-n")!.textContent).toBe("подходит 2 сессии · 1 проект");
      await t.click(t.$('[data-act="fsave"]'));
      await flush(5);
      expect(t.$("[data-editor]")).toBeNull();
      expect(t.$('.fc[aria-selected="true"]')!.textContent).toContain("pfarm");
      expect(projects(t)).toEqual(["pfarm"]);
      expect(relay.sent("prefs.set").map((f) => f.name)).toEqual(["web-board.filters"]);
      const other = await start({ relay: Object.assign(new FakeRelay(fleet()), { values: relay.values }) });
      expect(other.$$(".fscroll .fc").map((x) => x.firstChild!.textContent)).toEqual(["Моё", "Всё", "pfarm"]);
      expect(other.$('.fc[aria-selected="true"]')!.dataset.fid).toBe("mine");
    });

    it("5222 · «Моё» и «Всё» не меняются и не удаляются; удалённый выбранный — устройство на «Моё»", async () => {
      const relay = relayWith({ "web-board.filters": [{ id: "f1", name: "GPU", machines: ["pc"] }] });
      const t = await start({ relay });
      await t.click(t.$('[data-fid="mine"]'));
      expect(t.$("[data-editor]")).toBeNull();
      await t.click(t.$('[data-fid="f1"]'));
      await t.click(t.$('[data-fid="f1"]'));
      await t.click(t.$('[data-act="fdel"]'));
      await flush(5);
      expect(chips(t)).toEqual(["mine", "all"]);
      expect(t.$('.fc[aria-selected="true"]')!.dataset.fid).toBe("mine");
      expect(relay.values["web-board.filters"]).toEqual([]);
    });

    it("5223 · окно фильтра — одна строка поиска: поле без совпадений свёрнуто, выбранное видно всегда; имена — вместо адреса", async () => {
      const relay = withLabels({ machines: { pc: "Домашний ПК" } });
      const t = await start({ relay });
      await t.click(t.$(".fc.add"));
      await t.click(t.$('[data-field="projects"] [data-v="pfarm"]'));
      expect(t.$('[data-field="machines"] [data-v="pc"]')!.textContent).toBe("Домашний ПК");
      const q = t.$<HTMLInputElement>('[data-editor] [data-f="q"]')!;
      q.value = "домашний";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$$("[data-field]").map((x) => x.dataset.field)).toEqual(["projects", "machines"]);
      expect(t.$$('[data-field="projects"] [data-v]').map((x) => x.dataset.v)).toEqual(["pfarm"]);
      expect(t.$<HTMLInputElement>('[data-editor] [data-f="q"]')).toBe(q);
    });

    it("5224 · ряд: row [f1, mine, all], filters f1, f2 → GPU, Моё, Всё, f2; номер удалённого пропускается; перестановка пишет только row", async () => {
      const own = [{ id: "f1", name: "GPU" }, { id: "f2", name: "Ждут" }];
      const relay = relayWith({ "web-board.filters": own, "web-board.row": ["gone", "f1", "mine", "all"] });
      const t = await start({ relay });
      expect(chips(t)).toEqual(["f1", "mine", "all", "f2"]);
      t.$('[data-fid="mine"]')!.focus();
      t.$('[data-fid="mine"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
      await flush(5);
      expect(chips(t)).toEqual(["f1", "all", "mine", "f2"]);
      expect(document.activeElement).toBe(t.$('[data-fid="mine"]'));
      expect(relay.sent("prefs.set").map((f) => f.name)).toEqual(["web-board.row"]);
    });
  });

  describe("порядок проектов", () => {
    it("6401 · сессия занята → ждёт → свободна: порядок строк и проектов тот же на каждом шаге (слово пользователя)", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$('.pj-t[data-proj="pfarm"]'));
      await t.click(t.$(".fc[data-fid=all]"));
      const was = [projects(t), rows(t)];
      for (const state of ["busy", "waiting", "idle", "failed"]) {
        const r = fleet();
        r.sessions = r.sessions.map((x) => (x.callsign === "build@build" ? { ...x, state } : x));
        relay.setRoster(r);
        await flush(5);
        expect([projects(t), rows(t)]).toEqual(was);
      }
    });

    it("6402 · стрелки на ручке переставляют проекты; фокус на ручке; «Без проекта» последний и без ручки", async () => {
      const relay = relayWith();
      const r = fleet();
      r.sessions.push({ callsign: "free@pc", state: "idle", dir: "~", by: "phone~you@mail" } as never);
      relay.setRoster(r);
      const t = await start({ relay });
      expect(projects(t).at(-1)).toBe("~");
      expect(t.$('.grip[data-proj="~"]')).toBeNull();
      const grip = t.$('.grip[data-proj="switchboard"]')!;
      grip.focus();
      await press(grip, "ArrowDown");
      await flush(5);
      expect(projects(t)).toEqual(["pfarm", "switchboard", "~"]);
      expect((relay.scoped.global["fleet.projects"] as Array<{ id: string }>).map((x) => x.id)).toEqual(["pfarm", "notes", "switchboard"]);
      expect((document.activeElement as HTMLElement).dataset.proj).toBe("switchboard");
      // пишется только запись флота
      expect(relay.sent("prefs.set").every((f) => f.scope === "global")).toBe(true);
    });

    it("6403 · ⠿ Enter — меню: имя и «Удалить»; 3 сессии уходят в «Без проекта», номера нет в фильтрах, к флоту ни одного запроса", async () => {
      const relay = relayWith({ "web-board.filters": [{ id: "f1", name: "Ф", projects: ["switchboard", "pfarm"] }] });
      const t = await start({ relay });
      await press(t.$('.grip[data-proj="pfarm"]')!, "Enter");
      await flush(3);
      const name = t.$<HTMLInputElement>('[data-f="project-name"]')!;
      expect(name.value).toBe("pfarm");
      name.value = "Ферма";
      await press(name, "Enter");
      await flush(5);
      expect(t.$('.pjs[data-proj="pfarm"] .nm')!.textContent).toBe("Ферма");
      await press(t.$('.grip[data-proj="pfarm"]')!, "Enter");
      await flush(3);
      const before = relay.sent("session.open").length;
      await t.click(t.$('[data-act="project-remove"]'));
      await flush(5);
      expect((relay.scoped.global["fleet.projects"] as Array<{ id: string }>).map((x) => x.id)).not.toContain("pfarm");
      expect((relay.values["web-board.filters"] as Array<{ projects: string[] }>)[0].projects).toEqual(["switchboard"]);
      expect(relay.sent("session.open").length).toBe(before);
      await t.click(t.$(".fc[data-fid=all]"));
      await flush(3);
      expect(projects(t).at(-1)).toBe("~");
      expect(t.$('.pjs[data-proj="~"]')).not.toBeNull();
    });

    it("6404 · «Новый проект» — последняя строка; пустой проект виден; проект со скрытыми фильтром сессиями скрыт", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$('[data-act="project-new"]'));
      await flush(2);
      const i = t.$<HTMLInputElement>('[data-f="project-new"]')!;
      i.value = "Пустой";
      await press(i, "Enter");
      await flush(5);
      expect(projects(t)).toContain("пустой");
      // в «Моё» нет сессий notes, она скрыта; пустой виден
      expect(projects(t)).not.toContain("notes");
      await t.click(t.$(".fc[data-fid=all]"));
      await flush(3);
      expect(projects(t)).toContain("notes");
    });

    it("6405 · «+» у проекта несёт его номер; команда после открытия ставит сессию в конец проекта", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$('.pj-add[data-proj="pfarm"]'));
      await flush(3);
      expect(location.hash).toContain("project=pfarm");
    });

    it("5240 · запись — свежий prefs.get и правка: другое устройство дописало фильтр, после моей правки остались оба", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      relay.values["web-board.filters"] = [{ id: "phone", name: "С телефона" }];
      await t.click(t.$(".fc.add"));
      const name = t.$<HTMLInputElement>('[data-editor] [data-f="name"]')!;
      name.value = "С пульта";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await t.click(t.$('[data-act="fsave"]'));
      await flush(5);
      expect((relay.values["web-board.filters"] as Array<{ name: string }>).map((f) => f.name)).toEqual(["С телефона", "С пульта"]);
    });

    it("5241 · три быстрые правки подряд: на экране сразу, запросов — один prefs.get и один prefs.set; записаны все три", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      const gets = relay.sent("prefs.get").length;
      for (const k of ["switchboard", "pfarm", "switchboard"]) {
        t.$(`.grip[data-proj="${k}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      }
      expect(projects(t)).toEqual(["pfarm", "switchboard"]);
      await flush(5);
      expect(relay.sent("prefs.get").length - gets).toBe(1);
      expect(relay.sent("prefs.set")).toHaveLength(1);
      expect((relay.scoped.global["fleet.projects"] as Array<{ id: string }>).map((x) => x.id).indexOf("pfarm")).toBeLessThan((relay.scoped.global["fleet.projects"] as Array<{ id: string }>).map((x) => x.id).indexOf("switchboard"));
    });

    it("5245 · выбранный свой фильтр остаётся при отказе prefs: виден «Моё», выбор устройства не стёрт; ответ с фильтром — он снова выбран", async () => {
      const store = memoryStore({ key: KEY, flt: "f1" });
      const relay = relayWith({ "web-board.filters": [{ id: "f1", name: "GPU" }] });
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const ok = relay.handlers["prefs.get"];
      relay.handlers["prefs.get"] = () => ({ ok: false, error: "offline" });
      const t = await start({ relay, store });
      expect(t.$('.fc[aria-selected="true"]')!.dataset.fid).toBe("mine");
      expect(await store.get("flt")).toBe("f1");
      if (ok) relay.handlers["prefs.get"] = ok;
      else delete relay.handlers["prefs.get"];
      await t.run.hide();
      await t.run.show();
      await flush(10);
      expect(t.$('.fc[aria-selected="true"]')!.dataset.fid).toBe("f1");
    });

    it("5242 · prefs отказал: «Моё» и «Всё» работают, своих нет; изменение — отказ словом, prefs.set не уходит", async () => {
      const relay = relayWith();
      relay.handlers["prefs.get"] = () => ({ ok: false, error: "not_user" });
      const t = await start({ relay });
      expect(chips(t)).toEqual(["mine", "all"]);
      expect(rows(t)).toContain("migrate@laptop");
      await t.click(t.$('[data-act="project-new"]'));
      await flush(2);
      const i = t.$<HTMLInputElement>('[data-f="project-new"]')!;
      i.value = "Новый";
      await press(i, "Enter");
      await flush(5);
      expect(t.$(".sb-toast")!.textContent).toBe("Настройка не сохранилась: not_user");
      expect(relay.sent("prefs.set")).toHaveLength(0);
    });

    it("5243 · уход со страницы посреди записи: остановка модуля ждёт, prefs.set ушёл", async () => {
      const relay = relayWith();
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const t = await start({ relay });
      const g = t.$('.grip[data-proj="pfarm"]')!;
      g.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await t.run.hide();
      expect((relay.scoped.global["fleet.projects"] as Array<{ id: string }>)[0].id).toBe("pfarm");
    });

    it("5244 · закрепление сессии: чужая — «Закрепить» в карточке; закреплена — в «Моём» с причиной и значком, у почты", async () => {
      const relay = relayWith();
      relay.handlers["session.watch"] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      const t = await start({ relay, url: "/#card?callsign=docs%40pc&tab=info" });
      await t.click(t.$('[data-screen="board.pin"]'));
      await flush(5);
      expect(relay.values["web-board.pins"]).toEqual(["docs@pc"]);
      expect(t.$('[data-screen="board.pin"]')).toBeNull();
      expect(t.$('[data-screen="board.unpin"]')).not.toBeNull();
      await t.go("#sessions");
      await t.expand();
      expect(t.$('[data-callsign="docs@pc"] .bd-pin')).not.toBeNull();
      await t.go("#card?callsign=refactor%40laptop&tab=info");
      expect(t.$('[data-screen="board.pin"]')).toBeNull();
    });
  });

  describe("вид списка", () => {
    it("5250 · вид — на устройстве, на сервер не уходит; каждая единица выключается отдельно; переживает перезапуск; «Вернуть» — все на месте", async () => {
      const store = memoryStore({ key: KEY });
      const relay = relayWith();
      const t = await start({ relay, store });
      await t.click(t.$(".fc.vw"));
      expect(t.$(".fc.vw")!.getAttribute("aria-expanded")).toBe("true");
      const units = [
        ['[data-v="at"]', ".bd-at"],
        ['[data-v="lamp"]', ".bd-row .sb-dot"],
        ['[data-v="prof"]', ".bd-t2 .bd-pill"],
        ['[data-v="grip"]', ".grip"],
        ['[data-v="add"]', ".pj-add"],
        ['[data-v="fcount"]', ".fc .n"],
        ['[data-v="badge"]', ".bd-row .sb-badge"],
      ];
      for (const [btn, sel] of units) {
        await t.click(t.$(btn));
        expect(t.$(sel)).toBeNull();
      }
      expect(relay.sent("prefs.set")).toHaveLength(0);
      expect(await store.get("view")).toMatchObject({ at: false, lamp: false });
      const t2 = await start({ relay: relayWith(), store });
      expect(t2.$(".bd-at")).toBeNull();
      await t2.click(t2.$(".fc.vw"));
      await t2.click(t2.$('[data-act="view-reset"]'));
      expect(t2.$(".bd-at")).not.toBeNull();
      expect(t2.$(".grip")).not.toBeNull();
    });

    it("5251 · без «По проектам» — плоский список в любом фильтре в порядке проектов, проект — в строке; «По машинам» недоступно", async () => {
      const t = await start();
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('[data-v="projects"]'));
      expect(t.$(".pjs")).toBeNull();
      expect(rows(t).slice(0, 3)).toEqual(["migrate@laptop", "refactor@laptop", "tests@pc"]);
      expect(t.$('[data-callsign="api@pc"] .prj')!.textContent).toBe("pfarm");
      expect(t.$<HTMLButtonElement>('[data-v="group"]')!.disabled).toBe(true);
    });

    it("5252 · «По машинам»: лёгкие группы внутри проекта, машина в строке не повторяется", async () => {
      const t = await start();
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('[data-v="group"]'));
      expect(t.$$('.pjs[data-proj="switchboard"] .mgrp').map((x) => x.dataset.group)).toEqual(["build", "laptop", "pc"]);
      expect(t.$(".bd-at")).toBeNull();
    });

    it("5253 · панель не прячет список и не перерисовывается целиком: кнопка остаётся той же; на телефоне вкладки разделов уступают ей место", async () => {
      const t = await start();
      await t.click(t.$(".fc.vw"));
      expect(t.$(".bd-body")).not.toBeNull();
      const b = t.$('[data-v="dense"]');
      await t.click(b);
      expect(t.$('[data-v="dense"]')).toBe(b);
      expect(t.$(".bd-list")!.classList.contains("dense")).toBe(true);
    });
  });

  describe("имена", () => {
    it("7235 · страница вернулась: свёрнутость проектов из другой вкладки прочитана заново", async () => {
      // чьё: код — повторный start модулей при возвращении до 4 нояб.; start теперь один раз
      const store = memoryStore({ key: KEY });
      const relay = relayWith();
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const t = await start({ relay, store });
      expect(t.$('.pj-t[data-proj="switchboard"]')!.getAttribute("aria-expanded")).toBe("true");
      await t.run.hide();
      store.data.collapsed = { switchboard: true };
      await t.run.show();
      await flush();
      expect(t.$('.pj-t[data-proj="switchboard"]')!.getAttribute("aria-expanded")).toBe("false");
    });

    it("5260 · заданное имя — вместо адреса в строке и поиске; поиск находит и по имени; адреса в основном виде нет", async () => {
      const relay = withLabels({ sessions: { "migrate@laptop": "Переезд" }, machines: { laptop: "Домашний ПК" } });
      const t = await start({ relay });
      const row = t.$('[data-callsign="migrate@laptop"]')!;
      expect(row.querySelector(".bd-cs")!.textContent).toBe("Переезд");
      expect(row.querySelector(".bd-cs")!.classList.contains("hum")).toBe(true);
      expect(row.querySelector(".bd-at")!.textContent).toBe("Домашний ПК");
      expect(row.textContent).not.toContain("migrate@laptop");
      expect(t.$('[data-callsign="tests@pc"] .bd-cs')!.textContent).toBe("tests");
      expect(t.$('[data-callsign="tests@pc"] .bd-at')!.textContent).toBe("@pc");
      t.$("[data-find]")!.click();
      await flush();
      const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
      input.value = "переезд";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toEqual(["Переезд"]);
    });
  });

  describe("видимое (чьё: код)", () => {
    const UNITS: Array<[string, string, string]> = [
      ["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"],
      ["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"],
      ["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"],
      ["fcount", "Число", "Число сессий в фильтре"],
    ];

    it("V-B1 · панель вида: группы, подпись и полное название каждой единицы; телефон — «Готово» и нет «Шапки»; пульт — «✕» и группа шапки", async () => {
      const t = await start();
      await t.click(t.$(".fc.vw"));
      const panel = t.$(".bd-vw")!;
      expect([panel.getAttribute("role"), panel.getAttribute("aria-label")]).toEqual(["dialog", "Вид списка"]);
      expect(panel.querySelector(".vw-h b")!.textContent).toBe("Вид списка");
      for (const title of ["Список", "Строка", "Проект", "Фильтры"]) expect(panel.textContent).toContain(title);
      for (const [k, label, full] of UNITS) {
        const b = t.$(`.bd-vw [data-v="${k}"]`)!;
        expect([b.textContent, b.getAttribute("aria-label")]).toEqual([label, full]);
      }
      expect(t.$('.bd-vw [data-v="haddr"]')).toBeNull();
      expect(t.button("Готово")).not.toBeNull();
      await t.click(t.button("Готово"));
      expect(t.$(".bd-vw")).toBeNull();

      const w = await start({ wide: true, options: { beside: { card: "board" } } });
      await w.click(w.$(".fc.vw"));
      for (const [k, label, full] of [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]]) {
        const b = w.$(`.bd-vw [data-v="${k}"]`)!;
        expect([b.textContent, b.getAttribute("aria-label")]).toEqual([label, full]);
      }
      expect(w.$(".bd-vw")!.textContent).toContain("Шапка");
      await w.click(w.$('.bd-vw [aria-label="Закрыть"]'));
      expect(w.$(".bd-vw")).toBeNull();
    });

    it("V-B2 · ряд и окно фильтра: названия, поля, поиск без совпадений «ничего»; Esc и клик мимо закрывают", async () => {
      const t = await start();
      expect(t.$(".fscroll")!.getAttribute("role")).toBe("tablist");
      expect(t.$(".fscroll")!.getAttribute("aria-label")).toBe("Фильтры");
      expect(t.$(".fc.add")!.getAttribute("aria-label")).toBe("Новый фильтр");
      expect(t.$(".fc.vw")!.getAttribute("aria-label")).toBe("Вид списка");
      await t.click(t.$(".fc.add"));
      const dlg = t.$('[data-editor] [role="dialog"]')!;
      expect(dlg.getAttribute("aria-label")).toBe("Фильтр");
      expect(dlg.querySelector(".fe-h b")!.textContent).toBe("Новый фильтр");
      expect(t.$$(".fe-l b").map((x) => x.textContent)).toEqual(["Чьи", "Проекты", "Машины", "Профили", "Состояние"]);
      expect(t.$('[data-field="who"] [data-v="mine"]')!.textContent).toBe("моё");
      expect(t.$('[data-field="who"] [data-v="~anna@mail"]')!.textContent).toBe("anna@mail");
      expect(t.$('[data-field="states"] [data-v="waiting"]')).not.toBeNull();
      const name = t.$<HTMLInputElement>('[data-f="name"]')!;
      expect([name.placeholder, name.getAttribute("aria-label")]).toEqual(["Имя фильтра", "Имя фильтра"]);
      expect(t.$<HTMLButtonElement>('[data-act="fsave"]')!.disabled).toBe(true);
      const q = t.$<HTMLInputElement>('[data-f="q"]')!;
      expect([q.placeholder, q.getAttribute("aria-label")]).toEqual(["Найти: люди, проекты, машины…", "Найти в фильтре"]);
      q.value = "нет такого";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$(".fe-none")!.textContent).toBe("ничего");
      await press(q, "Escape");
      expect(t.$("[data-editor]")).toBeNull();
      await t.click(t.$(".fc.add"));
      await t.click(t.$("[data-editor]"));
      expect(t.$("[data-editor]")).toBeNull();
      await t.click(t.$(".fc.add"));
      await t.click(t.button("Отмена"));
      expect(t.$("[data-editor]")).toBeNull();
    });

    it("V-B3 · проект: названия ручки, «+», полей; пусто — «в «Моё» сессий нет»; Esc в меню и новом проекте не сохраняет", async () => {
      const t = await start();
      expect(t.$('.grip[data-proj="pfarm"]')!.getAttribute("aria-label")).toBe("Проект pfarm: перетащить, стрелки или нажать — имя и удаление");
      expect(t.$('.pj-add[data-proj="pfarm"]')!.getAttribute("aria-label")).toBe("Новая сессия в pfarm");
      await press(t.$('.grip[data-proj="pfarm"]')!, " ");
      const name = t.$<HTMLInputElement>('[data-f="project-name"]')!;
      expect(name.getAttribute("aria-label")).toBe("Имя проекта");
      name.value = "Другое";
      await press(name, "Escape");
      expect(t.$('[data-f="project-name"]')).toBeNull();
      expect(t.$('.pjs[data-proj="pfarm"] .nm')!.textContent).toBe("pfarm");
      await t.click(t.$('[data-act="project-new"]'));
      const fresh = t.$<HTMLInputElement>('[data-f="project-new"]')!;
      expect(fresh.getAttribute("aria-label")).toBe("Имя нового проекта");
      fresh.value = "Нет";
      await press(fresh, "Escape");
      expect(projects(t)).not.toContain("нет");
      const empty = await start({ relay: Object.assign(new FakeRelay({ ...fleet(), sessions: [] }), { values: {}, scoped: { global: { "fleet.projects": [] } } }) });
      expect(empty.$(".bd-empty")!.textContent).toBe("в «Моё» сессий нет");
      expect(empty.$('[data-act="project-new"]')!.textContent).toBe("Новый проект");
      await empty.click(empty.$(".fc.vw"));
      await empty.click(empty.$('[data-v="projects"]'));
      expect(empty.$(".lst.flat .bd-empty")!.textContent).toBe("в «Моё» сессий нет");
    });

    it("V-B4 · метка mine: закреплена вами, открыли вы; поиск: подпись машины и папки; пины — раньше причин", async () => {
      let board!: AppModule;
      const r = fleet();
      r.sessions.push({ callsign: "opened@pc", state: "idle", parent: "pult~you@mail", by: "laptop~anna@mail" } as never);
      const relay = Object.assign(new FakeRelay(r), { values: { "web-board.pins": ["docs@pc", "migrate@laptop"] }, scoped: { global: { "fleet.projects": PROJECTS() } } });
      await stand([parts()[0], { manifest: boardM, module: (app) => (board = createBoard(app)) }, ...parts().slice(2)], { relay });
      await flush(5);
      relay.you = "phone~you@mail";
      expect(board.marks!.mine("docs@pc")).toBe("закреплена вами");
      expect(board.marks!.mine("migrate@laptop")).toBe("закреплена вами");
      expect(board.marks!.mine("opened@pc")).toBe("открыли вы");
      const t = await start();
      t.$("[data-find]")!.click();
      await flush();
      const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
      input.value = "api";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(document.querySelector(".sb-palit")!.textContent).toContain("@pc · папка pfarm");
    });

    it("V-B5 · уход с поля сохраняет имя проекта и новый проект; «Новая» и «+» в шапке — новая сессия; «Удалить» не теряет фокус", async () => {
      const relay = relayWith();
      const t = await start({ relay });
      await press(t.$('.grip[data-proj="pfarm"]')!, "Enter");
      const name = t.$<HTMLInputElement>('[data-f="project-name"]')!;
      name.value = "Ферма";
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flush(5);
      expect(t.$('.pjs[data-proj="pfarm"] .nm')!.textContent).toBe("Ферма");
      expect(t.$('[data-f="project-name"]')).toBeNull();
      await t.click(t.$('[data-act="project-new"]'));
      const fresh = t.$<HTMLInputElement>('[data-f="project-new"]')!;
      fresh.value = "Уход";
      fresh.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flush(5);
      expect(projects(t)).toContain("уход");
      await press(t.$('.grip[data-proj="pfarm"]')!, "Enter");
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      t.$('[data-act="project-remove"]')!.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      await t.click(t.$("[data-new]"));
      expect(location.hash).toBe("#open");

      const w = await start({ wide: true, options: { beside: { card: "board" } } });
      const open = w.$(".bd-lh [data-new]")!;
      expect(open.textContent).toBe("Новая");
      expect(w.$(".bd-lh b")!.textContent).toBe("Работа");
      await w.click(open);
      expect(location.hash).toBe("#open");
    });

    it("V-B6 · шапка карточки настраивается в панели вида: адрес виден при имени, владелец и профиль прячутся", async () => {
      const relay = withLabels({ sessions: { "docs@pc": "Доки" } });
      relay.handlers["session.watch"] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      const store = memoryStore({ key: KEY });
      const t = await start({ relay, store, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=docs%40pc" });
      expect(t.$(".cw-real")).toBeNull();
      expect(t.$(".cw-meta")!.textContent).toBe("anna@mail");
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('.bd-vw [data-v="haddr"]'));
      await t.click(t.$('.bd-vw [data-v="howner"]'));
      expect(t.$(".cw-real")!.textContent).toBe("docs@pc");
      expect(t.$(".cw-meta")!.textContent).toBe("");
      expect(await store.get("card.head")).toMatchObject({ haddr: true, howner: false });
    });
  });
});

describe("Работа: открытая сессия и первый показ", () => {
  function fleet(): Roster {
    const r = homeRoster();
    r.sessions = [
      { callsign: "migrate@laptop", state: "waiting", dir: "~/Projects/switchboard", by: "phone~you@mail" },
      { callsign: "api@pc", state: "idle", dir: "~/projects/pfarm", by: "phone~you@mail" },
      { callsign: "note@pc", state: "idle", dir: "~/notes", by: "phone~you@mail" },
    ];
    r.clients = ["phone~you@mail"];
    return r;
  }
  const PROJECTS = () => [
    { id: "switchboard", name: "switchboard", sessions: ["migrate@laptop"] },
    { id: "pfarm", name: "pfarm", sessions: ["api@pc"] },
  ];
  function relayWith(r = fleet()) {
    const relay = new FakeRelay(r);
    relay.scoped = { global: { "fleet.projects": PROJECTS() } };
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.unwatch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    return relay;
  }

  /** Приложение и модуль «Работы»: метка project.current видна снаружи. */
  async function start(o: Parameters<typeof stand>[1] = {}) {
    let board!: AppModule;
    const list: AppPart[] = [
      { manifest: boardM, module: (app) => (board = createBoard(app)) },
      { manifest: cardM, module: createCard },
      { manifest: chatM, module: createChat },
      { manifest: askM, module: createAsk },
      { manifest: alertsM, module: createAlerts({}) },
    ];
    const t = await stand(list, { relay: relayWith(), ...o });
    await flush(5);
    return { ...t, current: () => board.marks!["project.current"]() };
  }
  const expanded = (t: { $: (s: string) => Element | null }, id: string) => t.$(`.pj-t[data-proj="${id}"]`)?.getAttribute("aria-expanded");

  describe("проект открытой сессии", () => {
    it("6971 · открыта сессия свёрнутого проекта: проект развёрнут и последний, строка видна", async () => {
      // источник: чьё: код
      const store = memoryStore({ key: KEY });
      const t = await start({ store, wide: true, options: { beside: { card: "board" } } });
      expect(expanded(t, "pfarm")).toBe("false");
      await t.go("#card?callsign=api%40pc");
      expect(expanded(t, "pfarm")).toBe("true");
      expect(t.current()).toBe("pfarm");
      expect(t.$('.bd-row[data-callsign="api@pc"]')).not.toBeNull();
      expect((await store.get<Record<string, boolean>>("collapsed"))!.pfarm).toBe(false);
    });

    it("6972 · ответа настроек ещё нет: сессия ждёт и находит проект после ответа", async () => {
      // источник: чьё: код
      const relay = relayWith();
      const replies: Array<{ id: string; scope?: unknown }> = [];
      relay.handlers["prefs.get"] = () => undefined;
      const t = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
      expect(t.current()).toBeNull();
      for (const f of relay.sent("prefs.get")) replies.push(f as never);
      for (const f of replies) relay.reply(f.id, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
      await flush(10);
      expect(t.current()).toBe("pfarm");
      expect(expanded(t, "pfarm")).toBe("true");
    });

    it("6973 · проект уже развёрнут: последний в метке, раздел collapsed не пишется", async () => {
      // источник: чьё: код
      const store = memoryStore({ key: KEY });
      const t = await start({ store, wide: true, options: { beside: { card: "board" } } });
      await t.click(t.$('.pj-t[data-proj="pfarm"]'));
      const before = JSON.stringify(await store.get("collapsed"));
      const set = vi.spyOn(store, "set");
      await t.go("#card?callsign=api%40pc");
      expect(t.current()).toBe("pfarm");
      expect(set.mock.calls.filter(([k]) => k === "collapsed")).toEqual([]);
      expect(JSON.stringify(await store.get("collapsed"))).toBe(before);
    });

    it("6974 · сессия без проекта: «Без проекта» развёрнут, project.current пусто", async () => {
      // источник: факт — «Без проекта» не проект: «последний проект» его не называет
      const t = await start({ wide: true, options: { beside: { card: "board" } } });
      await t.go("#card?callsign=api%40pc");
      expect(t.current()).toBe("pfarm");
      await t.go("#card?callsign=note%40pc");
      expect(t.current()).toBeNull();
      expect(t.$('.bd-row[data-callsign="note@pc"]')).not.toBeNull();
    });

    it("6975 · переход не на сессию: project.current прежний; ждавшая сессия проект не разворачивает", async () => {
      // источник: чьё: код
      const t = await start({ wide: true, options: { beside: { card: "board" } } });
      await t.go("#card?callsign=api%40pc");
      await t.go("#sessions");
      expect(t.current()).toBe("pfarm");

      const relay = relayWith();
      relay.handlers["prefs.get"] = () => undefined;
      const t2 = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
      await t2.go("#sessions");
      for (const f of relay.sent("prefs.get")) relay.reply(f.id!, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
      await flush(10);
      expect(t2.current()).toBeNull();
      expect(expanded(t2, "pfarm")).toBe("false");
    });

    it("6976 · настройки отказали: список рисуется, проект сессии развёрнут, ожидания нет", async () => {
      // источник: факт — отказ тоже ответ; устав — у всех операций лимит
      const relay = relayWith();
      relay.handlers["prefs.get"] = () => ({ ok: false, error: "not_user" });
      const t = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
      expect(t.$('.bd-row[data-callsign="api@pc"]')).not.toBeNull();
    });

    it("6977 · связи нет: список рисуется без ожидания; связь открылась — prefs.get обеих областей", async () => {
      // источник: факт — связи нет вовсе, рисуем встроенное; устав — клиенты переподключаются
      const relay = relayWith();
      relay.handlers["prefs.get"] = () => undefined;
      const t = await start({ relay });
      expect(t.$$(".bd-row")).toHaveLength(0);
      relay.handlers["prefs.get"] = (f) => ({ ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
      const before = relay.sent("prefs.get").length;
      relay.drop();
      await flush(2);
      expect(t.$$(".bd-row").length + t.$$(".pjs").length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 20));
      await flush(10);
      const after = relay.sent("prefs.get").slice(before);
      expect(after.map((f) => f.scope ?? "user").sort()).toEqual(["global", "user"]);
    });
  });

  describe("окна доски", () => {
    const press = (el: Element | null, key: string) => el!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    it("7260 · новый фильтр: фокус на имени; правка своего — фокус не трогает", async () => {
      // источник: чьё: код — у нового имя вводится первым, у своего обычно меняют условия
      const t = await start();
      await t.click(t.$(".fc.add"));
      expect(document.activeElement).toBe(t.$('[data-editor] [data-f="name"]'));
      const name = t.$<HTMLInputElement>('[data-editor] [data-f="name"]')!;
      name.value = "Ф";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await t.click(t.$('[data-act="fsave"]'));
      await flush(5);
      (document.activeElement as HTMLElement).blur();
      await t.click(t.$('[data-fid="mine"]'));
      await t.click(t.$('[data-fid^="f"]'));
      await t.click(t.$('[data-fid^="f"]'));
      expect(t.$("[data-editor]")).not.toBeNull();
      expect(document.activeElement).not.toBe(t.$('[data-editor] [data-f="name"]'));
    });

    it("7261 · меню проекта: фокус на имени", async () => {
      // источник: чьё: код — переименование с клавиатуры
      const t = await start();
      press(t.$('.grip[data-proj="pfarm"]'), "Enter");
      await flush(3);
      expect(document.activeElement).toBe(t.$('[data-f="project-name"]'));
    });

    it("7262 · окно фильтра открыто, сессия сменила состояние: «подходит» считает заново", async () => {
      // источник: факт — строка показывает, сколько сессий подойдёт сейчас; чипы при этом не меняются
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$(".fc.add"));
      await t.click(t.$('[data-field="states"] [data-v="waiting"]'));
      expect(t.$(".fe-n")!.textContent).toBe("подходит 1 сессия · 1 проект");
      const r = fleet();
      r.sessions[1].state = "waiting";
      relay.setRoster(r);
      await flush(5);
      expect(t.$(".fe-n")!.textContent).toBe("подходит 2 сессии · 2 проекта");
    });
  });

  describe("первый показ", () => {
    it("6978 · настройки не ответили: collapsed не пишется; после ответа — решение по проектам из ответа", async () => {
      // источник: факт — первый рисунок ждёт ответа prefs
      const store = memoryStore({ key: KEY });
      const relay = relayWith();
      relay.handlers["prefs.get"] = () => undefined;
      const t = await start({ relay, store });
      relay.setRoster(fleet());
      await flush(5);
      expect(await store.get("collapsed")).toBeUndefined();
      for (const f of relay.sent("prefs.get")) relay.reply(f.id!, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
      await flush(10);
      expect(await store.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });
      expect(expanded(t, "switchboard")).toBe("true");
    });

    it("6979 · список не на экране или вид без проектов: collapsed не пишется", async () => {
      // источник: факт — первый показ проекта запоминается, только пока его видно
      const store = memoryStore({ key: KEY });
      const relay = relayWith();
      await start({ relay, store, url: "/#card?callsign=note%40pc" });
      relay.setRoster(fleet());
      await flush(5);
      expect(await store.get<Record<string, boolean>>("collapsed")).not.toHaveProperty("switchboard");

      const store2 = memoryStore({ key: KEY, view: { projects: false } });
      await start({ store: store2 });
      expect(await store2.get("collapsed")).toBeUndefined();
    });

    it("7263 · широкий вид: карточка рядом со списком — первый показ запомнен, у телефона — только при возврате к списку", async () => {
      // источник: факт — первый показ проекта запоминается, только пока его видно
      const wide = memoryStore({ key: KEY });
      await start({ store: wide, wide: true, options: { beside: { card: ["board"] } }, url: "/#card?callsign=note%40pc" });
      expect(await wide.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });

      const phone = memoryStore({ key: KEY });
      const t = await start({ store: phone, url: "/#card?callsign=note%40pc" });
      expect(await phone.get<Record<string, boolean>>("collapsed")).not.toHaveProperty("switchboard");
      await t.go("#sessions");
      await flush(5);
      expect(await phone.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });
    });

    it("6980 · новый проект в roster: развёрнут, если в нём ждут; прежние как оставил человек", async () => {
      // источник: факт — дальше как оставил человек
      const relay = relayWith();
      const t = await start({ relay });
      await t.click(t.$('.pj-t[data-proj="switchboard"]'));
      await t.click(t.$('.pj-t[data-proj="pfarm"]'));
      relay.scoped.global["fleet.projects"] = [...PROJECTS(), { id: "fresh", name: "fresh", sessions: ["fresh@pc"] }];
      relay.drop();
      // запись проектов пришла раньше roster: пока сессий проекта нет, решение о первом показе не принимается (упало в CI 4 нояб.)
      await vi.waitFor(() => expect(expanded(t, "fresh")).not.toBeUndefined());
      const r = fleet();
      r.sessions.push({ callsign: "fresh@pc", state: "waiting", dir: "~/fresh", by: "phone~you@mail" });
      relay.setRoster(r);
      await vi.waitFor(() => expect(expanded(t, "fresh")).toBe("true"));
      expect(expanded(t, "switchboard")).toBe("false");
      expect(expanded(t, "pfarm")).toBe("true");
    });
  });

  describe("строка и вид", () => {
    const question = { type: "question", from: "migrate@laptop", to: ["phone"], question: "q1", kind: "ask", questions: [{ question: "База?", header: "Б", options: [{ label: "да" }] }] };

    it("6981 · строка сессии с вопросом: телефон — экран вопроса; пульт — карточка", async () => {
      // источник: факт — телефон: сессия с вопросом сразу вопрос; пульт — карточка
      const t = await start();
      t.relay.push(question);
      await flush(3);
      await t.click(t.$('.bd-row[data-callsign="migrate@laptop"]'));
      expect(location.hash).toBe("#ask?callsign=migrate%40laptop");

      const t2 = await start({ wide: true, options: { beside: { card: "board", ask: "board" } } });
      t2.relay.push(question);
      await flush(3);
      await t2.click(t2.$('.bd-row[data-callsign="migrate@laptop"]'));
      expect(location.hash).toBe("#card?callsign=migrate%40laptop");
    });

    it("6982 · сброс вида: вид по умолчанию записан; широкий вид — ещё и шапка карточки по умолчанию", async () => {
      // источник: факт — настройки шапки у карточки, её команда возвращает свои; вне широкого вида группы нет
      const store = memoryStore({ key: KEY, view: { at: false } });
      const t = await start({ store });
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('[data-act="view-reset"]'));
      expect(await store.get("view")).toMatchObject({ at: true });
      expect(t.$("[data-v-head]")).toBeNull();

      const store2 = memoryStore({ key: KEY, "card.head": { haddr: true, howner: false, hprof: true, hmodel: true } });
      const t2 = await start({ store: store2, wide: true, options: { beside: { card: "board" } } });
      await t2.click(t2.$(".fc.vw"));
      await t2.click(t2.$('[data-act="view-reset"]'));
      await flush(3);
      expect(await store2.get("card.head")).toMatchObject({ haddr: false, howner: true });
    });
  });
});

describe("Карточка: телефон", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  async function card(callsign: string, roster = homeRoster()) {
    const relay = new FakeRelay(roster);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    // карточка — по адресу: список сессий board в эти эталоны не входит
    const t = await stand(parts(), { relay, url: `/#card?callsign=${encodeURIComponent(callsign)}` });
    return t;
  }

  describe("карточка сессии", () => {
    it("шапка: имя, машина и папка; состояние — лампой без слов; вкладка «Чат» — лента в месте карточки", async () => {
      const t = await card("site@laptop");
      expect(t.$(".sb-bt")!.textContent).toBe("site@laptop · папка switchboard");
      expect(t.$(".sb-pill")).toBeNull();
      expect(t.$(".sb-bar .sb-dot.busy")).not.toBeNull();
      expect(t.$(".card-place .chat-comp")).not.toBeNull();
      expect(t.relay.sent("session.watch")[0]).toMatchObject({ callsign: "site@laptop" });
    });

    it("«Ещё»: поля roster; модель и усилие — session.update; «Остановить» — session.stop, отказ — словом", async () => {
      const r = homeRoster();
      r.machines[0].contract = { ...r.machines[0].contract, "session.update": 1 };
      const t = await card("site@laptop", r);
      t.relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      await t.click(t.button("Ещё"));
      expect(t.relay.sent("session.unwatch")).toHaveLength(1);
      expect(t.$(".card-info")!.textContent).toBe("адресsite@laptopпапка~/Projects/switchboardслотmainаккаунтy0902");
      // прототип «Пульт и телефон»: модель и усилие меняются из сессии и на телефоне
      t.relay.handlers["session.update"] = () => ({ ok: true });
      expect(t.$('[data-pick="model"] [aria-pressed="true"]')!.textContent).toBe("opus");
      await t.click(t.$('[data-pick="effort"] button'));
      expect(t.relay.sent("session.update")[0]).toMatchObject({ callsign: "site@laptop", effort: "low" });
      await t.click(t.button("Остановить"));
      expect(t.relay.sent("session.stop")[0]).toMatchObject({ v: 1, callsign: "site@laptop" });
      expect(t.text()).toContain("session.stop: stopping");
    });

    it("остановленная — «Запустить»; нет session.start в contract машины — кнопки нет", async () => {
      const t = await card("wiki@pc");
      await t.click(t.button("Ещё"));
      expect(t.button("Запустить")).not.toBeNull();
      const r = homeRoster();
      delete r.machines[1].contract!["session.start"];
      const t2 = await card("wiki@pc", r);
      await t2.click(t2.button("Ещё"));
      expect(t2.button("Запустить")).toBeNull();
    });
  });
});

describe("Карточка: настройки", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  const CARD = ["session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.profiles", "machine.accounts", "machine.journal", "session.stop", "session.start"];

  function roster(without: string[] = [], tweak: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract, ...Object.fromEntries(CARD.map((n) => [n, n === "machine.journal" ? 2 : 1])) };
      for (const n of without) delete m.contract[n];
    }
    tweak(r);
    return r;
  }
  const state = (s: string) => (r: Roster) => void Object.assign(r.sessions.find((x) => x.callsign === "poe-bot@pc")!, { state: s });

  function relayFor(r: Roster) {
    const relay = new FakeRelay(r);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.unwatch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
    relay.handlers["session.spec"] = () => ({ ok: true, result: { title: "старый" } });
    relay.handlers["session.update"] = () => ({ ok: true, result: { now: [] } });
    return relay;
  }

  async function wideCard(r = roster(), relay = relayFor(r), hash = "#card?callsign=poe-bot%40pc") {
    const t = await stand(parts(), { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", `/${hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    const btn = (scope: string, text: string) => [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
    const tab = (k: string) => t.click(t.$(`.cw-tabs [data-tab="${k}"]`));
    return { ...t, relay, btn, tab };
  }

  const narrow = async (r = roster(), relay = relayFor(r)) => {
    const t = await stand(parts(), { relay, url: "/#card?callsign=poe-bot%40pc" });
    await t.click(t.button("Ещё"));
    return t;
  };

  const typeIn = async (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const leave = async (el: HTMLElement) => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush();
  };

  describe("настройки сессии", () => {
    it("6991 · заголовок: значение из session.spec; ушли с поля — session.update один раз, значение перечитано", async () => {
      // источник: чьё: код
      const t = await wideCard();
      await t.tab("set");
      const f = t.$<HTMLInputElement>('[data-f="title"]')!;
      expect(f.value).toBe("старый");
      t.relay.handlers["session.spec"] = () => ({ ok: true, result: { title: "новый" } });
      const read = t.relay.sent("session.spec").length;
      await typeIn(f, "новый");
      await leave(f);
      await leave(f);
      expect(t.relay.sent("session.update").filter((x) => x.title)).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", title: "новый" })]);
      expect(t.relay.sent("session.spec")).toHaveLength(read + 1);
    });

    it("6992 · заголовок отказал: «Не вышло: слово»", async () => {
      // источник: устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      t.relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      const f = t.$<HTMLInputElement>('[data-f="title"]')!;
      await typeIn(f, "x");
      await leave(f);
      expect(t.$('[data-sec="title"]')!.textContent).toContain("Не вышло: bad_spec");
    });

    it("6995 · пуск и стоп: «Остановить» — session.stop; остановленная — «Запустить», session.start", async () => {
      // источник: чьё: код
      const t = await wideCard();
      await t.tab("set");
      await t.click(t.btn('[data-sec="ctl"]', "Остановить"));
      expect(t.relay.sent("session.stop")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
      const r = roster([], state("stopped"));
      const t2 = await wideCard(r, relayFor(r));
      await t2.tab("set");
      await t2.click(t2.btn('[data-sec="ctl"]', "Запустить"));
      expect(t2.relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
    });

    it("6997 · нажат текущий профиль и текущий слот: запроса нет", async () => {
      // источник: чьё: код
      const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { profile: { id: "team/profiles/ops", state: "ok" }, slot: { name: "main", wait: null } }));
      const relay = relayFor(r);
      relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {} } } });
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "a", order: ["a"] } } } });
      const t = await wideCard(r, relay);
      await t.tab("set");
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      await t.click(t.$('[data-sec="slot"] [data-slot="main"]'));
      expect(relay.sent("session.profile")).toHaveLength(0);
      expect(relay.sent("session.slot")).toHaveLength(0);
    });

    it("6998 · быстрый режим: session.update с fast; значение — из следующего roster; отказ — тост словом", async () => {
      // источник: факт — итог изменения из следующего roster; устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      const sw = t.$('[data-sec="fast"] [role="switch"]')!;
      await t.click(sw);
      expect(t.relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot@pc", fast: true });
      expect(t.$('[data-sec="fast"] [role="switch"]')!.getAttribute("aria-checked")).toBe("false");
      t.relay.setRoster(roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { fast: true })));
      await flush();
      expect(t.$('[data-sec="fast"] [role="switch"]')!.getAttribute("aria-checked")).toBe("true");
      t.relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      await t.click(t.$('[data-sec="fast"] [role="switch"]'));
      expect(t.$(".sb-toast")!.textContent).toBe("poe-bot@pc: быстрый режим — bad_spec");
    });

    it("6925 · кнопки по состоянию: busy — «Остановить»; stopped и failed — «Запустить», там же в шапке", async () => {
      // источник: чьё: код
      const t = await wideCard();
      await t.tab("set");
      expect(t.btn('[data-sec="ctl"]', "Остановить")).not.toBeNull();
      expect(t.btn('[data-sec="ctl"]', "Запустить")).toBeNull();
      expect(t.btn(".cw-h", "Запустить")).toBeNull();
      for (const s of ["stopped", "failed"]) {
        const r = roster([], state(s));
        const t2 = await wideCard(r, relayFor(r));
        await t2.tab("set");
        expect(t2.btn('[data-sec="ctl"]', "Запустить")).not.toBeNull();
        expect(t2.btn('[data-sec="ctl"]', "Остановить")).toBeNull();
        expect(t2.btn(".cw-h", "Запустить")).not.toBeNull();
      }
    });

    it("6926 · убрать: до подтверждения и после отмены запроса нет; подтвердили — session.remove и возврат", async () => {
      // источник: чьё: код
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.remove"] = () => ({ ok: true });
      const t = await wideCard(r, relay);
      await t.tab("set");
      await t.click(t.btn(".cw-set", "Убрать…"));
      await t.click(t.btn(".cw-confirm", "Отмена"));
      expect(t.$(".cw-confirm")).toBeNull();
      expect(relay.sent("session.remove")).toHaveLength(0);
      await t.click(t.btn(".cw-set", "Убрать…"));
      const before = location.hash;
      await t.click(t.btn(".cw-confirm", "Убрать"));
      await flush(5);
      expect(relay.sent("session.remove")).toHaveLength(1);
      expect(location.hash).not.toBe(before);
    });

    it("6927 · команда отказала: на вкладке «запрос: слово», экран не закрыт; в шапке — тост", async () => {
      // источник: устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      t.relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      await t.click(t.btn('[data-sec="ctl"]', "Остановить"));
      expect(t.$('[data-sec="ctl"]')!.textContent).toContain("session.stop: stopping");
      expect(location.hash).toContain("#card");
      const r = roster([], state("stopped"));
      const relay = relayFor(r);
      relay.handlers["session.start"] = () => ({ ok: false, error: "no_slot" });
      const t2 = await wideCard(r, relay);
      await t2.click(t2.btn(".cw-h", "Запустить"));
      expect(t2.$(".sb-toast")!.textContent).toBe("poe-bot@pc: «Запустить» — no_slot");
    });

    it("6929 · машина не умеет: адрес на журнал ведёт в «Настройки»; разделов и «Журнала» нет; session.spec нет", async () => {
      // источник: факт — нет имени в contract, нет кнопки
      const r = roster(["session.update", "session.slot", "session.profile", "session.spec", "machine.journal"]);
      const t = await wideCard(r, relayFor(r), "#card?callsign=poe-bot%40pc&tab=log");
      expect(t.$('.cw-tabs [data-tab="log"]')).toBeNull();
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
      for (const sec of ["profile", "fast", "title", "slot"]) expect(t.$(`[data-sec="${sec}"]`)).toBeNull();
      expect(t.relay.sent("session.spec")).toHaveLength(0);
    });
  });

  describe("журнал и лимиты", () => {
    const rec = (t: string, ev: string) => ({ t, part: "host", who: "core", callsign: "poe-bot@pc", kind: "stop", ev });

    it("6993 · быстрая смена фильтра: устаревший ответ отброшен", async () => {
      // источник: чьё: код
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [], more: false } });
      const t = await wideCard(roster(), relay);
      await t.tab("log");
      relay.handlers["machine.journal"] = () => undefined;
      await t.click(t.btn(".cw-log", "stop"));
      await t.click(t.btn(".cw-log", "все"));
      const [late, now] = relay.sent("machine.journal").slice(-2);
      relay.reply(now.id!, { ok: true, result: { records: [rec("2026-11-01T06:00:00.000Z", "свежий")], more: false } });
      await flush();
      relay.reply(late.id!, { ok: true, result: { records: [rec("2026-11-01T05:00:00.000Z", "старый")], more: true } });
      await flush();
      expect(t.$(".cw-log")!.textContent).toContain("свежий");
      expect(t.$(".cw-log")!.textContent).not.toContain("старый");
    });

    it("6928 · прошлые дни: подпись «сегодня»; «Раньше» — на день назад, подпись и записи", async () => {
      // источник: чьё: код
      const relay = relayFor(roster());
      let first = true;
      relay.handlers["machine.journal"] = () => {
        const records = first ? [] : [rec("2026-11-01T06:00:00.000Z", "вчера")];
        first = false;
        return { ok: true, result: { records, more: false } };
      };
      const t = await wideCard(roster(), relay);
      await t.tab("log");
      expect(t.$(".cw-log")!.textContent).toContain("сегодня");
      expect(t.$(".cw-log")!.textContent).toContain("Записей нет.");
      expect(t.btn(".cw-log", "дальше →")).toBeNull();
      await t.click(t.btn(".cw-log", "Раньше"));
      expect(t.$(".cw-log")!.textContent).toContain("с 1 дн. назад");
      expect(t.$(".cw-log")!.textContent).toContain("вчера");
    });

    it("6994 · окна лимитов: жёлтая с 70, красная с 90", async () => {
      // источник: устав персоны — дубликат логики сведён: пороги — одно правило набора
      const rr = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { account: "y0902" }));
      const relay = relayFor(rr);
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "a@x", limits: { five_hour: { utilization: 0.75 }, seven_day: { utilization: 0.92 }, seven_day_opus: { utilization: 0.1 } } } } } });
      const t = await wideCard(rr, relay);
      await t.click(t.$('[data-pop="acc"]'));
      await flush();
      const bar = (w: string) => t.$(`.cw-pop [data-win="${w}"] .sb-barw`)!.className;
      expect(bar("five_hour")).toContain("warn");
      expect(bar("seven_day")).toContain("bad");
      expect(bar("seven_day_opus")).not.toMatch(/warn|bad/);
    });
  });

  describe("телефон", () => {
    it("6983 · failed и stopped — «Запустить», «Остановить» нет; одно правило с широким видом", async () => {
      // источник: решение главной сессии 4 нояб.: дубликат логики NarrowCard и SetTab сведён, у failed — «Запустить»
      for (const s of ["failed", "stopped"]) {
        const t = await narrow(roster([], state(s)));
        expect(t.button("Запустить")).not.toBeNull();
        expect(t.button("Остановить")).toBeNull();
        expect(t.button("Поднять")).toBeNull();
        await t.click(t.button("Запустить"));
        expect(t.relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
      }
    });

    it("6937 · на время запроса кнопки неактивны; модель — session.update, стоп — session.stop", async () => {
      // источник: чьё: код
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.update"] = () => undefined;
      const t = await narrow(r, relay);
      await t.click(t.$('[data-pick="model"] button'));
      const sent = relay.sent("session.update").at(-1)!;
      expect(sent).toHaveProperty("model");
      expect(t.button("Остановить")!.disabled).toBe(true);
      relay.reply(sent.id!, { ok: true });
      await flush();
      expect(t.button("Остановить")!.disabled).toBe(false);
      relay.handlers["session.stop"] = () => ({ ok: true });
      await t.click(t.button("Остановить"));
      expect(relay.sent("session.stop")).toHaveLength(1);
    });

    it("6938 · отказ: «Не вышло» и «запрос: слово»; следующее действие снимает прошлое слово", async () => {
      // источник: устав — отказ словом
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      relay.handlers["session.update"] = () => undefined;
      const t = await narrow(r, relay);
      await t.click(t.button("Остановить"));
      expect(t.text()).toContain("Не вышло");
      expect(t.text()).toContain("session.stop: stopping");
      await t.click(t.$('[data-pick="model"] button'));
      expect(t.text()).not.toContain("session.stop: stopping");
    });
  });

  describe("возврат машины и страницы", () => {
    it("7232 · карточка открыта при выключенной машине: машина вернулась — аккаунты и слоты дочитаны сами", async () => {
      // чьё: код — слепой архитектор, 4 нояб.: deps не менялись, данные пусты до ручного действия; ветка устава «соединение оборвалось → переподключаются»
      const r = roster(["machine.accounts"]);
      const relay = relayFor(r);
      const t = await wideCard(r, relay);
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(0);
      relay.setRoster(roster());
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(1);
      expect(relay.sent("machine.accounts")[0]).toMatchObject({ machine: "pc" });
      expect(t.$(".cw-h")).not.toBeNull();
    });

    it("7233 · машина перезапустилась (новый since) — ответ перечитан, прежний показан до нового", async () => {
      // чьё: код — web/packages/ui/src/hooks.ts useMachineLoad
      const r = roster();
      const relay = relayFor(r);
      await wideCard(r, relay);
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(1);
      relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: 2 } : m)) });
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(2);
    });

    it("7234 · страница вернулась: настройка карточки из другой вкладки прочитана заново", async () => {
      // чьё: код — повторный start модулей при возвращении до 4 нояб.; start теперь один раз
      const store = memoryStore({ key: KEY });
      const r = roster();
      const relay = relayFor(r);
      const t = await stand(parts(), { relay, store, wide: true, url: "/#card?callsign=poe-bot%40pc" });
      await flush();
      expect(t.$("aside.cw-info")).toBeNull();
      // уход с экрана доводит начатые запросы: ответить на те, что без подделки
      for (const f of relay.got) if (typeof f.id === "string") relay.reply(f.id, { ok: true, result: null });
      await flush();
      await t.run.hide();
      store.data["card.info"] = true;
      await t.run.show();
      await flush();
      expect(t.$("aside.cw-info")).not.toBeNull();
    });
  });

  describe("E6 · чтение не ответило", () => {
    afterEach(() => vi.useRealTimers());

    it("E6 · слот, профиль, заголовок и серверы MCP: через 10 с слово на месте данных, а не «без слота» и не пусто", async () => {
      // источник: слово пользователя 4 нояб. — «таймаут операций на запрос метадаты 10 секунд»; дизайн «Что видит человек при отказе»
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { slot: { name: "main", wait: null }, profile: { id: "team/profiles/ops", state: "ok" } }));
      const relay = relayFor(r);
      for (const n of ["machine.accounts", "machine.profiles", "session.spec", "session.call"]) relay.handlers[n] = () => undefined as never;
      const t = await wideCard(r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await t.tab("set");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(t.$('[data-refused="slot"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      await flush();
      expect(t.$('[data-refused="slot"]')!.textContent).toBe("main · timeout");
      expect(t.$('[data-sec="slot"] [data-slot=""]')).toBeNull();
      expect(t.$('[data-refused="profile"]')!.textContent).toBe("ops · timeout");
      expect(t.$('[data-refused="title"]')!.textContent).toBe("timeout");
      expect(t.$('[data-refused="mcp"]')!.textContent).toBe("timeout");
    });
  });

  it("V-C4 · телефон: «Останавливаю…» и «Запускаю…» на время запроса; журнал: подпись дня и машины, вид записи", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.stop"] = () => undefined;
    const t = await narrow(roster(), relay);
    await t.click(t.button("Остановить"));
    expect(t.button("Останавливаю…")!.disabled).toBe(true);
    const r2 = roster([], state("stopped"));
    const relay2 = relayFor(r2);
    relay2.handlers["session.start"] = () => undefined;
    const t2 = await narrow(r2, relay2);
    await t2.click(t2.button("Запустить"));
    expect(t2.button("Запускаю…")!.disabled).toBe(true);

    const relay3 = relayFor(roster());
    relay3.handlers["machine.journal"] = () => ({ ok: true, result: { records: [{ t: "нет даты", part: "host", kind: "note", ev: "e", word: "w" }], more: false } });
    const t3 = await wideCard(roster(), relay3);
    await t3.tab("log");
    expect(t3.$(".cw-log .cw-note")!.textContent).toBe("pc · сегодня");
    expect(t3.$(".cw-lr")!.textContent).toBe("нет датыnotehoste · w");
    expect(t3.$$(".cw-log .cw-opts button").map((b) => b.textContent)).toEqual(["все", "stop", "refuse", "note"]);
  });
});

describe("Карточка: широкий вид", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  /** Имена Host, которыми пользуется карточка пульта. */
  const CARD = ["session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.profiles", "machine.accounts", "machine.journal"];

  /** Флот home с контрактом машины без names (по умолчанию — со всеми именами карточки). */
  function roster(without: string[] = [], tweak: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract, ...Object.fromEntries(CARD.map((n) => [n, n === "machine.journal" ? 2 : 1])) };
      for (const n of without) delete m.contract[n];
    }
    tweak(r);
    return r;
  }

  function relayFor(r: Roster) {
    const relay = new FakeRelay(r);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.unwatch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
    return relay;
  }

  /** Широкая карточка: пульт с карточкой справа от списка. */
  async function wideCard(callsign: string, r = roster(), relay = relayFor(r)) {
    const t = await stand(parts(), { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", `/#card?callsign=${encodeURIComponent(callsign)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    const btn = (scope: string, text: string | RegExp) =>
      [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof text === "string" ? b.textContent === text : text.test(b.textContent ?? ""))) ?? null;
    const tab = (k: string) => t.click(t.$(`.cw-tabs [data-tab="${k}"]`));
    return { ...t, relay, btn, tab };
  }

  describe("карточка в узком виде", () => {
    it("4080 · сессии нет в roster — «laptop не на связи», кнопок нет", async () => {
      const r = homeRoster();
      r.machines = r.machines.filter((m) => m.machine !== "laptop");
      r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@laptop"));
      const t = await stand(parts(), { relay: relayFor(r), url: "/#card?callsign=site%40laptop&tab=info" });
      await flush();
      expect(t.$(".sb-bt")!.textContent).toBe("site@laptop не на связи");
      expect(t.$(".card-info")!.textContent).toBe("адресsite@laptop");
      expect(t.button("Остановить")).toBeNull();
      expect(t.button("Запустить")).toBeNull();
    });
  });

  describe("карточка в широком виде", () => {
    // источник: прототип «Пульт и телефон», подписан пользователем 2 нояб. («основа дизайна ок»); комментарии к прототипу:
    // «переработай статус в 1 строку», «перенести в право в контекст меню всю панель», «не запустилось — ховер индикатора,
    // опус и высокое конфигурируемый отсюда», «где-то надо сделать лимиты и аккаунт активный», сведения — «опциональные»
    it("5301 · шапка — одна строка: лампа, позывной, «модель · усилие ▾», «аккаунт · % ▾» (жёлтая с 70 %), вкладки, «⋯»", async () => {
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "dev@mail", plan: "Max 20×", limits: { five_hour: { utilization: 0.82, resetsAt: 1793660000 }, seven_day: { utilization: 0.41 } } } } } });
      const t = await wideCard("site@laptop", r, relay);
      const head = t.$(".cw-h")!;
      expect(head.querySelector(".cw-cs")!.textContent).toBe("site");
      expect(head.querySelector('[data-pop="model"]')!.textContent).toBe("opus · высокое ▾");
      expect(head.querySelector('[data-pop="acc"]')!.textContent).toBe("y0902 · 82 % ▾");
      expect(head.querySelector('[data-pop="acc"]')!.classList.contains("lim")).toBe(true);
      expect(head.querySelector(".cw-tabs")).not.toBeNull();
      expect([...head.querySelectorAll(".cw-tabs [data-tab]")].map((b) => b.textContent)).toEqual(["Разговор", "Настройки", "Журнал"]);
      expect(head.querySelector('[data-pop="menu"]')).not.toBeNull();
      // плашки у живой сессии нет; состояние — не текстом
      expect(t.$(".cw-pl")!.hidden).toBe(true);
      expect(head.textContent).not.toContain("работает");
      expect(head.textContent).not.toContain("null");
    });

    it("5302 · состояние — подсказка лампы; не запустилась: «не запустилась: причина», плашка с «Почему» → журнал, «Запустить» в шапке, отказ — тост", async () => {
      const r = roster([], (x) => Object.assign(x.sessions[3], { state: "failed", failed: { host: "resume failed" } }));
      const relay = relayFor(r);
      relay.handlers["session.start"] = () => ({ ok: false, error: "offline" });
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [], more: false } });
      const t = await wideCard("wiki@pc", r, relay);
      const lamp = t.$(".cw-h .cw-lamp")!;
      expect(lamp.getAttribute("title")).toBe("не запустилась: host: resume failed");
      expect(lamp.getAttribute("aria-label")).toBe("не запустилась: host: resume failed");
      expect(t.$(".cw-pl b")!.textContent).toBe("Не запустилась: host: resume failed");
      await t.click(t.btn(".cw-pl", "Почему"));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Журнал");
      await t.click(t.btn(".cw-h", "Запустить"));
      expect(relay.sent("session.start")).toEqual([expect.objectContaining({ v: 1, callsign: "wiki@pc" })]);
      expect(t.$(".sb-toast")!.textContent).toBe("wiki@pc: «Запустить» — offline");
      const t2 = await wideCard("poe-bot@pc");
      expect(t2.$(".cw-h .cw-lamp")!.getAttribute("title")).toBe("свободна");
    });

    it("7310 · supportedModels — один запрос на экран: поле ввода чата и окно модели шапки берут один ответ", async () => {
      // источник: отчёт архитектора, лишняя коммуникация 6: модели на одном экране спрашивают дважды
      const r = roster([], (x) => void (x.sessions.find((v) => v.callsign === "poe-bot@pc")!.mode = "default"));
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? { ok: true, result: [{ value: "opus", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet 5.5" }] } : { ok: true, result: null });
      const t = await wideCard("poe-bot@pc", r, relay);
      const asked = () => relay.sent("session.call").filter((f) => f.method === "supportedModels").length;
      await flush(10);
      expect(t.$(".chat-mode")).not.toBeNull();
      expect(asked()).toBe(1);
      await t.click(t.$('[data-pop="model"]'));
      await flush(10);
      expect(t.$$(".cw-pop [data-model]").map((b) => b.textContent)).toEqual(["Opus 5.5", "✓ Sonnet 5.5"]);
      expect(asked()).toBe(1);
    });

    it("5303 · модель и усилие — из шапки: модели — ответ SDK машины (supportedModels), выбор — session.update; отказ — тост", async () => {
      const relay = relayFor(roster());
      relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? { ok: true, result: [{ value: "opus", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet 5.5" }] } : { ok: true, result: null });
      relay.handlers["session.update"] = () => ({ ok: true, result: { now: ["model"] } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.click(t.$('[data-pop="model"]'));
      expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", method: "supportedModels" })]);
      expect(t.$$(".cw-pop [data-model]").map((b) => b.textContent)).toEqual(["Opus 5.5", "✓ Sonnet 5.5"]);
      await t.click(t.$('.cw-pop [data-model="opus"]'));
      expect(relay.sent("session.update")).toEqual([expect.objectContaining({ v: 1, callsign: "poe-bot@pc", model: "opus" })]);
      expect(t.$(".cw-pop")).toBeNull();
      relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      await t.click(t.$('[data-pop="model"]'));
      await t.click(t.$('.cw-pop [data-effort="low"]'));
      expect(relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot@pc", effort: "low" });
      expect(t.$(".sb-toast")!.textContent).toBe("poe-bot@pc: усилие — bad_spec");
      // в настройках модели и усилия нет — одно место
      await t.tab("set");
      expect(t.$(".cw-set [data-model], .cw-set [data-effort]")).toBeNull();
    });

    it("5304 · аккаунт и лимиты: окно — почта и план, слот, окна лимитов, очередь слота; слот ждёт сброса — «ждёт сброса ЧЧ:ММ»", async () => {
      const reset = Math.floor(new Date(2026, 10, 2, 16, 40).getTime() / 1000);
      const r = roster([], (x) => Object.assign(x.sessions[0], { slot: { name: "night", wait: reset } }));
      const relay = relayFor(r);
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "night@mail", plan: "Max 5×", limits: { five_hour: { utilization: 0.98, resetsAt: reset } } } }, slots: { night: { account: "y0902", order: ["y0902", "spare"], wait: reset, sessions: ["site@laptop"] } } } });
      const t = await wideCard("site@laptop", r, relay);
      const b = t.$('[data-pop="acc"]')!;
      expect(b.textContent).toBe("y0902 · ждёт сброса 16:40 ▾");
      expect(b.classList.contains("you")).toBe(true);
      await t.click(b);
      const pop = t.$(".cw-pop")!;
      expect(pop.querySelector(".cw-kv")!.textContent).toBe("аккаунтy0902 · Max 5×слотnight @laptop");
      expect(pop.querySelector('[data-win="five_hour"]')!.textContent).toBe("5 ч98 % · до 16:40");
      expect(pop.textContent).toContain("очередь слота: y0902 → spare");
      await t.click(t.btn(".cw-pop", "Сменить слот"));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
    });

    it("5305 · меню ⋯: профиль, папка (поле dir), машина, инцидент; пункты места card.menu — экран с from; claude.ai — ссылкой", async () => {
      const r = roster([], (x) => Object.assign(x.sessions[0], { dir: "~/Projects/site", profile: { id: "team/profiles/ops", state: "ok" }, incident: { type: "disk-full", key: "/" }, remote: { url: "https://claude.ai/code/s1" } }));
      const t = await wideCard("site@laptop", r);
      await t.click(t.$('[data-pop="menu"]'));
      expect(t.$(".cw-pop .cw-kv")!.textContent).toBe("профильopsпапка~/Projects/siteмашина@laptopинцидентdisk-full · /");
      expect(t.$<HTMLAnchorElement>('.cw-pop a[href="https://claude.ai/code/s1"]')!.textContent).toBe("Открыть в claude.ai ↗");
      // клик мимо закрывает меню
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(t.$(".cw-pop")).toBeNull();
    });

    it("5306 · сведения сбоку — по желанию: по умолчанию скрыты; «Сведения сбоку» — показаны и запомнены на устройстве", async () => {
      const store = memoryStore({ key: KEY });
      const r = roster([], (x) => Object.assign(x.sessions[0], { dir: "~/Projects/site", by: "pult~you@mail", parent: "pult~you@mail" }));
      const relay = relayFor(r);
      const t = await stand(parts(), { relay, wide: true, store, url: "/#card?callsign=site%40laptop", options: { beside: { card: "board", chat: "board", ask: "board" } } });
      await flush();
      expect(t.$("aside.cw-info")).toBeNull();
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      expect(t.$("aside.cw-info")!.textContent).toContain("задачу далpult~you@mail");
      expect(t.$("aside.cw-info")!.textContent).toContain("папка~/Projects/site");
      const t2 = await stand(parts(), { relay: relayFor(r), wide: true, store, url: "/#card?callsign=site%40laptop", options: { beside: { card: "board", chat: "board", ask: "board" } } });
      await flush();
      expect(t2.$("aside.cw-info")).not.toBeNull();
    });

    it("6106 · сведения открыты, сессия ожила позже — список серверов MCP приходит без переоткрытия", async () => {
      const r = roster([], (x) => void (x.sessions[0].state = "stopped"));
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      const asked = () => relay.sent("session.call").filter((f) => f.method === "mcpServerStatus");
      expect(asked()).toHaveLength(0);
      relay.setRoster(roster([], (x) => void (x.sessions[0].state = "idle")));
      await flush();
      expect(asked()).toHaveLength(1);
      expect(t.$("aside.cw-info")!.textContent).toContain("fleet");
    });

    it("6110 · клик по имени сервера MCP ничего не переключает; «выкл» — переключает", async () => {
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      const toggled = () => relay.sent("session.call").filter((f) => f.method === "toggleMcpServer");
      await t.click(t.$(".cw-sw span"));
      await flush();
      expect(toggled()).toHaveLength(0);
      await t.click(t.$('[data-mcp="fleet"]'));
      await flush();
      expect(toggled()).toHaveLength(1);
    });

    it("7030 · сервер MCP: состояние словом, «Переподключить» — reconnectMcpServer и список заново; отказ — тост", async () => {
      // источник: устав — все функции claude-fleet: состояние, переподключение и вход сервера MCP
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "failed" }] } : f.method === "reconnectMcpServer" ? { ok: false, error: "sdk_error" } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      expect(t.$(".cw-sw")!.textContent).toContain("ошибка");
      const asked = () => relay.sent("session.call").filter((f) => f.method === "mcpServerStatus").length;
      const before = asked();
      await t.click(t.$('[data-mcp-re="fleet"]'));
      await flush();
      expect(relay.sent("session.call").find((f) => f.method === "reconnectMcpServer")).toMatchObject({ args: ["fleet"] });
      expect(t.$(".sb-toast")!.textContent).toContain("reconnectMcpServer: sdk_error");
      expect(asked()).toBe(before);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      await t.click(t.$('[data-mcp-re="fleet"]'));
      await flush();
      expect(asked()).toBe(before + 1);
      expect(t.$(".cw-sw")!.textContent).toContain("подключён");
    });

    it("7031 · нужен вход: «Войти» — mcpAuthenticate, ссылка в новой вкладке; у подключённого кнопки нет; ссылки нет — тост", async () => {
      // источник: устав — все функции claude-fleet; ссылка, а не окно: окно после ответа запроса браузер блокирует
      const r = roster();
      const relay = relayFor(r);
      let url: string | undefined = "https://example.com/login";
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "gh", status: "needs-auth" }, { name: "fleet", status: "connected" }] } : f.method === "mcpAuthenticate" ? { ok: true, result: { authUrl: url } } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      expect(t.$('[data-mcp-login="fleet"]')).toBeNull();
      await t.click(t.$('[data-mcp-login="gh"]'));
      await flush();
      expect(relay.sent("session.call").find((f) => f.method === "mcpAuthenticate")).toMatchObject({ args: ["gh"] });
      const a = t.$<HTMLAnchorElement>('a[data-mcp-url="gh"]')!;
      expect(a.href).toBe("https://example.com/login");
      expect(a.target).toBe("_blank");
      url = undefined;
      await t.click(t.$('[data-mcp-login="gh"]'));
      await flush();
      expect(t.$(".sb-toast")!.textContent).toContain("mcpAuthenticate: ссылки нет");
    });

    it("4085 · сессии нет в roster — «pc не на связи», плашки нет", async () => {
      const r = roster([], (x) => {
        x.machines = x.machines.filter((m) => m.machine !== "pc");
        x.sessions = x.sessions.filter((s) => !s.callsign.endsWith("@pc"));
      });
      const t = await wideCard("poe-bot@pc", r);
      expect(t.$(".cw-h")!.textContent).toContain("poe-bot@pc✎не на связи");
      expect(t.$(".cw-pl")!.hidden).toBe(true);
    });
  });

  describe("настройки карточки", () => {
    it("5307 · профиль и слот — чипами (session.profile, session.slot), отказ — «Не вышло: слово»; «Убрать…» — подтверждение, session.remove", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {}, "team/profiles/writer": {} } } });
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "y0902", order: ["y0902"] }, bot: { account: "work3", order: ["work3"] } } } });
      relay.handlers["session.profile"] = () => ({ ok: false, error: "no_profile" });
      relay.handlers["session.slot"] = () => ({ ok: true, result: { restart: true } });
      relay.handlers["session.remove"] = () => ({ ok: true });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("set");
      expect(t.$$('[data-sec="profile"] [data-profile]').map((b) => b.textContent)).toEqual(["ops", "writer", "без профиля"]);
      await t.click(t.$('[data-profile="team/profiles/writer"]'));
      expect(relay.sent("session.profile")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", profile: "team/profiles/writer" })]);
      expect(t.$('[data-sec="profile"]')!.textContent).toContain("Не вышло: no_profile");
      await t.click(t.$('[data-slot="bot"]'));
      expect(relay.sent("session.slot")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", slot: "bot" })]);
      expect(t.$('[data-sec="slot"]')!.textContent).toContain("после хода");
      await t.click(t.btn(".cw-set", "Убрать…"));
      expect(relay.sent("session.remove")).toHaveLength(0);
      await t.click(t.btn(".cw-confirm", "Убрать"));
      expect(relay.sent("session.remove")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
    });

    it("4092 · сессия не живая — сведений процесса не просим; «Запустить» и «Убрать…», без «Остановить» и «Прервать»", async () => {
      const t = await wideCard("wiki@pc");
      await t.tab("set");
      expect(t.relay.sent("session.call")).toEqual([]);
      const ctl = [...t.$('[data-sec="ctl"]')!.querySelectorAll("button")].map((b) => b.textContent);
      expect(ctl).toEqual(["Запустить", "Убрать…"]);
    });
  });

  describe("журнал машины в карточке", () => {
    const rec = (t: string, ev: string) => ({ t, part: "host", who: "core", callsign: "poe-bot@pc", kind: "stop", ev, word: "w", why: "y" });

    it("4191 · сессия убрана, машина на связи: вкладка «Журнал» есть, запрос — с session и без callsign", async () => {
      // источник: факт цикла тестов 2 нояб. — журнал убранной сессии отвечал offline (callsign запроса ядро читает как адрес)
      const r = roster([], (x) => (x.sessions = x.sessions.filter((s) => s.callsign !== "poe-bot@pc")));
      const relay = relayFor(r);
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [rec("2026-11-01T06:00:00.000Z", "gone")], more: false } });
      const t = await wideCard("poe-bot@pc", r, relay);
      expect(t.$('.cw-tabs [data-tab="log"]')).not.toBeNull();
      await t.tab("log");
      const f = relay.sent("machine.journal")[0];
      expect(f).toMatchObject({ v: 2, machine: "pc", session: "poe-bot@pc" });
      expect(f).not.toHaveProperty("callsign");
      expect(t.$(".cw-log")!.textContent).toContain("gone");
    });

    it("4093 · с полуночи, фильтр kind, «дальше →» с t последней, «Раньше» — с прошлого дня", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = (f) => ({ ok: true, result: { records: f.since && String(f.since).startsWith("2026-10-31T23") ? [rec("2026-11-01T05:00:00.000Z", "x2")] : [rec("2026-11-01T06:00:00.000Z", "x1")], more: true } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("log");
      const first = relay.sent("machine.journal")[0];
      expect(first).toMatchObject({ v: 2, machine: "pc", session: "poe-bot@pc", limit: 50 });
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      expect(first.since).toBe(midnight.toISOString());
      expect(t.$(".cw-lr")!.textContent).toContain("x1 · w · y");
      await t.click(t.btn(".cw-log", "stop"));
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ kind: ["stop"] });
      await t.click(t.btn(".cw-log", "дальше →"));
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ since: "2026-11-01T06:00:00.000Z" });
      expect(t.$$(".cw-lr")).toHaveLength(2);
      await t.click(t.btn(".cw-log", "Раньше"));
      const yest = new Date(midnight);
      yest.setDate(yest.getDate() - 1);
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ since: yest.toISOString() });
    });

    it("4094 · отказ machine.journal — «machine.journal: слово», без «Записей нет»", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = () => ({ ok: false, error: "offline" });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("log");
      expect(t.$(".cw-log")!.textContent).toContain("machine.journal: offline");
      expect(t.$(".cw-log")!.textContent).not.toContain("Записей нет.");
    });

  });

  describe("видимое (чьё: код)", () => {
    it("V-C1 · шапка: названия кнопок и окон; подписи окна модели, аккаунта и меню", async () => {
      const t = await wideCard("site@laptop");
      expect(t.$('[data-act="names"]')!.getAttribute("aria-label")).toBe("Имена сессии и машины");
      expect(t.$('[data-pop="menu"]')!.getAttribute("aria-label")).toBe("Действия сессии");
      await t.click(t.$('[data-pop="model"]'));
      const model = t.$(".cw-pop")!;
      expect(model.getAttribute("aria-label")).toBe("Модель и усилие");
      expect(t.$$(".cw-pop .lb").map((x) => x.textContent)).toEqual(["Модель", "Усилие"]);
      await t.click(t.$('[data-pop="acc"]'));
      expect(t.$(".cw-pop")!.getAttribute("aria-label")).toBe("Аккаунт и лимиты");
      await t.click(t.$('[data-pop="menu"]'));
      expect(t.$(".cw-pop")!.getAttribute("aria-label")).toBe("Сессия site@laptop");
      // Esc закрывает окно шапки
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
      expect(t.$(".cw-pop")).toBeNull();
    });

    it("V-C2 · настройки: подписи разделов, заголовок, текст подтверждения удаления", async () => {
      const t = await wideCard("poe-bot@pc");
      await t.tab("set");
      expect(t.$$(".cw-set .lb").map((x) => x.textContent)).toEqual(["Профиль", "Заголовок", "Слот", "Сессия"]);
      expect(t.$('[data-sec="fast"]')!.textContent).toContain("Быстрый режим");
      expect(t.$<HTMLInputElement>('[data-f="title"]')!.placeholder).toBe("Заголовок в claude.ai");
      expect(t.$('[data-sec="slot"] [data-slot=""]')).toBeNull();
      await t.click(t.btn(".cw-set", "Убрать…"));
      expect(t.$(".cw-confirm")!.textContent).toContain("poe-bot@pc остановится и уйдёт из списка. Точки в R2 останутся.");
    });

    it("V-C3 · сведения сбоку: дерево — кто открыл и кого ведёт, переход к дочерней; слова состояний MCP; ссылка входа", async () => {
      const r = roster([], (x) => {
        Object.assign(x.sessions[0], { parent: "lead@pc" });
        x.sessions.push({ callsign: "kid@laptop", state: "idle", parent: "site@laptop" } as never);
      });
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "a", status: "pending" }, { name: "b", status: "disabled" }, { name: "c", status: "needs-auth" }, { name: "d", status: "connected" }, { name: "e", status: "странное" }] } : f.method === "mcpAuthenticate" ? { ok: true, result: { authUrl: "https://example.com/l" } } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.click(t.$('[data-pop="menu"]'));
      await t.click(t.$('.cw-pop [data-act="info"]'));
      await flush();
      const aside = t.$("aside.cw-info")!;
      expect(aside.getAttribute("aria-label")).toBe("Сведения");
      expect([...aside.querySelectorAll("h4")].map((x) => x.textContent)).toEqual(["Сведения", "Дерево", "Серверы MCP"]);
      expect(aside.textContent).toContain("открылаlead@pc");
      expect([...aside.querySelectorAll(".cw-mcp-st")].map((x) => x.textContent)).toEqual(["подключается", "выключен", "нужен вход", "подключён", "странное"]);
      // выключенный: кнопка «вкл», переподключить нельзя
      expect(aside.querySelector('[data-mcp="b"]')!.textContent).toBe("вкл");
      expect(aside.querySelector('[data-mcp-re="b"]')).toBeNull();
      await t.click(aside.querySelector('[data-mcp-login="c"]'));
      await flush();
      expect(t.$('a[data-mcp-url="c"]')!.textContent).toBe("Открыть страницу входа ↗");
      await t.click(t.btn("aside.cw-info", "kid@laptop"));
      expect(location.hash).toBe("#card?callsign=kid%40laptop");
    });
  });
});

describe("Карточка: вкладка места", () => {
  describe("вкладка широкой карточки", () => {
    it("7290 · вставка места пропала, пока открыта — вкладка «Настройки», чужого экрана нет", async () => {
      // источник: чьё: код — без вкладки нет и её экрана; запасная вкладка широкого вида — «Настройки» (6929)
      let shown = true;
      let changed = () => {};
      const tabPart: AppPart = {
        manifest: { name: "t-tab", type: "web", version: "1.0.0", provides: { "t.tab": 1 }, uses: { "card.tab@web-card": 1 } },
        module: (app) => {
          changed = app.changed;
          return { screens: { "t.tab": { label: "Вставка", place: "card.tab", show: () => shown, view: () => createElement("div", { className: "t-tab" }) } } };
        },
      };
      const r = homeRoster();
      r.sessions[0].state = "idle";
      const callsign = r.sessions[0].callsign;
      const relay = new FakeRelay(r);
      for (const n of ["session.watch", "session.unwatch"]) relay.handlers[n] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const parts: AppPart[] = [{ manifest: boardM, module: createBoard }, { manifest: cardM, module: createCard }, { manifest: chatM, module: createChat }, { manifest: askM, module: createAsk }, { manifest: alertsM, module: createAlerts({}) }, tabPart];
      const t = await stand(parts, { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
      history.pushState(null, "", `/#card?callsign=${encodeURIComponent(callsign)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await flush();
      await t.click(t.$('.cw-tabs [data-tab="t.tab"]'));
      await flush();
      expect(t.$(".t-tab")).not.toBeNull();
      shown = false;
      changed();
      await flush();
      expect(t.$('.cw-tabs [data-tab="t.tab"]')).toBeNull();
      expect(t.$(".t-tab")).toBeNull();
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
    });
  });
});

describe("Вам", () => {
  const parts = () => [
    { manifest: inboxM, module: createInbox },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
    // когда машина ушла, знает её владелец: настоящий модуль машин
    { manifest: machinesM, module: createMachines },
  ];

  /** Я — phone~you@mail. Мои: site, wait, fail; чужая — anna. */
  function fleet(over: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    r.sessions = [
      { callsign: "site@laptop", state: "busy", dir: "~/Projects/site", by: "phone~you@mail" },
      { callsign: "night@pc", state: "idle", dir: "~/projects/pfarm", by: "pult~you@mail", slot: { name: "night", wait: 1_900_000_000 } },
      { callsign: "catan@laptop", state: "failed", dir: "~/Projects/catan", by: "pult~you@mail", failed: { host: "процесс claude завершился дважды до готовности" } },
      { callsign: "anna@pc", state: "failed", dir: "~/projects/pfarm", by: "laptop~anna@mail" },
    ];
    r.clients = ["phone~you@mail", "laptop~anna@mail"];
    over(r);
    return r;
  }

  const kinds = (t: Awaited<ReturnType<typeof stand>>) => t.$$(".ib-it").map((x) => `${x.dataset.kind}:${x.dataset.callsign ?? x.dataset.machine ?? ""}`);

  describe("«Вам»", () => {
    it("5230 · «не запустилась» и «ждёт сброса лимита» — только у моих сессий; счётчик раздела; чужая сессия карточки не даёт", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      expect(kinds(t)).toEqual(["fail:catan@laptop", "wait:night@pc"]);
      expect(t.$('[data-kind="fail"] .ib-tx')!.textContent).toBe("host: процесс claude завершился дважды до готовности");
      expect(t.$('[data-kind="wait"] .ib-tx')!.textContent).toMatch(/^Аккаунты слота night у порога — продолжит после \d\d:\d\d$/);
      expect(t.$$(".ib-gh").map((x) => x.textContent)).toEqual(["Сломалось или ждёт · 2"]);
      // сессия поднялась, слот сменился — карточки ушли сами
      t.relay.setRoster(fleet((r) => {
        r.sessions[2] = { ...r.sessions[2], state: "idle", failed: undefined };
        r.sessions[1] = { ...r.sessions[1], slot: { name: "main", wait: null } };
      }));
      await flush();
      expect(kinds(t)).toEqual([]);
      expect(t.text()).toContain("Всё разобрано");
    });

    it("5231 · «Запустить снова» — session.start; отказ — словом", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.handlers["session.start"] = () => ({ ok: false, error: "no_slot" });
      await t.click(t.button("Запустить снова"));
      expect(t.relay.sent("session.start")[0]).toMatchObject({ callsign: "catan@laptop" });
      expect(t.$(".sb-toast")!.textContent).toBe("catan@laptop не запустилась: no_slot");
      expect(kinds(t)).toContain("fail:catan@laptop");
    });

    it("5232 · вопрос — ответ вариантом прямо из карточки; answered убирает карточку", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      const q = { question: "q1", kind: "ask", questions: [{ question: "База?", options: [{ label: "стенд" }, { label: "прод" }] }] };
      let waiting = [q];
      t.relay.handlers["question.list"] = () => ({ ok: true, result: waiting });
      t.relay.handlers.answer = () => ((waiting = []), { ok: true, result: {} });
      t.relay.push({ type: "question", from: "anna@pc", ...q });
      await flush();
      // вопрос виден и у чужой сессии: кому — решает Host
      expect(kinds(t)[0]).toBe("q:anna@pc");
      await t.click(t.$$(".ib-it .ask-opt")[0]);
      await t.click(t.button("Ответить"));
      expect(t.relay.sent("answer")[0]).toMatchObject({ callsign: "anna@pc", question: "q1", answers: { "База?": "стенд" } });
      t.relay.push({ type: "answered", from: "anna@pc", question: "q1", by: "pult~you@mail", answers: { "База?": "стенд" } });
      await flush();
      expect(kinds(t)).not.toContain("q:anna@pc");
    });

    it("5233 · сообщение вам — карточка с текстом; «Открыть» — карточка сессии, сообщение прочитано", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.handlers["session.watch"] = () => ({ ok: true });
      t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      t.relay.push({ type: "message", from: "site@laptop", text: "Почистить кэш npm?" });
      await flush();
      expect(kinds(t)[0]).toBe("msg:site@laptop");
      expect(t.$('[data-kind="msg"] .ib-tx')!.textContent).toBe("Почистить кэш npm?");
      await t.click(t.$('[data-kind="msg"] button.pri'));
      expect(location.hash).toBe("#card?callsign=site%40laptop");
    });

    it("5234 · «готово»: моя сессия busy → idle, пока её не смотрят; «Прочитано» убирает; новый ход — снова", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => (r.sessions[0] = { ...r.sessions[0], state: "idle" })));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
      expect(t.$$(".ib-gh").map((x) => x.textContent)).toContain("Готово · 1");
      await t.click(t.button("Прочитано"));
      expect(kinds(t)).not.toContain("done:site@laptop");
      t.relay.setRoster(fleet());
      await flush();
      t.relay.setRoster(fleet((r) => (r.sessions[0] = { ...r.sessions[0], state: "idle" })));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
    });

    it("5235 · машина ушла — карточка машины с моими сессиями; вернулась — карточка ушла", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => {
        r.machines = r.machines.filter((m) => m.machine !== "pc");
        r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@pc"));
      }));
      await flush();
      expect(kinds(t)).toContain("away:pc");
      // чужая anna@pc в карточке не названа
      expect(t.$('[data-kind="away"] .ib-tx')!.textContent).toBe("night@pc");
      t.relay.setRoster(fleet());
      await flush();
      expect(kinds(t)).not.toContain("away:pc");
    });

    it("5236 · раздел «Вам» в колонке — счётчик карточек", async () => {
      const t = await stand(parts(), { roster: fleet(), wide: true });
      expect(t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent).toBe("Вам2");
    });
  });

  it("V-I1 · подписи: «Ждут ответа» с числом, «пишет вам», «спрашивает», проект сессии рядом", async () => {
    const relay = new FakeRelay(fleet());
    (relay as unknown as { scoped: unknown }).scoped = { global: { "fleet.projects": [{ id: "p1", name: "Сайт", sessions: ["site@laptop"] }] } };
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const t = await stand(parts(), { relay, url: "/#inbox" });
    t.relay.push({ type: "message", from: "site@laptop", text: "Готово?" });
    await flush(5);
    expect(t.$$(".ib-gh").map((x) => x.textContent)[0]).toBe("Ждут ответа · 1");
    expect(t.$('[data-kind="msg"] .ib-lb')!.textContent).toBe("пишет вам · Сайт");
    expect(t.$('[data-kind="fail"] .ib-lb')!.textContent).toBe("не запустилась");
    expect(t.$('[data-kind="wait"] .ib-lb')!.textContent).toBe("ждёт сброса лимита");
  });

  it("D-1 · «Почему» на телефоне ведёт к причине: «Ещё» со строкой сбоя; на пульте причина — на плашке карточки", async () => {
    // источник: спорное место сноса, опыт: кнопка «Почему» открывала чат, причины на экране не было
    const open = async (wide: boolean) => {
      const relay = new FakeRelay(fleet());
      relay.handlers["session.watch"] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const t = await stand(parts(), { relay, url: "/#inbox", wide, options: wide ? { beside: { card: "board" } } : {} });
      await t.click([...t.$('[data-kind="fail"]')!.querySelectorAll("button")].find((b) => b.textContent === "Почему")!);
      await flush(5);
      return t;
    };
    const phone = await open(false);
    expect(phone.$(".card-info")!.textContent).toContain("сбойhost: процесс claude завершился дважды до готовности");
    const wide = await open(true);
    expect(wide.$(".cw-pl b")!.textContent).toBe("Не запустилась: host: процесс claude завершился дважды до готовности");
  });
});

describe("Вам: виды карточек", () => {
  const parts = (extra: Array<{ manifest: Manifest; module: () => AppModule }> = []) => [
    { manifest: inboxM, module: createInbox },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
    // когда машина ушла, знает её владелец: настоящий модуль машин
    { manifest: machinesM, module: createMachines },
    ...extra,
  ];

  /** Подделка модуля точек: метка fire — какие машины не на связи; экран точек нужен только как цель кнопки. */
  const points = (fire: string[]) => ({
    manifest: { name: "pult-points", type: "web", version: "1.0.0", provides: { fire: 2, points: 1 }, uses: {} } as Manifest,
    module: () => ({ marks: { fire: () => fire }, screens: { points: { nav: "Точки", label: "Точки", view: () => null } } }) as AppModule,
  });

  /** Я — phone~you@mail. site и mine@pc мои; anna@pc чужая. */
  function fleet(over: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    r.sessions = [
      { callsign: "site@laptop", state: "busy", dir: "~/Projects/site", by: "phone~you@mail" },
      { callsign: "mine@pc", state: "idle", dir: "~/p", by: "phone~you@mail" },
      { callsign: "anna@pc", state: "busy", dir: "~/p", by: "laptop~anna@mail" },
    ];
    r.clients = ["phone~you@mail", "laptop~anna@mail"];
    over(r);
    return r;
  }
  const idle = (r: Roster, i = 0) => void (r.sessions[i] = { ...r.sessions[i], state: "idle" });

  type T = Awaited<ReturnType<typeof stand>>;
  const kinds = (t: T) => t.$$(".ib-it").map((x) => `${x.dataset.kind}:${x.dataset.callsign ?? x.dataset.machine ?? ""}`);
  const withRelay = async (o: Parameters<typeof stand>[1] = {}, list = parts()) => {
    const t = await stand(list, o);
    t.relay.handlers["session.watch"] ??= () => ({ ok: true });
    t.relay.handlers["session.unwatch"] ??= () => ({ ok: true });
    t.relay.handlers["session.history"] ??= () => ({ ok: true, result: { messages: [] } });
    t.relay.handlers["question.list"] ??= () => ({ ok: true, result: [] });
    return t;
  };

  describe("«готово»", () => {
    it("6960 · открыли карточку сессии — «готово» снято переходом и не возвращается", async () => {
      // источник: устав — части пользуются контрактом; чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
      await t.go("#card?callsign=site%40laptop");
      await t.go("#inbox");
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6961 · сессию смотрят, когда она закончила — «готово» не появляется", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#card?callsign=site%40laptop" });
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      await t.go("#inbox");
      expect(t.text()).toContain("Всё разобрано");
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6963 · «Прочитано»: метка «Вам» меньше на одну; новый roster с той же idle карточку не возвращает", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), wide: true, url: "/#inbox" });
      const nav = () => t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent;
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(nav()).toBe("Вам1");
      await t.click(t.button("Прочитано"));
      expect(nav()).toBe("Вам");
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6964 · чужая сессия закончила, упала или ждёт лимит — карточек нет", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      expect(t.text()).toContain("Всё разобрано");
      t.relay.setRoster(fleet((r) => idle(r, 2)));
      await flush();
      expect(kinds(t)).toEqual([]);
      t.relay.setRoster(fleet((r) => (r.sessions[2] = { ...r.sessions[2], state: "failed", slot: { name: "main", wait: 1_900_000_000 } })));
      await flush();
      expect(kinds(t)).toEqual([]);
    });
  });

  describe("вопрос и сообщение", () => {
    it("6965 · вопрос и сообщение — у чужой тоже; у одной сессии и то и другое — только вопрос", async () => {
      // источник: устав — AskUserQuestion получают зрители сессии; чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      const ask = (from: string, id: string) => ({ type: "question", from, to: ["phone"], question: id, kind: "ask", questions: [{ question: `Вопрос ${from}?`, header: "В", options: [{ label: "да" }] }] });
      t.relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "anna@pc" ? [ask("anna@pc", "q1")] : f.callsign === "site@laptop" ? [ask("site@laptop", "q2")] : [] });
      t.relay.push(ask("anna@pc", "q1"));
      t.relay.push({ type: "message", from: "mine@pc", to: "phone", text: "Готов отчёт" });
      t.relay.push(ask("site@laptop", "q2"));
      t.relay.push({ type: "message", from: "site@laptop", to: "phone", text: "И сообщение" });
      await flush();
      expect(kinds(t).sort()).toEqual(["msg:mine@pc", "q:anna@pc", "q:site@laptop"]);
      expect(t.$('[data-kind="msg"]')!.textContent).toContain("Готов отчёт");
    });
  });

  describe("машины", () => {
    const without = (r: Roster, m: string) => {
      r.machines = r.machines.filter((x) => x.machine !== m);
      r.sessions = r.sessions.filter((s) => !s.callsign.endsWith(`@${m}`));
    };

    it("6967 · ушла машина с моими сессиями: «не на связи с ЧЧ:ММ», только мои, «Поднять из точки»", async () => {
      // источник: устав — соединение с объектом машины оборвалось
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(["pc"])]));
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      const card = t.$('[data-kind="away"]')!;
      expect(card.textContent).toMatch(/не на связи с \d\d:\d\d/);
      expect(card.querySelector(".ib-tx")!.textContent).toBe("mine@pc");
      expect(card.textContent).toContain("Поднять из точки");
    });

    it("6968 · ушла машина только с чужими сессиями — карточки нет", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet((r) => (r.sessions = r.sessions.filter((s) => s.callsign !== "mine@pc"))), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      expect(kinds(t)).toEqual([]);
      expect(t.text()).toContain("Всё разобрано");
    });

    it("6969 · машины ушли до открытия: метка fire — три машины, при открытом ушла одна из них — «машин не на связи: 2» и «Поднять из точки»", async () => {
      // источник: факт — ушли раньше, чем открыто приложение, знает модуль точек
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(["old1", "old2", "pc"])]));
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      const fire = t.$('[data-kind="fire"]')!;
      expect(fire.textContent).toContain("машин не на связи: 2");
      expect(fire.textContent).toContain("Поднять из точки");
    });

    it("7250 · время ухода — у владельца: карточка показывает время из метки machines.gone, а не считает своё", async () => {
      // источник: гейт архитектора «дубликат состояния не пропускается»
      const at = new Date(2026, 10, 4, 3, 7).getTime();
      const gone = {
        manifest: { name: "pult-machines", type: "web", version: "1.0.0", provides: { "machines.gone": 1 }, uses: {} } as Manifest,
        module: () => ({ marks: { "machines.gone": () => ({ pc: at }) } }) as AppModule,
      };
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts().filter((p) => p.manifest.name !== "pult-machines").concat(gone));
      expect(t.$('[data-kind="away"]')!.textContent).toContain("не на связи с 03:07");
    });

    it("6970 · всё разобрано: «Всё разобрано», метка «Вам» без числа", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), wide: true, url: "/#inbox" });
      expect(t.text()).toContain("Всё разобрано");
      expect(t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent).toBe("Вам");
    });
  });

  it("V-I2 · имя сессии в карточке открывает её; «Поднять из точки» — экран точек, в обеих карточках машин", async () => {
    const t = await withRelay({ roster: fleet((r) => (r.sessions[1] = { ...r.sessions[1], state: "failed" })), url: "/#inbox" }, parts([points(["pc", "old"])]));
    await t.click(t.$('[data-kind="fail"] .ib-cs'));
    expect(location.hash).toBe("#card?callsign=mine%40pc");
    await t.go("#inbox");
    await t.click(t.$('[data-kind="fire"] button.pri'));
    expect(location.hash).toBe("#points");
    await t.go("#inbox");
    t.relay.setRoster(fleet((r) => {
      r.machines = r.machines.filter((x) => x.machine !== "pc");
      r.sessions = r.sessions.filter((x) => !x.callsign.endsWith("@pc"));
    }));
    await flush(5);
    await t.click(t.$('[data-kind="away"] button.pri'));
    expect(location.hash).toBe("#points");
  });
});

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

    it("V-O1 · подписи: поля, окна чипов, последние места; профиль — машина и число; поиск профиля; окно модели — подписи и «Точки в R2»", async () => {
      const relay = openRelay();
      relay.values["pult-open.recent"] = [{ m: "pc", dir: "~/p" }];
      const t = await openScreen(relay);
      expect(addr(t).getAttribute("aria-label")).toBe("Адрес папки");
      expect(t.$(".op-rec")!.getAttribute("aria-label")).toBe("Последние места");
      const text = t.$<HTMLTextAreaElement>('[data-f="text"]')!;
      expect([text.placeholder, text.getAttribute("aria-label")]).toEqual(["Что сделать?", "Задача"]);
      expect(t.$('[data-place-machine="pc"]')!.textContent).toBe("@pc ~/p");
      expect(t.$(".op-bl")!.getAttribute("aria-label")).toBe("Машины");
      await t.click(t.$('[data-pop="prof"]'));
      expect(t.$(".op-pop")!.getAttribute("aria-label")).toBe("Выбор");
      expect(t.$(".op-pop .lb")!.textContent).toBe("Профиль · @laptop · 2");
      expect(t.$('[data-profile="team/profiles/ops"] .sp')!.textContent).toBe("opus · высокое");
      const pq = t.$<HTMLInputElement>('[data-f="pq"]')!;
      expect([pq.placeholder, pq.getAttribute("aria-label")]).toEqual(["Найти профиль", "Найти профиль"]);
      await t.type(pq, "writer");
      expect(t.$$(".op-pr[data-profile]").map((b) => b.dataset.profile)).toEqual(["team/profiles/writer", ""]);
      await t.click(t.$('[data-profile="team/profiles/writer"]'));
      expect(t.$('[data-pop="prof"] .k')!.textContent).toBe("Профиль");
      await t.click(t.$('[data-pop="model"]'));
      expect(t.$$(".op-pop .lb").map((x) => x.textContent).slice(0, 2)).toEqual(["Модель", "Усилие"]);
      expect(t.$(".op-sw")!.textContent).toContain("Точки в R2");
      expect(t.$("[data-r2]")!.getAttribute("aria-label")).toBe("Точки в R2");
      await t.click(t.$("[data-r2]"));
      expect(t.$('[data-pop="model"] .k')!.textContent).toContain("R2");
      // без выбора — слово «Модель» на чипе; Ctrl Enter запускает
      const t2 = await openScreen(openRelay(), "/#open?machine=laptop&dir=~%2Fzz");
      expect(t2.$('[data-pop="model"] .k')!.textContent).toContain("Модель");
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
  const chipModel = (t: T) => t.$('[data-pop="model"]')!;
  const chipProf = (t: T) => t.$('[data-pop="prof"] b')!.textContent;
  const start = (t: T) => t.click(t.$('[data-act="open"]'));

  describe("новая сессия: выбор", () => {
    it("7254 · машина научилась точкам при открытом окне модели — переключатель появляется", async () => {
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
      await t.click(chipModel(t));
      expect(t.$("[data-r2]")).toBeNull();
      relay.setRoster(fleetRoster());
      await flush(5);
      expect(t.$("[data-r2]")).not.toBeNull();
    });

    it("6910 · другая машина: профиль и слот снова по умолчанию", async () => {
      // источник: чьё: код — выбранных там может не быть
      const t = await openScreen();
      await t.click(t.$('[data-pop="prof"]'));
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      await t.click(chipModel(t));
      await t.click(t.$('[data-slot="night"]'));
      expect(chipModel(t).textContent).toContain("night");
      await t.click(t.$('.op-bl [data-machine="pc"]'));
      await flush(5);
      expect(chipProf(t)).toBe("без профиля");
      expect(chipModel(t).textContent).toContain("main");
      expect(chipModel(t).textContent).not.toContain("night");
    });

    it("6911 · модель выбрана человеком: не следует за профилем; не выбрана — следует", async () => {
      // источник: чьё: код
      const t = await openScreen();
      await t.click(t.$('[data-pop="prof"]'));
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(chipModel(t).querySelector("b")!.textContent).toBe("opus");
      await t.click(chipModel(t));
      await t.click(t.$('[data-model="sonnet"]'));
      await t.click(t.$('[data-pop="prof"]'));
      await t.click(t.$('[data-profile=""]'));
      await t.click(t.$('[data-pop="prof"]'));
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      expect(chipModel(t).querySelector("b")!.textContent).toBe("sonnet");
    });

    it("6912 · slots и profiles отказали: слово в окне своего чипа; форма работает, запуск доступен", async () => {
      // источник: устав — отказ словом
      const relay = openRelay();
      relay.handlers[SLOTS] = () => ({ ok: false, error: "offline" });
      relay.handlers["machine.profiles"] = () => ({ ok: false, error: "no_repo" });
      const t = await openScreen(relay);
      await t.click(t.$('[data-pop="prof"]'));
      expect(t.$(".op-pop")!.textContent).toContain("machine.profiles: no_repo");
      await t.click(chipModel(t));
      expect(t.$(".op-pop")!.textContent).toContain("machine.accounts: offline");
      await named(t, "a");
      await start(t);
      expect(relay.sent("session.open")).toEqual([expect.objectContaining({ machine: "laptop", name: "a" })]);
    });

    it("6915 · модель уходит в session.open, только если выбрана", async () => {
      // источник: факт — модель значит, когда выбрана человеком
      const first = openRelay();
      const t = await openScreen(first);
      await t.click(t.$('[data-pop="prof"]'));
      await t.click(t.$('[data-profile="team/profiles/ops"]'));
      await named(t, "a");
      await start(t);
      expect(first.sent("session.open")[0]).toMatchObject({ profile: "team/profiles/ops" });
      expect(first.sent("session.open")[0]).not.toHaveProperty("model");
      expect(first.sent("session.open")[0]).not.toHaveProperty("effort");
      const second = openRelay();
      const t2 = await openScreen(second);
      await t2.click(chipModel(t2));
      await t2.click(t2.$('[data-model="sonnet"]'));
      await named(t2, "b");
      await start(t2);
      expect(second.sent("session.open")[0]).toMatchObject({ model: "sonnet" });
    });

    it("6918 · машина не умеет slots, profiles и r2: запросов нет, слов отказа нет, переключателя нет", async () => {
      // источник: факт — машина такого запроса не умеет: не спрашиваем, данных нет
      const r = fleetRoster();
      for (const n of ["machine.accounts", "machine.profiles", "session.r2"]) delete r.machines[0].contract![n];
      const relay = openRelay(r);
      const t = await openScreen(relay);
      await t.click(t.$('[data-pop="prof"]'));
      expect(t.$(".op-pop .op-err")).toBeNull();
      await t.click(chipModel(t));
      expect(t.$(".op-pop .op-err")).toBeNull();
      expect(t.$("[data-r2]")).toBeNull();
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
      await t.click(chipModel(t));
      expect(t.$('[data-slot="main"]')).toBeNull();
      await t.click(t.$('[data-pop="prof"]'));
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
      await t.click(chipModel(t));
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

    it("4192 · машина вернулась при закрытом экране «Машины» — keeper.state не шлётся", async () => {
      // источник: факт цикла тестов 2 нояб. — пульт опрашивал вернувшуюся машину и при закрытом экране; при открытии экран спрашивает все машины сам
      const relay = machinesRelay();
      const t = await pult({ relay });
      await flush(10);
      const r = fleetRoster();
      relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
      await flush(10);
      expect(relay.sent("keeper.state")).toHaveLength(0);
      await t.go("#accounts");
      expect(relay.sent("keeper.state").length).toBeGreaterThan(0);
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

    it("4153 · машина впервые в roster при открытом экране — keeper.state, а не «…»", async () => {
      const r = fleetRoster();
      r.machines = r.machines.filter((m) => m.machine !== "pc");
      const relay = machinesRelay(r);
      const t = await machines(relay);
      // машина pc вошла гостем на laptop — клиент флота открыл соединение с её relay
      const full = fleetRoster();
      full.clients = [...full.clients, "@pc"];
      relay.setRoster(full);
      await flush(10);
      expect(relay.sent("keeper.state").map((f) => f.to)).toContain(".keeper@pc");
      await expand(t, "pc");
      expect(t.$('[data-machine="pc"] [data-keeper]')!.textContent).toBe("1.0.1 · план rev 7");
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
        ["no_release", "такой версии нет"],
        ["no_build", "приложение не собирается «Выпусками»"],
        ["no_part", "такой части нет"],
        ["cf_failed", "Cloudflare не принял"],
        ["bad_version", "номер версии не того вида"],
        ["name_taken", "у адреса уже есть живой пропуск — сначала отзовите прежний"],
        ["unknown_key", "такого пропуска нет"],
        ["not_installed", "приложение GitHub не допущено к репозиторию"],
        ["app_exists", "приложение GitHub флота уже есть"],
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
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    await t.click(t.$('[data-pop="model"]'));
    await t.click(t.$('[data-slot="main"]'));
    await t.click(t.$('[data-pop="model"]'));
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
      expect.objectContaining({ v: 1, machine: "laptop", name: "board", dir: "~/Projects/switchboard", slot: "main", profile: "team/profiles/ops" }),
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

  it("185 · модель и усилие — из шапки: session.update; кнопка — из следующего roster; профиль — чипом в «Настройках», session.profile, restart → «после хода»", async () => {
    const relay = fleetRelay();
    relay.handlers["session.update"] = () => ({ ok: true, result: { now: ["model", "effort"] } });
    relay.handlers["session.profile"] = () => ({ ok: true, result: { restart: true } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {}, "team/profiles/writer": {} }, repos: {} } });
    relay.handlers["session.spec"] = () => ({ ok: true, result: { dir: "~/Projects/site", model: "opus", effort: "high", title: "Сайт: сборка CI" } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.$('[data-pop="model"]'));
    await t.click(t.$('.cw-pop [data-model="sonnet"]'));
    await t.click(t.$('[data-pop="model"]'));
    await t.click(t.$('.cw-pop [data-effort="medium"]'));
    expect(relay.sent("session.update").map(({ id: _id, ...f }) => f)).toEqual([
      { type: "session.update", v: 1, callsign: "site@laptop", model: "sonnet" },
      { type: "session.update", v: 1, callsign: "site@laptop", effort: "medium" },
    ]);
    expect(t.$('[data-pop="model"]')!.textContent).toBe("opus · высокое ▾");
    const r = fleetRoster();
    Object.assign(r.sessions[2], { model: "sonnet", effort: "medium" });
    relay.setRoster(r);
    await flush();
    expect(t.$('[data-pop="model"]')!.textContent).toBe("sonnet · среднее ▾");
    await t.click(t.$('.cw-tabs [data-tab="set"]'));
    await t.click(t.$('[data-profile="team/profiles/writer"]'));
    expect(relay.sent("session.profile")).toEqual([expect.objectContaining({ callsign: "site@laptop", profile: "team/profiles/writer" })]);
    expect(t.$('[data-sec="profile"]')!.textContent).toContain("после хода");
  });

  it("186 · не запустилась: подсказка лампы и плашка с «Почему» — machine.journal с machine pc и session; «Запустить» в шапке — session.start", async () => {
    const relay = fleetRelay();
    relay.handlers["machine.journal"] = () => ({
      ok: true,
      result: { records: [{ t: "2026-10-31T13:58:03.902Z", part: "host", who: "journal", callsign: "api@pc", kind: "stop", ev: "sdk.result", word: "cwd_unavailable", why: "нет папки" }], more: false },
    });
    relay.handlers["session.start"] = () => ({ ok: true });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="api@pc"]'));
    expect(t.$(".cw-h .cw-lamp")!.getAttribute("title")).toBe("не запустилась: core: второй сбой до initialize");
    expect(t.$(".cw-pl b")!.textContent).toBe("Не запустилась: core: второй сбой до initialize");
    await t.click(t.btn(t.$(".cw-pl"), "Почему"));
    expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Журнал");
    // журнал машины карточки — с session; запросы журнала других модулей сюда не входят
    expect(relay.sent("machine.journal").filter((f) => f.session)).toEqual([expect.objectContaining({ v: 2, machine: "pc", session: "api@pc", limit: 50, since: expect.any(String) })]);
    expect(t.$(".cw-lr")!.textContent).toContain("sdk.result · cwd_unavailable · нет папки");
    await t.click(t.btn(t.$(".cw-h"), "Запустить"));
    expect(relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "api@pc" })]);
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
    await t2.click(t2.$('[data-pop="model"]'));
    await t2.click(t2.$("[data-r2]"));
    await t2.click(t2.$('[data-act="open"]'));
    const types = t2.relay.got.map((f) => f.type);
    expect(types.indexOf("session.r2")).toBeGreaterThan(types.indexOf("session.open"));
    expect(t2.relay.sent("session.r2")).toEqual([expect.objectContaining({ v: 1, callsign: "board@laptop", on: true })]);
    expect(t2.relay.sent("session.open")[0]).not.toHaveProperty("r2");
    expect(location.hash).toBe("#card?callsign=board%40laptop");
  });

  it("V-C5 · окно «Имена» из карточки на пульте и телефоне: открывается и закрывается", async () => {
    const relay = fleetRelay();
    const t = await pult({ relay, url: "/#card?callsign=site%40laptop" });
    await flush(5);
    await t.click(t.$('.cw-h [data-act="names"]'));
    expect(t.$(".lb-dlg")).not.toBeNull();
    await t.click(t.$(".lb-veil"));
    expect(t.$(".lb-dlg")).toBeNull();
    const relay2 = new FakeRelay(homeRoster());
    relay2.handlers["session.watch"] = () => ({ ok: true });
    relay2.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const n = await stand([{ manifest: labelsM, module: createLabels }, { manifest: boardM, module: createBoard }, { manifest: cardM, module: createCard }, { manifest: chatM, module: createChat }, { manifest: askM, module: createAsk }, { manifest: alertsM, module: createAlerts({}) }], { relay: relay2, url: "/#card?callsign=site%40laptop&tab=info" });
    await flush(5);
    await n.click(n.$('.card-act[data-act="names"]'));
    expect(n.$(".lb-dlg")).not.toBeNull();
    await n.click(n.$(".lb-veil"));
    expect(n.$(".lb-dlg")).toBeNull();
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

describe("Раскладка и «Моё» на пульте", () => {
  it("6904 · карточка открывается справа от списка «Работы»: список остаётся слева с выбранной строкой", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): список проекта слева, сессия справа
    const t = await pult();
    expect(t.$(".sb-split")).toBeNull();
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$(".sb-split .sb-master .bd-list")).not.toBeNull();
    expect(t.$(".sb-split .sb-detail .cw")).not.toBeNull();
    expect(t.$('.bd-row[aria-current="true"]')!.dataset.callsign).toBe("site@laptop");
    const master = t.$(".sb-master");
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    expect(t.$(".sb-master")).toBe(master);
    expect(t.$('.bd-row[aria-current="true"]')!.dataset.callsign).toBe("wiki@laptop");
  });

  it("6905 · закрепление: чужая сессия — «Закрепить» в шапке карточки → в «Моём» со значком; «Закреплена» — откреплена", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): «закрепление — моя на этом устройстве»
    const roster = fleetRoster();
    roster.sessions = roster.sessions.map((s) => (s.callsign === "wiki@laptop" ? { ...s, by: "laptop~anna@example.com" } : s));
    const t = await pult({ relay: fleetRelay(roster) });
    const mine = () => t.$$(".bd-row").map((b) => b.dataset.callsign);
    expect(mine()).not.toContain("wiki@laptop");
    await t.go("#card?callsign=wiki%40laptop");
    await t.click(t.$('.cw-h [data-screen="board.pin"]'));
    await flush(10);
    await t.go("#sessions");
    await t.expand();
    expect(mine()).toContain("wiki@laptop");
    expect(t.$('[data-callsign="wiki@laptop"] .bd-pin')).not.toBeNull();
    await t.go("#card?callsign=wiki%40laptop");
    await t.click(t.$('.cw-h [data-screen="board.unpin"]'));
    await flush(10);
    await t.go("#sessions");
    expect(mine()).not.toContain("wiki@laptop");
  });

  it("6906 · моё по цепочке: задачу дала моя сессия (by — позывной) — сессия в «Моём»; дала чужая — нет", async () => {
    // источник: прототип «Пульт и телефон»: «моё — дочерние моих»; живой флот 3 нояб.: flow-1@wsl с from flow@win была «чужой»
    const roster = fleetRoster();
    roster.sessions = roster.sessions.map((s) =>
      s.callsign === "wiki@laptop" ? { ...s, by: "site@laptop" } : s.callsign === "docs@pc" ? { ...s, by: "laptop~anna@example.com" } : s.callsign === "api@pc" ? { ...s, by: "docs@pc" } : s,
    );
    const t = await pult({ relay: fleetRelay(roster) });
    const mine = t.$$(".bd-row").map((b) => b.dataset.callsign);
    expect(mine).toContain("wiki@laptop");
    expect(mine).not.toContain("api@pc");
  });

  it("5219 · поиск сессии — Ctrl K: по позывному, без кадров; строка открывает карточку", async () => {
    // источник: прототип «Пульт и телефон»: «Найти сессию — Ctrl K, отдельного поиска в «Работе» нет»
    const t = await pult();
    const sent = t.relay.got.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
    input.value = "wiki";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toEqual(["wiki"]);
    expect(t.relay.got.length).toBe(sent);
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
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$("[data-no-slots]")!.textContent).toBe("На laptop нет слотов: войдите в аккаунт на этой машине");
    await named(t, "a");
    expect(t.$('[data-act="open"]')!.hasAttribute("disabled")).toBe(true);
    expect(relay.sent("session.open")).toHaveLength(0);
  });

  it("E24 · форма: 1 слот — строки нет, запрос без поля", async () => {
    const relay = openRelay({ main: slot() });
    const t = await openForm(relay);
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$("[data-slot-pick]")).toBeNull();
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
  });

  it("E24 · форма: 2 слота, человек не менял выбор — отмечен первый, запрос с ним; выбрал другой — с другим", async () => {
    const relay = openRelay({ main: slot(), bot: slot() });
    const t = await openForm(relay);
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$('[data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.click(t.$('[data-slot="bot"]'));
    expect(t.$('[data-slot="bot"]')!.getAttribute("aria-pressed")).toBe("true");
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).toMatchObject({ slot: "bot" });
  });

  it("E24 · единственный слот ждёт сброса: строки нет, подпись на чипе и в окне", async () => {
    const relay = openRelay({ main: slot(1793666400) });
    const t = await openForm(relay);
    expect(t.$('[data-pop="model"]')!.textContent).toContain("main · ждёт сброса");
    await t.click(t.$('[data-pop="model"]'));
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
  const accounts = () => ({ ok: true as const, result: { accounts: { y0902: { login: "ok", limits: { five_hour: { utilization: 0.42 }, seven_day: { utilization: 0.9 } } } }, slots: {} } });
  const cut = (...names: string[]) => {
    const r = fleetRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract };
      for (const n of names) delete m.contract[n];
    }
    return r;
  };

  it("карточка: процент на чипе — окно 5 ч; модель неактивна без session.update, без журнала нет «Почему»; плашка и без причины", async () => {
    const relay = fleetRelay(cut("session.update", "machine.journal"));
    relay.handlers["machine.accounts"] = accounts;
    const t = await pult({ relay, url: "/#card?callsign=api%40pc" });
    await flush(5);
    expect(t.$('[data-pop="acc"]')!.textContent).toBe("y0902 · 42 % ▾");
    expect(t.$<HTMLButtonElement>('[data-pop="model"]')!.disabled).toBe(true);
    expect(t.btn(t.$(".cw-pl"), "Почему")).toBeNull();
    const r = fleetRoster();
    r.sessions.find((s) => s.callsign === "docs@pc")!.state = "failed";
    const t2 = await pult({ relay: fleetRelay(r), url: "/#card?callsign=docs%40pc" });
    await flush(5);
    expect(t2.$(".cw-pl b")!.textContent).toBe("Не запустилась");
  });

  it("карточка: сессия ушла — вкладка настроек без кнопок, сведения пусты; адрес в шапке и без имени; ссылка claude.ai в сведениях", async () => {
    const r = fleetRoster();
    r.sessions.find((s) => s.callsign === "site@laptop")!.state = "idle";
    const relay = fleetRelay(r);
    const store = memoryStore({ key: KEY, "card.info": true, "card.head": { haddr: true, howner: true, hprof: true, hmodel: true } });
    const t = await pult({ relay, store, url: "/#card?callsign=site%40laptop&tab=set" });
    await flush(5);
    expect(t.$(".cw-real")!.textContent).toBe("site@laptop");
    expect(t.$<HTMLAnchorElement>("aside.cw-info .cw-mi.flat")!.href).toBe("https://claude.ai/code/session_01Pf");
    relay.setRoster({ ...r, sessions: r.sessions.filter((s) => s.callsign !== "site@laptop") });
    await flush(5);
    expect(t.$('[data-sec="ctl"] button')).toBeNull();
    expect(t.$("aside.cw-info")!.textContent).toBe("");
  });

  it("«Работа»: закреплённая чужая — значок без владельца; лампы свёрнутого и поиск — срочные первыми", async () => {
    const r = fleetRoster();
    r.sessions = r.sessions.map((s) => (s.callsign === "wiki@laptop" ? { ...s, by: "laptop~anna@example.com" } : s));
    const relay = fleetRelay(r);
    relay.values["web-board.pins"] = ["wiki@laptop"];
    relay.scoped.global = { "fleet.projects": [{ id: "all", name: "Все", sessions: r.sessions.map((s) => s.callsign) }] };
    const t = await pult({ relay });
    await flush(5);
    if (t.$('.pj-t[data-proj="all"]')!.getAttribute("aria-expanded") === "false") await t.click(t.$('.pj-t[data-proj="all"]'));
    expect(t.$('[data-callsign="wiki@laptop"] .bd-pin')).not.toBeNull();
    expect(t.$('[data-callsign="wiki@laptop"] .own')).toBeNull();
    await t.click(t.$('.pj-t[data-proj="all"]'));
    expect(t.$$(".lamps .sb-dot").map((x) => x.className.split(" ")[1])).toEqual(["bad", "wait", "busy", "busy", "stop", "idle"]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    expect([...document.querySelectorAll(".sb-palit .sb-dot")].slice(0, 2).map((x) => x.className.split(" ")[1])).toEqual(["bad", "wait"]);
  });

  it("окно фильтра: число выбранного у поля", async () => {
    const t = await pult();
    await t.click(t.$(".fc.add"));
    expect(t.$('[data-field="who"] .fe-l span')).toBeNull();
    await t.click(t.$('[data-field="who"] [data-v="mine"]'));
    expect(t.$('[data-field="who"] .fe-l span')!.textContent).toBe("1");
  });

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

  it("машины: открытый проект сужает сразу; нет machine.login — нет «Аккаунтов»; ушедшая — без кнопок; нет ответа — «…»", async () => {
    const r = cut("machine.login");
    const relay = fleetRelay(r);
    relay.handlers["keeper.state"] = () => undefined;
    relay.scoped = { global: { "fleet.projects": [{ id: "p1", name: "site", sessions: ["site@laptop"] }] } };
    const t = await pult({ relay, url: "/#card?callsign=site%40laptop" });
    await flush(5);
    await t.go("#machines");
    expect(t.$('[data-filter="project"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-filter="project"]')!.textContent).toBe("в проекте p1 1");
    await t.click(t.$('[data-row="laptop"] .mc-head'));
    expect(t.$('[data-machine="laptop"] .sb-note')!.textContent).toBe("…");
    expect(t.btn(t.$('[data-machine="laptop"]'), "Аккаунты машины")).toBeNull();
    expect(t.btn(t.$('[data-machine="laptop"]'), "План в «Выпусках»")).not.toBeNull();
    relay.setRoster({ ...r, machines: r.machines.filter((m) => m.machine !== "laptop") });
    await flush(5);
    expect(t.$('[data-machine="laptop"] button')).toBeNull();
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

  it("«Вам»: готово после запуска, но не после ответа на вопрос; карточка лимита — зелёная лампа", async () => {
    const r = fleetRoster();
    const at = (state: string, slot?: unknown) => ({ ...r, sessions: r.sessions.map((s) => (s.callsign === "wiki@laptop" ? { ...s, state, ...(slot ? { slot } : {}) } : s)) });
    const relay = fleetRelay(at("starting"));
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const t = await pult({ relay, url: "/#inbox" });
    await flush(5);
    relay.setRoster(at("idle"));
    await flush(5);
    expect(t.$('[data-kind="done"][data-callsign="wiki@laptop"]')).not.toBeNull();
    await t.click(t.btn(t.$('[data-kind="done"]'), "Прочитано"));
    relay.setRoster(at("waiting"));
    await flush(5);
    relay.setRoster(at("idle", { name: "night", wait: 1_900_000_000 }));
    await flush(5);
    expect(t.$('[data-kind="done"]')).toBeNull();
    expect(t.$('[data-kind="wait"] .sb-dot')!.className).toContain("idle");
  });
});
