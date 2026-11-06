// Леса границы «обзор флота на странице»: «Работа» — список сессий, фильтры, порядок, вид. Жесты перетаскивания указателем проверяются в браузере: npm run drag — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModule, AppPart, Roster } from "@switchboard/web-core";
import { memoryStore } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createLabels, manifest as labelsM } from "@switchboard/web-labels";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, pult } from "./stand.ts";

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
      { callsign: "refactor@laptop", state: "busy", dir: "~/Projects/switchboard", by: "pult~you@mail", model: "opus", profile: [{ id: "you/profiles/switchboard", state: "ok" }] },
      { callsign: "tests@pc", state: "busy", dir: "~/projects/switchboard", parent: "refactor@laptop", by: "refactor@laptop", model: "sonnet", profile: [{ id: "you/profiles/ci", state: "ok" }] },
      { callsign: "migrate@laptop", state: "waiting", dir: "~/Projects/switchboard", by: "phone~you@mail", model: "opus", profile: [{ id: "you/profiles/switchboard", state: "ok" }] },
      { callsign: "build@build", state: "idle", dir: "~/src/switchboard", by: "pult~you@mail", model: "sonnet", profile: [{ id: "you/profiles/ci", state: "ok" }] },
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

  describe("пара", () => {
    /** refactor@laptop — ведущий, его ведомый ждёт ответа на своём ключе флота. */
    const paired = () => {
      const relay = relayWith();
      relay.roster.sessions.push({ callsign: "refactor-wing@laptop", state: "waiting", dir: "~/Projects/switchboard", parent: "refactor@laptop", wing: true, model: "haiku", slot: { name: "orca" }, profile: { id: "you/profiles/ci", state: "ok" } });
      return relay;
    };
    const row = (t: T) => t.$('[data-callsign="refactor@laptop"]')!;

    it("8108 · список «Работа» с парой: одна строка с двумя лампами, дочерней строки ведомого нет; профиль ведомого — только если другой; слов о ролях нет (слово пользователя 5 нояб.: «снаружи выглядит как одна сессия»)", async () => {
      const t = await start({ relay: paired() });
      await t.expand();
      expect(rows(t)).not.toContain("refactor-wing@laptop");
      expect(rows(t).filter((c) => c === "refactor@laptop")).toHaveLength(1);
      expect(row(t).querySelectorAll(".sb-dot")).toHaveLength(2);
      expect(row(t).querySelector(".bd-pr")!.textContent).toBe("switchboardopus▸cihaiku orca");
      expect(row(t).textContent).not.toMatch(/ведущ|ведом/i);
      await t.click(t.$('[data-fid="all"]'));
      await t.expand();
      expect(rows(t)).not.toContain("refactor-wing@laptop");
    });

    it("вид списка: «Слот» и «Пара» — ключи группы «Строка»; без «Пары» строка как обычная (чьё: слово пользователя 6 нояб. к прототипу)", async () => {
      const t = await start({ relay: paired() });
      await t.expand();
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('[data-v="slot"]'));
      expect(row(t).querySelector(".bd-pr")!.textContent).toBe("switchboardopus▸cihaiku");
      await t.click(t.$('[data-v="wing"]'));
      expect(row(t).querySelector(".bd-pr")).toBeNull();
      expect(row(t).querySelectorAll(".sb-dot")).toHaveLength(1);
      expect(row(t).querySelector(".bd-t2")!.textContent).toBe("switchboardopus");
    });

    it("ждёт только ведомый: проект ведущего раскрыт на первом показе (чьё: код — проект раскрыт, если в нём ждут вас)", async () => {
      const relay = paired();
      relay.roster.sessions = relay.roster.sessions.map((s) => (s.callsign === "migrate@laptop" ? { ...s, state: "idle" } : s));
      const t = await start({ relay });
      expect(t.$('.pjs[data-proj="switchboard"] .bd-row')).not.toBeNull();
    });
  });

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

    it("5216 · метки: mine — почему моя; project.machines — машины сессий проекта; project.current — последний открытый", async () => {
      // источник: бэклог 3 нояб., слепой архитектор «Сессии, проекты и профили»: gate допускает phone~a и phone~b одновременно, «моё» — по адресу пропуска от gate
      let board!: AppModule;
      const relay = relayWith();
      relay.roster.clients = ["phone~anna@mail", "phone~you@mail"];
      relay.you = "phone~you@mail";
      const t = await stand([parts()[0], { manifest: boardM, module: (app) => (board = createBoard(app)) }, ...parts().slice(2)], { relay });
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
          // формат записи: в фильтре — имя профиля, а не номер
          { id: "e", name: "ci", profiles: ["ci"] },
        ],
      });
      const t = await start({ relay });
      // числа в чипах нет (правило пользователя 6 нояб.): сколько сессий проходит — видно по списку
      const count = async (id: string) => {
        await t.click(t.$(`[data-fid="${id}"]`));
        await t.expand();
        return t.$$(".bd-row").length;
      };
      expect(await count("a")).toBe(3);
      expect(await count("b")).toBe(2);
      expect(await count("c")).toBe(2);
      expect(await count("d")).toBe(1);
      expect(await count("e")).toBe(2);
      expect(await count("mine")).toBe(5);
      expect(await count("all")).toBe(7);
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

    it("5241 · три быстрые правки подряд: на экране до таймера — в том же кадре; записана последняя", async () => {
      // источник: отложенная строка упала на новом коде; видимое человеку — кадр, а не конец обработчика: ядро считает выборки на микрозадаче
      const relay = relayWith();
      const t = await start({ relay });
      for (const k of ["switchboard", "pfarm", "switchboard"]) {
        t.$(`.grip[data-proj="${k}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      expect(projects(t)).toEqual(["pfarm", "switchboard"]);
      await flush(10);
      const ids = (relay.scoped.global["fleet.projects"] as Array<{ id: string }>).map((x) => x.id);
      expect(ids.indexOf("pfarm")).toBeLessThan(ids.indexOf("switchboard"));
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
      ["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "Значок", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"],
      ["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"],
    ];

    it("V-B1 · панель вида: группы, подпись и полное название каждой единицы; телефон — «Готово» и нет «Шапки»; пульт — «✕» и группа шапки", async () => {
      const t = await start();
      await t.click(t.$(".fc.vw"));
      const panel = t.$(".bd-vw")!;
      expect([panel.getAttribute("role"), panel.getAttribute("aria-label")]).toEqual(["dialog", "Вид списка"]);
      expect(panel.querySelector(".vw-h b")!.textContent).toBe("Вид списка");
      for (const title of ["Список", "Строка", "Проект"]) expect(panel.textContent).toContain(title);
      expect(panel.textContent).not.toContain("Фильтры");
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
      for (const [k, label, full] of [["hat", "Машина", "Машина в шапке"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"], ["hacc", "Аккаунт", "Аккаунт и лимит в шапке"]]) {
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
      // фокус забирает нажатие мыши: без этого поле уходит раньше клика и меню закрывается
      const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      t.$('[data-act="project-remove"]')!.dispatchEvent(mouse);
      expect(mouse.defaultPrevented).toBe(true);
      await t.click(t.$("[data-new]"));
      expect(location.hash).toBe("#open");

      const w = await start({ wide: true, options: { beside: { card: "board" } } });
      const open = w.$(".bd-lh [data-new]")!;
      expect(open.textContent).toBe("Новая");
      expect(w.$(".bd-lh b")!.textContent).toBe("Работа");
    });

    it("V-B6 · шапка карточки настраивается в панели вида: машина, владелец, аккаунт прячутся", async () => {
      const relay = withLabels({ sessions: { "docs@pc": "Доки" } });
      relay.handlers["session.watch"] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      const store = memoryStore({ key: KEY });
      const t = await start({ relay, store, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=docs%40pc" });
      expect(t.$(".cw-at")).not.toBeNull();
      expect(t.$$(".cw-pill").map((x) => x.textContent)).toContain("anna@mail");
      await t.click(t.$(".fc.vw"));
      await t.click(t.$('.bd-vw [data-v="hat"]'));
      await t.click(t.$('.bd-vw [data-v="howner"]'));
      expect(t.$(".cw-at")).toBeNull();
      expect(t.$$(".cw-pill").map((x) => x.textContent)).not.toContain("anna@mail");
      expect(await store.get("card.head")).toMatchObject({ hat: false, howner: false });
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
      await t.go("#open");
      expect(t.current()).toBe("pfarm");

      const relay = relayWith();
      relay.handlers["prefs.get"] = () => undefined;
      const t2 = await start({ relay, url: "/#card?callsign=api%40pc" });
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

      const store2 = memoryStore({ key: KEY, "card.head": { hat: false, howner: false, hprof: true, hmodel: true, hacc: true } });
      const t2 = await start({ store: store2, wide: true, options: { beside: { card: "board" } } });
      await t2.click(t2.$(".fc.vw"));
      await t2.click(t2.$('[data-act="view-reset"]'));
      await flush(3);
      expect(await store2.get("card.head")).toMatchObject({ hat: true, howner: true });
    });
  });
});

describe("Раскладка и «Моё» на пульте", () => {
  it("6904 · карточка открывается справа от списка «Работы»: список остаётся слева с выбранной строкой", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): список проекта слева, сессия справа
    // слово пользователя 6 нояб.: «Работа» сразу открывает сессию — прежнюю или первую по отбору
    const t = await pult();
    expect(t.$(".sb-split .sb-detail .cw")).not.toBeNull();
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

});

describe("Найдено сверкой деревьев", () => {
  // источник: чьё: код — разметка и правила, которые снимки и прежние леса не держали; сверка деревьев старого и нового кода 5 нояб.
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

  it("вторая строка: вопрос, затем сбой, затем непрочитанное; ламп свёрнутого — шесть, внутри срочности по адресу", async () => {
    // источник: комментарии старого кода, сверка 6 нояб.: «одно из вопрос, сбой, непрочитанное», «ламп больше не помещается», «внутри — по адресу»
    const r = fleetRoster();
    r.sessions = [...r.sessions, ...["a", "b", "c"].map((n) => ({ callsign: `${n}@pc`, state: "idle", dir: "~", by: "panel-desk~owner@example.com" }))];
    r.sessions = r.sessions.map((s) => (s.callsign === "site@laptop" ? { ...s, state: "failed", failed: { host: "код 1" } } : s));
    const relay = fleetRelay(r);
    relay.scoped.global = { "fleet.projects": [{ id: "all", name: "Все", sessions: r.sessions.map((s) => s.callsign) }] };
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const t = await pult({ relay });
    await flush(5);
    t.relay.push({ type: "message", from: "site@laptop", text: "Готово?" });
    await flush(5);
    expect(t.$('[data-callsign="site@laptop"] .tx.f')!.textContent).toBe("host: код 1");
    await t.click(t.$('.fc[data-fid="all"]'));
    if (t.$('.pj-t[data-proj="all"]')!.getAttribute("aria-expanded") === "true") await t.click(t.$('.pj-t[data-proj="all"]'));
    expect(t.$$(".lamps .sb-dot").map((x) => x.className.split(" ")[1])).toEqual(["bad", "wait", "bad", "busy", "idle", "idle"]);
  });

  it("окно фильтра: числа выбранного у поля нет — выбранное видно само", async () => {
    const t = await pult();
    await t.click(t.$(".fc.add"));
    await t.click(t.$('[data-field="who"] [data-v="mine"]'));
    expect(t.$('[data-field="who"] [data-v="mine"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-field="who"] .fe-l span')).toBeNull();
  });
});
