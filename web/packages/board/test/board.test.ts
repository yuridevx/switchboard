// web-board на стенде. Источник свойств — дизайн «Сессии, проекты и профили» (блок «Эталоны», «найс делай» пользователя 3 нояб.),
// «чьё: код» — там, где свойство перенесено из прежнего кода (rank, whyMine, tree, line). Перетаскивание указателем — проход в браузере.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/relay";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createLabels, manifest as labelsM } from "@switchboard/web-labels";
import { memoryStore } from "@switchboard/web-core";
import { createBoard, manifest as boardM } from "../contract.ts";
import { orderFilters, placeTop } from "../src/rules.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: labelsM, module: createLabels() },
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
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
const relayWith = (values: Record<string, unknown> = {}) => Object.assign(new FakeRelay(fleet()), { values });
const start = (o: Parameters<typeof stand>[1] = {}) => stand(parts(), { relay: relayWith(), ...o }).then(async (t) => (await flush(5), t));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("список", () => {
  it("5210 · проект — последнее имя папки на любой машине; разделы: ждёт вас → работает → остальные; число сессий в заголовке", async () => {
    const t = await start();
    expect(projects(t)).toEqual(["switchboard", "pfarm"]);
    expect(t.$('.pjs[data-proj="switchboard"] .pj-t .n')!.textContent).toBe("4");
    expect(t.$('.pjs[data-proj="pfarm"] .pj-t .n')!.textContent).toBe("1");
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
    const t = await start({ relay: new FakeRelay(r) });
    expect(rows(t).slice(0, 4)).toEqual(["migrate@laptop", "refactor@laptop", "tests@laptop", "build@build"]);
    const kid = t.$('[data-callsign="tests@laptop"]')!;
    expect(kid.className).toBe("bd-row kid");
    expect(kid.style.paddingLeft).toBe("32px");
    await t.click(t.$(".fc.vw"));
    await t.click(t.$('[data-v="tree"]'));
    expect(t.$('[data-callsign="tests@laptop"]')!.className).toBe("bd-row");
  });

  it("5214 · в строках нет слов о состоянии — только лампа; под списком нет строки «ещё N»; вторая строка: вопрос → сбой → профиль и модель (чьё: код — line)", async () => {
    const r = fleet();
    r.sessions[0] = { ...r.sessions[0], state: "failed", failed: { start: "нет слота" } };
    const t = await start({ relay: new FakeRelay(r) });
    const text = t.$(".bd-body")!.textContent!;
    for (const w of ["свободна", "остановлена", "работает", "ждёт", "Ещё", "ещё"]) expect(text).not.toContain(w);
    expect(t.$('[data-callsign="refactor@laptop"] .tx.f')!.textContent).toBe("нет слота");
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
    const board = createBoard();
    const t = await stand([parts()[0], { manifest: boardM, module: board }, ...parts().slice(2)], { relay: relayWith() });
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
    const relay = relayWith({ "web-labels.names": { machines: { pc: "Домашний ПК" } } });
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
    expect(orderFilters(own, ["gone", "f1", "mine", "all"]).map((f) => f.id)).toEqual(["f1", "mine", "all", "f2"]);
    const relay = relayWith({ "web-board.filters": own, "web-board.row": ["f1", "mine", "all"] });
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
  it("5230 · закреплённые — сверху в своём порядке, ниже черта; невидимые в фильтре не сдвигаются при перестановке", async () => {
    expect(placeTop(["a", "hidden", "b"], "c", ["a", "b"], 1)).toEqual(["a", "hidden", "c", "b"]);
    expect(placeTop(["a", "b"], "b", ["a", "b"], null)).toEqual(["a"]);
    expect(placeTop([], "x", [], 0)).toEqual(["x"]);
    const t = await start({ relay: relayWith({ "web-board.top": ["pfarm"] }) });
    expect(projects(t)).toEqual(["pfarm", "switchboard"]);
    expect(t.$(".lst > .pin-sep")).not.toBeNull();
    expect(t.$('.pjs[data-proj="pfarm"]')!.classList.contains("pinned")).toBe(true);
  });

  it("5231 · стрелки на ручке: вверх — закрепить, ещё вниз — открепить; фокус остаётся на ручке; пишется только web-board.top", async () => {
    const relay = relayWith();
    const t = await start({ relay });
    const press = async (proj: string, key: string) => {
      const g = t.$(`.grip[data-proj="${proj}"]`)!;
      g.focus();
      g.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      await flush(5);
    };
    await press("switchboard", "ArrowUp");
    expect(relay.values["web-board.top"]).toEqual(["switchboard"]);
    expect(document.activeElement).toBe(t.$('.grip[data-proj="switchboard"]'));
    await press("pfarm", "ArrowUp");
    expect(projects(t)).toEqual(["switchboard", "pfarm"]);
    await press("pfarm", "ArrowUp");
    expect(projects(t)).toEqual(["pfarm", "switchboard"]);
    await press("switchboard", "ArrowDown");
    expect(relay.values["web-board.top"]).toEqual(["pfarm"]);
    expect(new Set(relay.sent("prefs.set").map((f) => f.name))).toEqual(new Set(["web-board.top"]));
  });

  it("5232 · roster при перестановке: список не перерисован, после посадки — один рисунок с новыми данными", async () => {
    const relay = relayWith();
    const t = await start({ relay });
    const lst = t.$(".lst");
    t.$(".bd-list")!.classList.add("reordering");
    relay.setRoster({ ...relay.roster, sessions: relay.roster.sessions.filter((s) => s.callsign !== "build@build") });
    await flush(5);
    expect(t.$(".lst")).toBe(lst);
    t.$(".bd-list")!.classList.remove("reordering");
    relay.setRoster({ ...relay.roster });
    await flush(5);
    expect(rows(t)).not.toContain("build@build");
  });

  it("5233 · roster при фокусе на ручке: фокус на месте, следующая стрелка переставляет дальше", async () => {
    const relay = relayWith();
    const t = await start({ relay });
    t.$('.grip[data-proj="pfarm"]')!.focus();
    relay.setRoster({ ...relay.roster });
    await flush(5);
    expect(document.activeElement).toBe(t.$('.grip[data-proj="pfarm"]'));
  });
});

describe("настройки у почты", () => {
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
    for (const k of ["switchboard", "pfarm", "pfarm"]) {
      const g = t.$(`.grip[data-proj="${k}"]`)!;
      g.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    }
    expect(projects(t)).toEqual(["pfarm", "switchboard"]);
    await flush(5);
    expect(relay.sent("prefs.get").length - gets).toBe(1);
    expect(relay.sent("prefs.set")).toHaveLength(1);
    expect(relay.values["web-board.top"]).toEqual(["pfarm", "switchboard"]);
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

  it("5246 · закрепления прежней версии с устройства переходят к почте один раз; закреплённое на другом устройстве остаётся", async () => {
    const store = memoryStore({ key: KEY, pins: ["docs@pc"] });
    const relay = relayWith({ "web-board.pins": ["note@pc"] });
    const t = await start({ relay, store });
    await flush(5);
    expect(relay.values["web-board.pins"]).toEqual(["note@pc", "docs@pc"]);
    expect(await store.get("pins")).toEqual([]);
    await t.expand();
    expect(rows(t)).toContain("docs@pc");
    expect(relay.sent("prefs.set")).toHaveLength(1);
  });

  it("5242 · prefs отказал: «Моё» и «Всё» работают, своих нет; изменение — отказ словом, prefs.set не уходит", async () => {
    const relay = relayWith();
    relay.handlers["prefs.get"] = () => ({ ok: false, error: "not_user" });
    const t = await start({ relay });
    expect(chips(t)).toEqual(["mine", "all"]);
    expect(rows(t)).toContain("migrate@laptop");
    const g = t.$('.grip[data-proj="pfarm"]')!;
    g.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
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
    expect(relay.values["web-board.top"]).toEqual(["pfarm"]);
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
      ['[data-v="pjcount"]', ".pj-t .n"],
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

  it("5251 · без «По проектам» — плоский список в любом фильтре: ждут вас → работают → по имени, проект — в строке; «По машинам» недоступно", async () => {
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
    expect(t.$$('.pjs[data-proj="switchboard"] .mgrp').map((x) => x.dataset.group)).toEqual(["laptop", "pc", "build"]);
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
  it("5260 · заданное имя — вместо адреса в строке и поиске; поиск находит и по имени; адреса в основном виде нет", async () => {
    const relay = relayWith({ "web-labels.names": { sessions: { "migrate@laptop": "Переезд" }, machines: { laptop: "Домашний ПК" } } });
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
