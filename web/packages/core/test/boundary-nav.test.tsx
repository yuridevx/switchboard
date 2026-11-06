// Леса ядра страницы, вид: разделы, колонка и вкладки, шапка, полоса top, тост, поиск и остов разметки.
// Вход — контракт web-core и стенд, исход — разметка и адрес; на классах стоят стили и снимки. Номер — эталон-источник; без номера — чьё: код.
import { describe, expect, it, vi } from "vitest";
import type { AppModule, AppPart, StartOptions } from "../contract.ts";
import { stand } from "../stand/app.ts";
import { FakeRelay, flush, homeRoster, oneMachine } from "../stand/relay.ts";
import { attrs, ctrlK, key, man, mod, quiet, sample, shape, texts } from "./kit.tsx";

quiet();

/** Работа с поиском и кнопкой шапки; два раздела группы «Флот». */
let added = 0;
function parts(): AppPart[] {
  const work: AppModule = {
    screens: {
      work: {
        nav: "Работа",
        find: (q) => ["refactor@win", "api@wsl"].filter((c) => c.includes(q)).map((c) => ({ label: c, hint: "сессия", dot: "busy", screen: "work", params: { callsign: c } })),
        view: ({ params: p }) => `работа ${p.callsign ?? "все"}`,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => (added++, undefined) } }),
      },
    },
  };
  const fleet: AppModule = {
    screens: {
      machines: { nav: "Машины", group: "Флот", view: () => "машины" },
      access: { nav: "Аккаунты", group: "Флот", view: () => "аккаунты" },
    },
  };
  return [
    { manifest: man("w", { work: 1 }), module: () => work },
    { manifest: man("f", { machines: 1, access: 1 }), module: () => fleet },
  ];
}
const sections = (wide: boolean, options: Partial<StartOptions> = {}, list = parts()) => stand(list, { wide, options: { sections: ["work", "machines", "access"], ...options } });

/** Модуль: раздел a с меткой и шапкой, экран b, разделы группы; полоса top — отдельным модулем. */
const pair = () => {
  const m = mod(
    {
      marks: { cnt: () => 2, zero: () => 0 },
      screens: {
        a: { nav: "А", mark: "cnt", label: "А", view: () => <i data-s="a" />, head: () => ({ title: "Т", sub: "под", dot: "busy", action: { label: "Новая", text: "+", run() {} } }) },
        b: { label: "Б", view: () => <i data-s="b" /> },
        g1: { nav: "Г1", group: "Г", mark: "zero", view: () => <i data-s="g1" /> },
        g2: { nav: "Г2", group: "Г", view: () => <i data-s="g2" /> },
      },
    },
    { g1: 1, g2: 1, cnt: 1, zero: 1 },
  );
  return { parts: [m.part, bar()], box: m.box };
};
const bar = (nav?: string): AppPart => ({ manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: () => ({ screens: { bar: { place: "top", nav, view: () => <i data-bar>полоса</i> } } }) });

describe("разделы", () => {
  it("5170 · широкий вид: раздел и группа «Флот» с подписью; подпунктов под разделом нет, кнопки шапки нет", async () => {
    const t = await sections(true);
    expect(texts(".sb-navcol .sb-nv")).toEqual(["Работа", "Машины", "Аккаунты"]);
    expect(texts(".sb-navcol .sb-grp")).toEqual(["Флот"]);
    // машин и имени устройства в колонке больше нет
    expect(t.$(".sb-nm, .sb-me, .sb-ncap")).toBeNull();
    expect(t.$("[data-find], [data-new]")).toBeNull();
    await t.click(t.$$(".sb-navcol .sb-nv")[1]);
    expect(location.hash).toBe("#machines");
    expect(t.$('.sb-navcol .sb-nv[aria-current="page"]')!.textContent).toBe("Машины");
  });

  it("5135 · порядок разделов — у оболочки: sections первыми, остальные — следом по списку модулей; домашний — первый", async () => {
    // источник: дизайн «Открытый флот»: «beside и порядок разделов — у оболочки; разделы, которых в ней нет, встают следом»
    const one = (n: string): AppPart => ({ manifest: man(n, { [n]: 1 }), module: () => ({ screens: { [n]: { nav: n, label: n, view: () => n } } }) });
    const t = await stand(["a", "b", "c", "d"].map(one), { wide: true, options: { sections: ["c", "a"] } });
    expect(t.$$(".sb-navcol .sb-nv").map((b) => b.dataset.screen)).toEqual(["c", "a", "b", "d"]);
    expect(t.$('.sb-navcol button[aria-current="page"]')!.getAttribute("data-screen")).toBe("c");
  });

  it("5172 · узкий вид: вкладки внизу — разделы без группы и одна вкладка группы; открыт раздел группы — его соседи лентой над экраном", async () => {
    const t = await sections(false);
    expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
    expect(t.$(".sb-navrow")!.hidden).toBe(true);
    await t.click(t.$('.sb-tabs [data-group="Флот"]'));
    expect(location.hash).toBe("#machines");
    expect(texts(".sb-navrow .sb-nv")).toEqual(["Машины", "Аккаунты"]);
    expect(t.$('.sb-tabs [data-group="Флот"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("5175 · narrowGroup: в широком виде раздел отдельно, в узком — в группе («Инциденты» во «Флоте» телефона)", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): телефон — Вам, Работа, Флот (аккаунты, машины, инциденты, настройки)
    const list = (): AppPart[] => [...parts(), { manifest: man("i", { incidents: 1 }), module: () => ({ screens: { incidents: { nav: "Инциденты", narrowGroup: "Флот", view: () => "инциденты" } } }) }];
    const order = { sections: ["work", "incidents", "machines", "access"] };
    await sections(true, order, list());
    expect(texts(".sb-navcol .sb-nv:not(.sub)")).toEqual(["Работа", "Инциденты", "Машины", "Аккаунты"]);
    const t = await sections(false, order, list());
    expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
    await t.go("#incidents");
    expect(texts(".sb-navrow .sb-nv")).toEqual(["Инциденты", "Машины", "Аккаунты"]);
  });

  it("вкладки: один раздел — их нет; метка группы — точка, если есть новое; открытая группа нажатием не перескакивает; точка раздела на ленте", async () => {
    const one = await stand([mod().part]);
    expect(one.$(".sb-tabs")!.hidden).toBe(true);
    const f: AppPart = {
      manifest: man("f", { x: 1, y: 1, z: 1, cnt: 1, cn2: 1 }),
      module: () => ({
        screens: { x: { nav: "Икс", group: "Г", mark: "cnt", view: () => "икс" }, y: { nav: "Игрек", group: "Г", mark: "cn2", view: () => "игрек" }, z: { nav: "Зет", view: () => "зет" } },
        marks: { cnt: () => 2, cn2: () => 3 },
      }),
    };
    const t = await stand([f]);
    expect(texts('.sb-tabs [data-group="Г"] .sb-badge.dot')).toEqual([""]);
    await t.click(t.$('.sb-tabs [data-screen="z"]'));
    await t.click(t.$('.sb-tabs [data-group="Г"]'));
    expect(location.hash).toBe("#x");
    expect(texts(".sb-navrow .sb-badge.dot")).toEqual(["", ""]);
    await t.click(t.$('.sb-navrow [data-screen="y"]'));
    expect(location.hash).toBe("#y");
    await t.click(t.$('.sb-tabs [data-group="Г"]'));
    expect(location.hash).toBe("#y");
    expect(t.$('.sb-navrow [aria-current="page"]')!.textContent).toBe("Игрек");
  });

  it("4013 · 4014 · следующий roster — точка раздела в колонке; владелец метки выключен — точки нет, раздел и roster работают", async () => {
    const relay = new FakeRelay(oneMachine());
    const s = sample([], {
      frames: {
        question: () => {
          throw new Error("boom");
        },
      },
    });
    const t = await stand([s.part], { relay, wide: true });
    const nav = () => t.$('.sb-navcol button[data-screen="list"] .sb-badge.dot') !== null;
    expect(nav()).toBe(true);
    const r = oneMachine();
    r.sessions = [...r.sessions, { callsign: "x@laptop", state: "waiting" }, { callsign: "y@laptop", state: "waiting" }];
    relay.setRoster(r);
    await flush();
    expect(nav()).toBe(true);
    relay.push({ type: "question", from: "site@laptop" });
    await flush();
    expect(t.run.failed.sample).toContain("boom");
    relay.setRoster(homeRoster());
    await flush();
    expect(nav()).toBe(false);
  });

  it("5174 · beside списком: карточка открыта от «Вам» — слева «Вам», от «Работы» — «Работа»; поиск ведёт и на экран из uses", async () => {
    const lists: AppModule = {
      screens: {
        inbox: { nav: "Вам", find: () => [{ label: "site@laptop", screen: "card", params: { callsign: "site@laptop" } }], view: () => "вам" },
        board: { nav: "Работа", view: () => "работа" },
      },
    };
    const card: AppModule = { screens: { card: { view: ({ params: p }) => `карточка ${p.callsign}` } } };
    const t = await stand(
      [
        { manifest: man("l", { inbox: 1, board: 1 }, { "card@c": 1 }), module: () => lists },
        { manifest: man("c", { card: 1 }), module: () => card },
      ],
      { wide: true, options: { beside: { card: ["board", "inbox"] } } },
    );
    await t.go("#inbox");
    await t.go("#card?callsign=site%40laptop");
    expect(t.$(".sb-master")!.getAttribute("data-screen")).toBe("inbox");
    await t.go("#board");
    await t.go("#card?callsign=site%40laptop");
    expect(t.$(".sb-master")!.getAttribute("data-screen")).toBe("board");
    ctrlK();
    await flush();
    expect(texts(".sb-palit .l")).toContain("site@laptop");
  });

  it("открытый раздел виден в прокрутке", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    await stand([mod().part], { wide: true });
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});

describe("шапка и колонка", () => {
  it("5173 · узкий вид: в шапке раздела — поиск и кнопка раздела; поиск открывает тот же Ctrl K; кнопка зовёт действие раздела", async () => {
    added = 0;
    const t = await sections(false);
    await t.click(t.$("[data-find]"));
    expect(t.$(".sb-palw")!.hidden).toBe(false);
    t.$(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    t.$("[data-new]")!.click();
    expect(added).toBe(1);
  });

  it("шапка раздела: логотип, «на связи»; экран не раздел: «назад» ведёт обратно, своей пилюли нет", async () => {
    const m = mod();
    const t = await stand([m.part]);
    expect(t.$(".sb-logo")!.textContent).toBe("S");
    expect(t.$(".sb-back")).toBeNull();
    expect(t.$(".sb-bt b")!.textContent).toBe("А");
    expect(t.$(".sb-pill")!.textContent).toBe("на связи");
    m.box.app.open("b");
    await flush();
    expect(t.$(".sb-pill")).toBeNull();
    expect(t.$(".sb-bt b")!.textContent).toBe("Б");
    await t.click(t.$(".sb-back"));
    await flush();
    expect(t.$('[data-s="a"]')).not.toBeNull();
  });

  it("шапка экрана: заголовок моноширинным, подпись, лампа, своя пилюля и тон; без связи — пилюля ядра", async () => {
    const relay = new FakeRelay(oneMachine());
    const m = mod({ screens: { a: { nav: "А", view: () => null, head: () => ({ title: "site@laptop", mono: true, sub: "работает", dot: "busy", pill: { text: "ждёт", tone: "wait" } }) } } });
    const t = await stand([m.part], { relay, pauseMs: 60_000 });
    expect(t.$(".sb-bt b.m")!.textContent).toBe("site@laptop");
    expect(t.$(".sb-bt span")!.textContent).toBe("работает");
    expect(t.$(".sb-bar .sb-dot.busy")).not.toBeNull();
    expect(t.$(".sb-pill.wait")!.textContent).toBe("ждёт");
    relay.drop();
    await flush();
    expect(t.$(".sb-pill.bad")!.textContent).toBe("нет связи");
    expect(t.$(".sb-pill")!.classList.contains("conn")).toBe(true);
  });

  it("полоса: буква приложения из опций, имя в подсказке; лампа с подписью; поиск значком, «Перейти · Ctrl K» подсказкой", async () => {
    const a = await stand([mod().part], { wide: true });
    expect(a.$(".sb-brand .sb-logo")!.textContent).toBe("S");
    expect(a.$(".sb-brand")!.getAttribute("title")).toBe("Switchboard");
    expect(a.$(".sb-brand .sb-pill")!.getAttribute("title")).toBe("на связи");
    expect(a.$(".sb-brand .sb-pill")!.getAttribute("aria-label")).toBe("на связи");
    expect(a.$(".sb-goto")!.textContent).toBe("Перейти…");
    expect(a.$(".sb-goto")!.getAttribute("title")).toBe("Перейти · Ctrl K");
    const b = await stand([mod().part], { wide: true, options: { brand: "Пульт" } });
    expect(b.$(".sb-brand .sb-logo")!.textContent).toBe("П");
  });

  it("полоса top: над разделом и над списком рядом; над экраном не раздела скрыта", async () => {
    const m = mod();
    const t = await stand([m.part, bar()]);
    expect(t.$(".sb-top")!.hidden).toBe(false);
    expect(t.$(".sb-top [data-bar]")).not.toBeNull();
    m.box.app.open("b");
    await flush();
    expect(t.$(".sb-top")!.hidden).toBe(true);
    const w = mod();
    const u = await stand([w.part, bar()], { wide: true, options: { beside: { b: "a" } } });
    w.box.app.open("b");
    await flush();
    expect(u.$(".sb-top")!.hidden).toBe(false);
    expect(w.box.app.current()).toEqual({ screen: "b", params: {}, master: "a" });
  });
});

describe("тост", () => {
  it("своя строка и тон; по умолчанию bad; новая сменяет прежнюю; через 6 с скрыт, текст и тон остаются в разметке", async () => {
    const m = mod();
    const t = await stand([m.part]);
    m.box.app.toast("упало");
    await flush();
    expect(t.$(".sb-toast.bad")!.textContent).toBe("упало");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5_000);
    m.box.app.toast("ладно", "ok");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.$(".sb-toast.ok")!.hidden).toBe(false);
    expect(t.$(".sb-toast")!.textContent).toBe("ладно");
    await vi.advanceTimersByTimeAsync(4_500);
    expect(t.$(".sb-toast")!.hidden).toBe(true);
    expect(t.$(".sb-toast")!.textContent).toBe("ладно");
    expect(t.$(".sb-toast")!.classList.contains("ok")).toBe(true);
  });
});

describe("поиск", () => {
  const found = (): AppPart[] => [
    {
      manifest: man("w", { work: 1, fine: 1 }, { "card@c": 1 }),
      module: () => ({
        screens: {
          work: {
            nav: "Работа",
            find: (q) => [
              { label: "своя", hint: "сессия", dot: "busy", screen: "work", params: { q } },
              { label: "из uses", screen: "card" },
              { label: "чужая", screen: "secret" },
            ],
            view: () => "работа",
          },
          fine: { nav: "Машины", group: "Флот", view: () => "машины" },
        },
      }),
    },
    { manifest: man("c", { card: 1, secret: 1 }), module: () => ({ screens: { card: { view: () => "карточка" }, secret: { view: () => "секрет" } } }) },
  ];

  it("5171 · Ctrl K: разделы и строки find экранов; ввод сразу в поле; Enter открывает первую; Esc закрывает", async () => {
    const t = await sections(true);
    ctrlK();
    await flush();
    const input = t.$<HTMLInputElement>(".sb-palin")!;
    expect(document.activeElement).toBe(input);
    expect(texts(".sb-palit .l")).toEqual(["Работа", "refactor@win", "api@wsl", "Машины", "Аккаунты"]);
    input.value = "api";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(texts(".sb-palit .l")).toEqual(["api@wsl"]);
    t.$(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(location.hash).toBe("#work?callsign=api%40wsl");
    expect(t.$(".sb-palw")!.hidden).toBe(true);
    await t.click(t.$(".sb-goto"));
    t.$(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(t.$(".sb-palw")!.hidden).toBe(true);
  });

  it("порядок поиска — порядок разделов оболочки, а не список модулей сборки", async () => {
    // источник: находка снимков 5 нояб. — на настоящей сборке первая строка пульта была «Журнал», телефона — «Настройки»
    const t = await sections(true, { sections: ["access", "work", "machines"] });
    ctrlK();
    await flush();
    expect(t.$(".sb-palit.first .l")!.textContent).toBe("Аккаунты");
    expect(texts(".sb-palit .l")).toEqual(["Аккаунты", "Работа", "refactor@win", "api@wsl", "Машины"]);
  });

  it("строка ведёт на свой экран или экран из uses; подпись раздела — группа или «раздел»; первый отмечен", async () => {
    const t = await stand(found(), { wide: true });
    ctrlK();
    await flush();
    expect(t.$<HTMLInputElement>(".sb-palin")!.placeholder).toBe("");
    expect(texts(".sb-palit .l")).toEqual(["Работа", "своя", "из uses", "Машины"]);
    expect(texts(".sb-palit .k")).toEqual(["раздел", "сессия", "Флот"]);
    expect(t.$(".sb-palit.first .l")!.textContent).toBe("Работа");
    expect(t.$$(".sb-palit")[1].querySelector(".sb-dot.busy")).not.toBeNull();
    await t.click(t.$$(".sb-palit")[2]);
    expect(location.hash).toBe("#card");
    expect(t.$(".sb-palw")!.hidden).toBe(true);
  });

  it("«Ничего не нашлось»; Ctrl K закрывает открытый, ⌘K и русская раскладка, Ctrl без code; покрывало закрывает; не больше 40 строк", async () => {
    const m: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", find: (q) => (q === "нет" ? [] : Array.from({ length: 50 }, (_, i) => ({ label: `s${i}`, screen: "a" }))), view: () => "а" } } }) };
    const t = await stand([m], { wide: true });
    ctrlK();
    await flush();
    expect(t.$$(".sb-palit")).toHaveLength(40);
    const input = t.$<HTMLInputElement>(".sb-palin")!;
    input.value = "нет";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(t.$(".sb-pal .sb-palres .sb-note")!.textContent).toBe("Ничего не нашлось");
    expect(t.$(".sb-pal .sb-palres .sb-note")!.getAttribute("style")).toBe("padding: 10px 12px;");
    ctrlK();
    await flush();
    expect(t.$(".sb-palw")!.hidden).toBe(true);
    key({ key: "л", code: "KeyK", metaKey: true });
    await flush();
    expect(t.$(".sb-palw")!.hidden).toBe(false);
    await t.click(t.$(".sb-palveil"));
    expect(t.$(".sb-palw")!.hidden).toBe(true);
    key({ key: "k", ctrlKey: true });
    await flush();
    expect(t.$(".sb-palw")!.hidden).toBe(false);
    key({ key: "л", ctrlKey: true });
    await flush();
    expect(t.$(".sb-palw")!.hidden).toBe(true);
  });

  it("узкий вид и остановленное приложение: Ctrl K ничего не открывает; упавший модуль и полоса top в поиск не идут", async () => {
    const narrow = await stand(found());
    ctrlK();
    await flush();
    expect(narrow.$(".sb-palw")!.hidden).toBe(true);
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["revoked"];
    const off = await stand(found(), { relay, wide: true });
    await flush(20);
    ctrlK();
    await flush();
    expect(off.$(".sb-palw")!.hidden).toBe(true);
    const bad = mod(
      {
        screens: { a: { nav: "Плохой", find: () => [{ label: "ни за что", screen: "a" }], view: () => null } },
        frames: {
          boom: () => {
            throw new Error("boom");
          },
        },
      },
      {},
      { "boom@x": 1 },
    );
    await stand([bar("Полоса"), bad.part], { wide: true });
    bad.box.app.deliver({ type: "boom" });
    ctrlK();
    await flush();
    expect(texts(".sb-palit .l")).toEqual([]);
  });

  it("окно и подписи для чтения с экрана; строка — лампа, подпись, вид", async () => {
    const m: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", find: () => [{ label: "л", hint: "х", dot: "busy", screen: "a" }], view: () => null } } }) };
    const t = await stand([m], { wide: true });
    ctrlK();
    await flush();
    expect(shape(t.$(".sb-palw")!)).toEqual(["div.sb-palveil", "div.sb-pal"]);
    expect(attrs(t.$(".sb-pal")!)).toMatchObject({ role: "dialog", "aria-label": "Перейти" });
    expect(t.$(".sb-palin")!.className).toBe("sb-in sb-palin");
    expect(t.$(".sb-palin")!.getAttribute("aria-label")).toBe("Перейти");
    expect(t.$(".sb-palres")!.getAttribute("role")).toBe("listbox");
    const [section, row] = t.$$(".sb-palit");
    expect(section.className).toBe("sb-rw sb-palit first");
    expect(attrs(row)).toMatchObject({ type: "button", role: "option", class: "sb-rw sb-palit" });
    expect(shape(row)).toEqual(["span.sb-dot.busy", "span.l", "span.k"]);
    expect(shape(section)).toEqual(["span.l", "span.k"]);
  });
});

describe("остов разметки: на нём стоят стили и снимки", () => {
  it("остов страницы: стиль модулей первым, колонка, главная часть по порядку, поиск; область экрана", async () => {
    const t = await stand(pair().parts);
    expect(t.root.firstElementChild!.tagName).toBe("STYLE");
    expect(shape(t.$(".sb-app")!)).toEqual(["nav.sb-navcol", "main.sb-main", "div.sb-palw"]);
    expect(shape(t.$(".sb-main")!)).toEqual(["header.sb-bar", "nav.sb-navrow", "div.sb-off", "div.sb-top", "div.sb-view", "div.sb-toast", "nav.sb-tabs"]);
    expect(t.$(".sb-off")!.getAttribute("role")).toBe("status");
    expect(t.$(".sb-toast")!.getAttribute("role")).toBe("alert");
    expect(t.$(".sb-tabs")!.getAttribute("aria-label")).toBe("Разделы");
    expect(t.$(".sb-top > div > [data-module=bar] > [data-bar]")).not.toBeNull();
    const screen = t.$(".sb-view > .sb-screen")!;
    expect(attrs(screen)["data-screen"]).toBe("a");
    expect(screen.getAttribute("style")).toMatch(/^display: flex; flex-direction: column; min-height: 0; flex(: 1|-grow: 1; flex-shrink: 1; flex-basis: 0%);$/);
    const place = t.$('.sb-screen > [data-module="m"]')!;
    expect(place.getAttribute("style")).toBe("display: contents;");
    expect(place.firstElementChild!.getAttribute("data-s")).toBe("a");
  });

  it("широкий вид: класс wide; экран рядом со списком — split, слева master с именем экрана, справа detail; колонка по порядку", async () => {
    const { parts: list, box } = pair();
    const t = await stand(list, { wide: true, options: { beside: { b: "a" }, brand: "Пульт" } });
    box.app.open("b");
    await flush();
    expect(t.$(".sb-app")!.className).toBe("sb-app wide");
    expect(shape(t.$(".sb-view")!)).toEqual(["div.sb-split"]);
    expect(shape(t.$(".sb-split")!)).toEqual(["div.sb-master", "div.sb-detail"]);
    expect(t.$(".sb-master")!.getAttribute("style")).toBeNull();
    expect(t.$('.sb-master[data-screen="a"] > [data-module="m"] > [data-s="a"]')).not.toBeNull();
    expect(t.$('.sb-detail > .sb-screen[data-screen="b"] > [data-module="m"] > [data-s="b"]')).not.toBeNull();
    expect(shape(t.$(".sb-navcol")!)).toEqual(["div.sb-brand", "button.sb-tx.sb-goto", "button.sb-rw.sb-nv", "div.sb-grp", "button.sb-rw.sb-nv", "button.sb-rw.sb-nv"]);
    expect(shape(t.$(".sb-brand")!)).toEqual(["span.sb-logo", "span.sb-pill.ok.conn"]);
    expect(t.$(".sb-goto kbd")).toBeNull();
  });

  it("шапка раздела: логотип, лампа, заголовок, поиск, действие, пилюля; шапка экрана: назад и заголовок", async () => {
    const { parts: list, box } = pair();
    const t = await stand(list);
    expect(shape(t.$(".sb-bar")!)).toEqual(["div.sb-logo", "span.sb-dot.busy", "div.sb-bt", "button.sb-ic.sb-find", "button.sb-ic.sb-find.pri", "span.sb-pill.ok.conn"]);
    expect(t.$(".sb-logo")!.getAttribute("aria-hidden")).toBe("true");
    expect(attrs(t.$("[data-find]")!)).toMatchObject({ type: "button", "aria-label": "Найти", "data-find": "1" });
    expect(t.$("[data-find] svg")!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(attrs(t.$("[data-new]")!)).toMatchObject({ type: "button", "aria-label": "Новая", "data-new": "1" });
    expect(t.$("[data-new]")!.textContent).toBe("+");
    box.app.open("b");
    await flush();
    expect(shape(t.$(".sb-bar")!)).toEqual(["button.sb-ic.sb-back", "div.sb-bt"]);
    expect(attrs(t.$(".sb-back")!)).toMatchObject({ type: "button", "aria-label": "Назад" });
    expect(t.$(".sb-back")!.textContent).toBe("‹");
  });

  it("пункт раздела: подпись и точка ждущего цвета; метка 0 — точки нет; лента и вкладки одной формы", async () => {
    const { parts: list, box } = pair();
    const t = await stand(list);
    const tab = t.$('.sb-tabs [data-screen="a"]')!;
    expect(tab.className).toBe("sb-rw sb-nv");
    expect(tab.getAttribute("type")).toBe("button");
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(shape(tab)).toEqual(["span.", "span.sb-badge.wait.dot"]);
    expect(tab.querySelector(".sb-badge")!.textContent).toBe("");
    expect(tab.querySelector(".sb-badge")!.getAttribute("aria-label")).toBe("есть новое");
    box.app.open("g1");
    await flush();
    expect(shape(t.$('.sb-navrow [data-screen="g1"]')!)).toEqual(["span."]);
    expect(t.$('.sb-tabs [data-group="Г"]')!.className).toBe("sb-rw sb-nv");
    expect(t.$(".sb-navrow")!.hasAttribute("hidden")).toBe(false);
  });
});
