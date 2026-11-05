// Леса ядра страницы, экраны: адрес и on.current, место экрана и Slot, вставки, команды, метки, выборка, что ядро даёт модулю.
// Вход — контракт web-core и стенд, исход — адрес, разметка и вызовы модулей. Номер — эталон-источник; без номера — чьё: код.
import { createElement, memo, useEffect, useState } from "react";
import { renderToString } from "react-dom/server";
import { useApp } from "@switchboard/web-ui";
import { describe, expect, it, vi } from "vitest";
import { memoryStore, type App, type AppModule, type AppPart, type Params, type Roster, type SlotProps } from "../contract.ts";
import { stand } from "../stand/app.ts";
import { FakeRelay, flush, homeRoster, KEY, oneMachine } from "../stand/relay.ts";
import { begin, hash, man, mod, other, quiet, sample, shape } from "./kit.tsx";

quiet();

type Seen = { screen: string; params: Params };

/** Модуль с экранами a (раздел), b, c, командой cmd; записывает on.current. */
function part(over: { current?(c: Seen): void; roster?(): void; run?(p: Params): void } = {}) {
  const seen: Seen[] = [];
  const box: { app: App } = { app: null as never };
  const p: AppPart = {
    manifest: man("m", { a: 1, b: 1, c: 1, cmd: 1 }, { "roster@relay": 1 }),
    module: (a) => ({
      on: {
        current(c) {
          seen.push(c);
          over.current?.(c);
        },
        roster: () => over.roster?.(),
      },
      screens: {
        a: { nav: "А", label: "А", view: () => <div data-s="a">а</div> },
        b: { path: "b", label: "Б", view: ({ params }) => <div data-s="b">{`б ${params.x ?? ""}`}</div> },
        c: { path: "c", label: "В", view: () => <div data-s="c">в</div> },
      },
      commands: { cmd: { run: (x) => over.run?.(x) } },
      start: () => void (box.app = a),
    }),
  };
  return { p, seen, box };
}

describe("адрес и on.current", () => {
  it("6840 · 6804 · адрес сменили снаружи: один раз, экран и параметры из адреса; экран в снимке уже новый", async () => {
    // факт: types.ts «открыт экран: человек перешёл, новый адрес или команда app.open»
    const shown: Array<string | undefined> = [];
    const m = part({ current: () => shown.push(m.box.app.current()?.screen) });
    const t = await stand([m.p]);
    expect(m.seen).toEqual([{ screen: "a", params: {} }]);
    m.seen.length = 0;
    await t.go("#b?x=1");
    expect(m.seen).toEqual([{ screen: "b", params: { x: "1" } }]);
    expect(shown).toEqual(["a", "b"]);
    expect(t.$('[data-s="b"]')!.textContent).toBe("б 1");
  });

  it("6841 · назад браузером: прежний экран; второе событие того же адреса экран не строит", async () => {
    const m = part();
    const t = await stand([m.p]);
    m.box.app.open("b", { x: "1" });
    m.box.app.open("c");
    await flush();
    m.seen.length = 0;
    history.replaceState({ depth: 1 }, "", "#b?x=1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(m.seen).toEqual([{ screen: "b", params: { x: "1" } }]);
    expect(t.$('[data-s="b"]')).not.toBeNull();
  });

  it("open — экран на весь экран с параметрами в адресе; назад — на раздел", async () => {
    const log: string[] = [];
    const s = sample(log);
    const t = await stand([s.part], { roster: oneMachine() });
    s.box.app.open("item", { callsign: "site@laptop" });
    await flush();
    expect(location.hash).toBe("#item?callsign=site%40laptop");
    expect(t.root.textContent).toContain("item site@laptop");
    expect(log).toContain("list closed");
    expect(t.$(".sb-back")).not.toBeNull();
    s.box.app.back();
    await flush();
    expect(t.root.textContent).toContain("список");
  });

  it("6842 · назад без истории: домашний раздел, запись истории не добавлена", async () => {
    const m = part();
    await stand([m.p], { url: "/#b?x=1" });
    m.seen.length = 0;
    const len = history.length;
    m.box.app.back();
    await flush();
    expect(location.hash).toBe("#a");
    expect(history.length).toBe(len);
    expect(m.seen).toEqual([{ screen: "a", params: {} }]);
  });

  it("4011 · 6843 · до первого roster — «подключаюсь»; первый roster открывает экран адреса после on.roster; следующий on.current не зовёт", async () => {
    // факт: core/contract.ts «start() модулей → link к relay → экран из адреса»; порядок — чьё: код
    const log: string[] = [];
    const m = part({ roster: () => log.push("roster"), current: () => log.push("current") });
    const relay = new FakeRelay(homeRoster());
    const { run, root } = begin([m.p], { relay, url: "/#b?x=2" });
    await run.ready;
    expect(root.textContent).toContain("подключаюсь · hello");
    await flush();
    expect(m.seen).toEqual([{ screen: "b", params: { x: "2" } }]);
    expect(root.querySelector('[data-screen="b"]')!.textContent).toBe("б 2");
    expect(log.indexOf("roster")).toBeLessThan(log.indexOf("current"));
    relay.setRoster(homeRoster());
    await flush();
    expect(m.seen).toHaveLength(1);
    run.unmount();
  });

  it("6844 · 7282 · app.open: экран — адрес и on.current; run команды — адрес и экран прежние; адрес команды — домашний экран, команда не выполнена", async () => {
    // источник: отчёт архитектора, ошибка 7 — #pin?callsign=… вёл на команду, пустой экран
    const run = vi.fn();
    const m = part({ run });
    const t = await stand([m.p], { url: "/#cmd?x=1" });
    expect(t.$('[data-s="a"]')).not.toBeNull();
    expect(m.box.app.current()!.screen).toBe("a");
    expect(run).not.toHaveBeenCalled();
    m.seen.length = 0;
    m.box.app.open("b", { x: "1" });
    await flush();
    expect(location.hash).toBe("#b?x=1");
    expect(m.seen).toEqual([{ screen: "b", params: { x: "1" } }]);
    m.box.app.run("cmd", { x: "2" });
    await flush();
    expect(run).toHaveBeenCalledWith({ x: "2" });
    expect(location.hash).toBe("#b?x=1");
    expect(m.seen).toHaveLength(1);
    expect(m.box.app.current()?.screen).toBe("b");
  });

  it("6845 · широкий вид: список остаётся слева; экран без списка рядом — списка нет", async () => {
    // факт: core/contract.ts «экран открывается справа от списка, список остаётся слева»
    const m = part();
    const t = await stand([m.p], { wide: true, options: { beside: { b: "a" } } });
    m.seen.length = 0;
    m.box.app.open("b");
    await flush();
    expect(t.$('.sb-master [data-s="a"]')).not.toBeNull();
    expect(t.$('[data-s="b"]')).not.toBeNull();
    expect(m.seen).toEqual([{ screen: "b", params: {} }]);
    m.box.app.open("c");
    await flush();
    expect(t.$(".sb-master")).toBeNull();
  });

  it("6846 · тот же адрес: on.current нет, история не выросла", async () => {
    // источник: гейт архитектора — лишняя коммуникация; чьё: код
    const m = part();
    await stand([m.p]);
    m.box.app.open("b", { x: "1" });
    await flush();
    m.seen.length = 0;
    const len = history.length;
    m.box.app.open("b", { x: "1" });
    await flush();
    expect(m.seen).toEqual([]);
    expect(history.length).toBe(len);
  });

  it("6847 · незнакомый адрес, адрес полосы top и негодное экранирование: домашний раздел с пустыми параметрами", async () => {
    const m = part();
    m.p.manifest.provides.bar = 1;
    m.p.manifest.uses["top@web-core"] = 1;
    const base = m.p.module;
    m.p.module = (a) => {
      const d = base(a);
      d.screens!.bar = { place: "top", path: "bar", view: () => null };
      return d;
    };
    const t = await stand([m.p], { url: "/#b" });
    for (const bad of ["#nosuch?x=1", "#bar", "#%"]) {
      hash("#b");
      await flush();
      m.seen.length = 0;
      hash(bad);
      await flush();
      expect(m.seen, bad).toEqual([{ screen: "a", params: {} }]);
    }
    expect(t.relay.hellos.length).toBeGreaterThan(0);
  });

  it("6848 · до первого roster on.current нет; после отказа revoked — экран причины, on.current нет", async () => {
    // источник: устав — система ловит: останавливает и не пускает дальше
    const m = part();
    const { run } = begin([m.p], { relay: new FakeRelay(homeRoster()) });
    await run.ready;
    hash("#b");
    expect(m.seen).toEqual([]);
    run.unmount();

    const n = part();
    const refused = new FakeRelay(homeRoster());
    refused.refuse = ["revoked", "revoked"];
    const t = await stand([n.p], { relay: refused });
    await flush(20);
    expect(t.run.stopped).toBe("revoked");
    n.seen.length = 0;
    hash("#c");
    await flush();
    expect(n.seen).toEqual([]);
    expect(t.root.textContent).toContain("Пропуск отозван");
  });

  it("6849 · бросил в on.current: модуль выключен, остальные работают; следующий переход его не зовёт, соседа зовёт", async () => {
    // источник: устав — ошибка модуля: модуль выключен; registry.ts «выключен до перезапуска приложения»
    const bad = vi.fn((c: Seen) => {
      if (c.screen === "b") throw new Error("сломан переход");
    });
    const m = part({ current: bad });
    const seen: Seen[] = [];
    const neighbour: AppPart = { manifest: man("n", { n: 1 }), module: () => ({ on: { current: (c) => void seen.push(c) }, screens: { n: { label: "Н", view: () => "н" } } }) };
    const t = await stand([m.p, neighbour]);
    seen.length = 0;
    m.box.app.open("b");
    await flush();
    expect(t.run.failed.m).toContain("сломан переход");
    expect(seen).toEqual([{ screen: "b", params: {} }]);
    bad.mockClear();
    hash("#n");
    await flush();
    expect(bad).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ screen: "n", params: {} });
  });

  it("6850 · app.open мимо uses: выключен вызывающий; адрес и экран прежние, on.current нет", async () => {
    // источник: устав — части пользуются друг другом только через контракт
    const m = part();
    const side: AppPart = { manifest: man("s", { side: 1 }), module: () => ({ screens: { side: { path: "side", view: () => "бок" } } }) };
    const t = await stand([m.p, side]);
    m.seen.length = 0;
    const before = location.hash;
    m.box.app.open("side");
    await flush();
    expect(t.run.failed.m).toContain("экрана side нет в uses");
    expect(location.hash).toBe(before);
    expect(t.$('[data-s="side"]')).toBeNull();
    expect(m.seen).toEqual([]);
  });

  it("open до первого roster: адрес записан, первый roster открывает этот экран; имя из uses без владельца в сборке — адрес меняется, экран домашний", async () => {
    const early = mod({ start: () => early.box.app.open("b") });
    const t = await stand([early.part]);
    expect(location.hash).toBe("#b");
    expect(t.$('[data-s="b"]')).not.toBeNull();
    const m = mod({}, {}, { "absent@nobody": 1 });
    const u = await stand([m.part]);
    m.box.app.open("absent", { x: "1" });
    await flush();
    expect(location.hash).toBe("#absent?x=1");
    expect(u.run.failed).toEqual({});
    expect(u.$('[data-s="a"]')).not.toBeNull();
  });
});

describe("место экрана", () => {
  it("4020 · экран в месте другого модуля — адрес не меняется, убран из разметки — закрыт", async () => {
    const log: string[] = [];
    const s = sample(log);
    let shown: (v: boolean) => void = () => {};
    const o = other(log);
    const base = o.part.module;
    o.part.module = (a) => {
      const d = base(a);
      d.screens!.side.view = function Side() {
        const [on, set] = useState(true);
        shown = set;
        return on ? createElement(o.box.app.Slot, { screen: "item", params: { callsign: "a@pc" } }) : null;
      };
      return d;
    };
    const t = await stand([s.part, o.part], { url: "/#side" });
    expect(t.$('[data-screen="side"]')!.textContent).toBe("item a@pc");
    expect(location.hash).toBe("#side");
    shown(false);
    await flush();
    expect(log).toContain("item closed a@pc");
  });

  it("4024 · экран выключенного модуля — причина вместо экрана, компонент не зовётся", async () => {
    const view = vi.fn(() => null);
    const s = sample([], {
      frames: {
        question: () => {
          throw new Error("boom");
        },
      },
    });
    s.mod.screens!.item.view = view;
    const t = await stand([s.part], { roster: oneMachine() });
    t.relay.push({ type: "question", from: "a@pc" });
    await flush();
    hash("#item?callsign=a%40pc");
    await flush();
    expect(view).not.toHaveBeenCalled();
    expect(t.root.textContent).toContain("Карточка выключен");
    expect(t.root.textContent).toContain("Перезапустить приложение");
  });

  it("6860 · useApp: в экране и в чужом месте — app своего модуля; вне экрана — исключение словами", async () => {
    // источник: устав — части пользуются друг другом только через контракт; uses проверяются по app модуля
    const got: Record<string, App> = {};
    const starts: Record<string, App> = {};
    function Side() {
      got.side = useApp();
      return <span data-side>бок</span>;
    }
    function Main() {
      const app = useApp();
      got.main = app;
      return <app.Slot screen="side" />;
    }
    const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: (a) => ({ screens: { main: { nav: "Г", view: Main } }, start: () => void (starts.main = a) }) };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: (a) => ({ screens: { side: { view: Side } }, start: () => void (starts.side = a) }) };
    const t = await stand([side, main]);
    expect(t.$("[data-side]")).not.toBeNull();
    expect(got.main).toBe(starts.main);
    expect(got.side).toBe(starts.side);
    expect(got.main).not.toBe(got.side);
    const Free = () => {
      useApp();
      return null;
    };
    expect(() => renderToString(<Free />)).toThrow("useApp вне экрана модуля");
  });

  it("6863 · Slot с равными параметрами в новом объекте: экран не перерисован, состояние цело", async () => {
    // факт: place.tsx «с теми же параметрами»; новые параметры — эталон 5715
    let renders = 0;
    let bump!: () => void;
    function Side() {
      const [v, set] = useState(0);
      renders++;
      return (
        <button data-side onClick={() => set(v + 1)}>
          {v}
        </button>
      );
    }
    function Main() {
      const app = useApp();
      const [, set] = useState(0);
      bump = () => set((n) => n + 1);
      return <app.Slot screen="side" params={{ x: "1" }} />;
    }
    const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: () => ({ screens: { main: { nav: "Г", view: Main } } }) };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: () => ({ screens: { side: { view: Side } } }) };
    const t = await stand([side, main]);
    await t.click(t.$("[data-side]"));
    expect(t.$("[data-side]")!.textContent).toBe("1");
    renders = 0;
    bump();
    await flush();
    expect(renders).toBe(0);
    expect(t.$("[data-side]")!.textContent).toBe("1");
  });

  it("6864 · чужой экран в Slot упал: выключен только он; экран вызывающего и его состояние целы; разметка места", async () => {
    // источник: устав — часть падает и перезапускается одна
    let boom = false;
    let box!: App;
    function Bad() {
      const app = useApp();
      if (app.use(() => boom)) throw new Error("сломан бок");
      return <span data-bad>бок</span>;
    }
    function Main() {
      const app = useApp();
      const [n, set] = useState(0);
      return (
        <div data-host>
          <button data-main onClick={() => set(n + 1)}>
            {n}
          </button>
          <app.Slot screen="bad" />
        </div>
      );
    }
    const main: AppPart = { manifest: man("main", { main: 1 }, { "bad@bad": 1 }), module: () => ({ screens: { main: { nav: "Г", view: Main } } }) };
    const bad: AppPart = { manifest: man("bad", { bad: 1 }), module: (a) => ({ screens: { bad: { label: "Бок", view: Bad } }, start: () => void (box = a) }) };
    const t = await stand([bad, main]);
    const place = t.$('[data-host] > [data-module="bad"]')!;
    expect(place.hasAttribute("data-screen")).toBe(false);
    expect(place.className).toBe("");
    expect(place.getAttribute("style")).toBe("display: contents;");
    await t.click(t.$("[data-main]"));
    boom = true;
    box.changed();
    await flush();
    expect(t.run.failed.bad).toContain("сломан бок");
    expect(t.run.failed.main).toBeUndefined();
    expect(t.$("[data-main]")!.textContent).toBe("1");
    expect(t.root.textContent).toContain("Бок выключен");
    expect(t.$("[data-host] > [data-module]")).toBeNull();
    expect(shape(t.$("[data-host] > .sb-pad")!)).toEqual(["div.sb-badc", "button.sb-cta"]);
    expect(shape(t.$(".sb-badc")!)).toEqual(["b.", "code.", "span."]);
  });

  it("6865 · «Перезапустить приложение» на экране упавшего модуля перезагружает страницу", async () => {
    // источник: устав — чистый перезапуск компонента или процесса
    const reload = vi.fn();
    const real = window.location;
    const Bad = () => {
      throw new Error("сломан экран");
    };
    const p: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", label: "А", view: Bad } } }) };
    const fake = new Proxy(real, { get: (o, k) => (k === "reload" ? reload : Reflect.get(o, k)) });
    const win = new Proxy(window, {
      get: (o, k) => {
        if (k === "location") return fake;
        const v = Reflect.get(o, k);
        return typeof v === "function" ? v.bind(o) : v;
      },
    });
    const t = await stand([p], { options: { window: win as Window } });
    expect(t.run.failed.m).toContain("сломан экран");
    await t.click(t.button("Перезапустить приложение"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("5704 · ошибка отрисовки: все места модуля показывают причину, сосед обновляется", async () => {
    // источник: устав — ошибка модуля: модуль выключен, остальные работают
    let app!: App;
    let bad = false;
    function Bad() {
      const v = app.use(() => bad);
      if (v) throw new Error("сломан рендер");
      return <div data-bad="1">жив</div>;
    }
    const broken: AppPart = { manifest: man("broken", { broken: 1 }), module: (a) => ({ screens: { broken: { nav: "Плохой", label: "Плохой", view: Bad } }, start: () => void (app = a) }) };
    const t = await stand([broken, rows({ rows: 0 })], { roster: many(3) });
    expect(t.$("[data-bad]")).not.toBeNull();
    bad = true;
    app.changed();
    await flush();
    expect(t.run.failed.broken).toContain("сломан рендер");
    expect(t.$("[data-bad]")).toBeNull();
    expect(t.root.textContent).toContain("Плохой выключен");
    location.hash = "#list";
    await flush();
    t.relay.setRoster(many(4));
    await flush();
    expect(t.$$(".row")).toHaveLength(4);
  });

  it("5709 · app.Slot с экраном вне uses — выключен вызывающий, причина словом", async () => {
    // чьё: код — правило «экран — свой, из uses или вставленный в своё место»
    let app!: App;
    const V = () => <app.Slot screen="side" />;
    const caller: AppPart = { manifest: man("caller", { caller: 1 }), module: (a) => ({ screens: { caller: { nav: "Вызов", label: "Вызов", view: V } }, start: () => void (app = a) }) };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: () => ({ screens: { side: { label: "Бок", view: () => "бок" } } }) };
    const t = await stand([caller, side]);
    expect(t.run.failed.caller).toContain("экрана side нет в uses");
    expect(t.root.textContent).not.toContain("бок");
  });

  it("5715 · тот же экран с другими параметрами или другой экран с тем же компонентом — начат заново", async () => {
    // чьё: код — прежний экран заново монтировался при смене параметров
    let app!: App;
    let mounts = 0;
    function Card({ params }: { params: Record<string, string> }) {
      const [draft, set] = useState("");
      useEffect(() => void mounts++, []);
      return (
        <button data-card={params.callsign} onClick={() => set("черновик")}>
          {`${params.callsign}:${draft}`}
        </button>
      );
    }
    const p: AppPart = { manifest: man("c", { card: 1, twin: 1 }), module: (a) => ({ screens: { card: { nav: "К", view: Card }, twin: { view: Card } }, start: () => void (app = a) }) };
    const t = await stand([p]);
    app.open("card", { callsign: "a@pc" });
    await flush();
    await t.click(t.$('[data-card="a@pc"]'));
    expect(t.$('[data-card="a@pc"]')!.textContent).toBe("a@pc:черновик");
    app.open("card", { callsign: "b@pc" });
    await flush();
    expect(t.$('[data-card="b@pc"]')!.textContent).toBe("b@pc:");
    mounts = 0;
    app.open("twin", { callsign: "b@pc" });
    await flush();
    expect(mounts).toBe(1);
  });

  it("5708 · стиль модуля заключён в область: до вложенного модуля, не дальше", async () => {
    // источник: опыт дизайна в Chrome, Firefox и WebKit; здесь — что ядро ставит область и место модуля
    let app!: App;
    const outer: AppPart = {
      manifest: man("outer", { outer: 1 }, { "inner@inner-m": 1 }),
      module: (a) => ({ screens: { outer: { nav: "Вне", view: () => <app.Slot screen="inner" /> } }, css: ".t{color:red}", start: () => void (app = a) }),
    };
    const inner: AppPart = { manifest: man("inner-m", { inner: 1 }), module: () => ({ screens: { inner: { view: () => <b className="t">внутри</b> } } }) };
    const t = await stand([outer, inner]);
    expect(t.root.querySelector("style")!.textContent).toContain('@scope ([data-module="outer"]) to ([data-module]) {\n.t{color:red}\n}');
    expect(t.$('[data-module="outer"] [data-module="inner-m"] .t')!.textContent).toBe("внутри");
  });

  it("Slot: close передан экрану", async () => {
    let closed = 0;
    function Dlg({ close }: { close?: () => void }) {
      return <button data-close onClick={close} />;
    }
    function Main() {
      const app = useApp();
      return <app.Slot screen="dlg" close={() => void closed++} />;
    }
    const t = await stand([
      { manifest: man("main", { main: 1 }, { "dlg@d": 1 }), module: () => ({ screens: { main: { nav: "Г", view: Main } } }) },
      { manifest: man("d", { dlg: 1 }), module: () => ({ screens: { dlg: { view: Dlg } } }) },
    ]);
    await t.click(t.$("[data-close]"));
    expect(closed).toBe(1);
  });
});

describe("вставки и команды", () => {
  // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): place у экрана, app.placed и show у владельца места
  const owner = (box: { app?: App }, slot?: SlotProps): AppPart => ({
    manifest: man("host-card", { card: 1, "card.tab": 1 }),
    module: (a) => ({ screens: { card: { view: () => (slot ? createElement(a.Slot, slot) : null) } }, start: () => void (box.app = a) }),
  });
  const tab = (name: string, show: (p: Record<string, string>) => boolean): AppPart => ({
    manifest: man(name, { [`${name}.tab`]: 1 }, { "card.tab@host-card": 1 }),
    module: () => ({ screens: { [`${name}.tab`]: { place: "card.tab", label: name, show, view: () => `вкладка ${name}` } } }),
  });

  it("5121 · владелец места видит вставки через app.placed; show решает видимость, только true; вставку рисует app.Slot", async () => {
    const box: { app?: App } = {};
    const t = await stand([owner(box, { screen: "hello.tab", params: { callsign: "site@laptop" } }), tab("hello", (p) => p.callsign === "site@laptop"), tab("bye", () => false), tab("one", (() => 1) as never)], { url: "/#card" });
    expect(box.app!.placed("card.tab", { callsign: "site@laptop" })).toEqual([{ name: "hello.tab", label: "hello" }]);
    expect(box.app!.placed("card.tab", { callsign: "x@pc" })).toEqual([]);
    expect(t.$('[data-screen="card"]')!.textContent).toBe("вкладка hello");
  });

  it("5122 · show бросил — выключен модуль вставки, а не владелец места; место не из provides — ошибка модуля владельца", async () => {
    const box: { app?: App } = {};
    const t = await stand([
      owner(box),
      tab("boom", () => {
        throw new Error("сломалось");
      }),
    ]);
    expect(box.app!.placed("card.tab")).toEqual([]);
    expect(Object.keys(t.run.failed)).toEqual(["boom"]);
    expect(box.app!.placed("card.tab")).toEqual([]);
    expect(box.app!.placed("chat.tab")).toEqual([]);
    expect(t.run.failed["host-card"]).toContain("места chat.tab нет в provides");
  });

  it("место: команда пунктом с подписью, скрытая show; без подписи — имя; run владельца; open экрана в своём месте", async () => {
    const run = vi.fn();
    const box: { app?: App } = {};
    const o: AppPart = { manifest: man("o", { o: 1, "o.tab": 1 }), module: (a) => ({ screens: { o: { nav: "О", view: () => null } }, start: () => void (box.app = a) }) };
    const guest: AppPart = {
      manifest: man("g", { "g.tab": 1, "g.act": 1, "g.off": 1 }, { "o.tab@o": 1 }),
      module: () => ({
        screens: { "g.tab": { place: "o.tab", label: "Вкладка", view: () => <i data-tab>вкладка</i> } },
        commands: { "g.act": { place: "o.tab", run }, "g.off": { place: "o.tab", show: () => false, run } },
      }),
    };
    const t = await stand([o, guest]);
    expect(box.app!.placed("o.tab")).toEqual([{ name: "g.tab", label: "Вкладка" }, { name: "g.act", label: "g.act" }]);
    box.app!.run("g.act", { x: "1" });
    expect(run).toHaveBeenCalledWith({ x: "1" });
    box.app!.open("g.tab");
    await flush();
    expect(t.$("[data-tab]")).not.toBeNull();
    expect(t.run.failed).toEqual({});
  });

  it("команда: чужая — выключен вызывающий; бросила — выключен её владелец; владелец выключен — ничего", async () => {
    const a = mod();
    const side: AppPart = { manifest: man("s", { go: 1 }), module: () => ({ commands: { go: { run: () => {} } } }) };
    const t = await stand([a.part, side]);
    a.box.app.run("go");
    expect(t.run.failed.m).toContain("команды go нет в uses");

    const run = vi.fn(() => {
      throw new Error("сломана");
    });
    const own: AppPart = { manifest: man("own", { cmd: 1 }), module: () => ({ commands: { cmd: { run } } }) };
    const user = mod({}, {}, { "cmd@own": 1 });
    const u = await stand([own, user.part]);
    user.box.app.run("cmd");
    expect(u.run.failed.own).toBe("Модуль own упал на команде cmd: Error: сломана");
    expect(u.run.failed.m).toBeUndefined();
    user.box.app.run("cmd");
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("метки и разделы хранилища", () => {
  it("своя метка и метка из uses: аргументы доходят; бросила — выключен её владелец; нет ни в uses, ни своей — ошибка вызывающего", async () => {
    const own: AppPart = {
      manifest: man("own", { lab: 1, bad: 1 }),
      module: () => ({
        marks: {
          lab: (x) => `метка ${x}`,
          bad: () => {
            throw new Error("сломана");
          },
        },
      }),
    };
    const m = mod({ marks: { mine: () => 7 } }, { mine: 1 }, { "lab@own": 1, "bad@own": 1 });
    const t = await stand([own, m.part]);
    expect(m.box.app.mark("mine")).toBe(7);
    expect(m.box.app.mark("lab", "x")).toBe("метка x");
    expect(m.box.app.mark("bad")).toBeUndefined();
    expect(t.run.failed.own).toBe("Модуль own упал на метке bad: Error: сломана");
    expect(t.run.failed.m).toBeUndefined();
    expect(m.box.app.mark("fire")).toBeUndefined();
    expect(t.run.failed.m).toContain("метки fire нет в uses");
  });

  it("4031 · владелец метки выключен — метка пуста, читающий модуль работает", async () => {
    const s = sample([], {
      frames: {
        question: () => {
          throw new Error("boom");
        },
      },
    });
    const o = other();
    const t = await stand([s.part, o.part], { roster: oneMachine() });
    expect(o.box.app.mark("need")).toBe(1);
    t.relay.push({ type: "question", from: "a@pc" });
    await flush();
    expect(o.box.app.mark("need")).toBeUndefined();
    expect(t.run.failed.other).toBeUndefined();
  });

  it("свой раздел хранилища: чтение, запись, правка; раздел не из store модуля — ошибка модуля, хранилище не тронуто", async () => {
    const m = mod({ store: ["drafts"] });
    const store = memoryStore({ key: KEY });
    await stand([m.part], { store });
    const s = m.box.app.store<number[]>("drafts");
    expect(await s.get()).toBeUndefined();
    await s.set([1]);
    expect(await s.update((a = []) => [...a, 2])).toEqual([1, 2]);
    expect(store.data.drafts).toEqual([1, 2]);
    const bad = mod({ start: () => void bad.box.app.store("pushes").set([1]) });
    const t = await stand([bad.part], { store });
    expect(t.run.failed.m).toContain("раздела pushes нет в store модуля m");
    expect(store.data.pushes).toBeUndefined();
  });
});

/** Список строк: своя выборка у каждой строки; считает отрисовки. */
function rows(renders: { rows: number }): AppPart {
  let app: App;
  const Row = memo(function Row({ callsign }: { callsign: string }) {
    const s = app.use(() => app.roster()?.sessions.find((x) => x.callsign === callsign));
    renders.rows++;
    return (
      <div className="row" data-cs={callsign}>
        {String(s?.state)}
      </div>
    );
  });
  function List() {
    const names = app.use(() => (app.roster()?.sessions ?? []).map((s) => s.callsign));
    return names.map((c) => <Row key={c} callsign={c} />);
  }
  const m: AppModule = { screens: { list: { nav: "Список", label: "Список", view: List } } };
  return {
    manifest: man("list", { list: 1 }, { "roster@relay": 1 }),
    module: (a) => {
      app = a;
      return m;
    },
  };
}

const many = (n: number): Roster => {
  const r = homeRoster();
  return { ...r, sessions: Array.from({ length: n }, (_, i) => ({ ...r.sessions[0], callsign: `s${i}@laptop`, state: "idle" })) };
};

describe("выборка", () => {
  it("5701 · roster: сменилась 1 сессия из 200, все объекты новые — перерисована 1 строка", async () => {
    // источник: слово пользователя 3 нояб. «нужен быстрый фронт»; опыт дизайна: 1 строка из 200
    const renders = { rows: 0 };
    const roster = many(200);
    const t = await stand([rows(renders)], { roster });
    expect(t.$$(".row")).toHaveLength(200);
    renders.rows = 0;
    const next = JSON.parse(JSON.stringify(roster)) as Roster;
    next.sessions[7].state = "busy";
    t.relay.setRoster(next);
    await flush();
    expect(t.$('[data-cs="s7@laptop"]')!.textContent).toBe("busy");
    expect(renders.rows).toBe(1);
  });

  it("5702 · 10 вызовов changed() за такт — выборки считаются один раз", async () => {
    // источник: опыт дизайна «одно уведомление за такт»
    let app!: App;
    let counted = 0;
    function V() {
      app.use(() => {
        counted++;
        return 1;
      });
      return "экран";
    }
    await stand([{ manifest: man("v", { v: 1 }), module: (a) => ({ screens: { v: { nav: "В", view: V } }, start: () => void (app = a) }) }]);
    counted = 0;
    for (let i = 0; i < 10; i++) app.changed();
    await flush();
    expect(counted).toBe(1);
  });

  it("5703 · метка вернула новый объект с тем же содержимым — 0 перерисовок", async () => {
    // источник: опыт дизайна: сравнение ответов выборки по содержимому
    let app!: App;
    let renders = 0;
    function V() {
      const u = app.use(() => app.mark("unread")) as { count: number };
      renders++;
      return `счёт ${u.count}`;
    }
    const t = await stand([
      {
        manifest: man("v", { v: 1, unread: 1 }),
        module: (a) => {
          app = a;
          return { screens: { v: { nav: "В", view: V } }, marks: { unread: () => ({ count: 3 }) } };
        },
      },
    ]);
    renders = 0;
    app.changed();
    await flush();
    expect(renders).toBe(0);
    expect(t.root.textContent).toContain("счёт 3");
  });

  it("5714 · сессия исчезла из roster — строка исчезла, модуль не выключен", async () => {
    // источник: опыт дизайна; чьё: код — список и строка читают roster независимо
    const roster = many(3);
    const t = await stand([rows({ rows: 0 })], { roster });
    t.relay.setRoster({ ...roster, sessions: roster.sessions.slice(1) });
    await flush();
    expect(t.$$(".row")).toHaveLength(2);
    expect(t.run.failed).toEqual({});
  });

  it("6862 · снятый компонент: его выборка больше не считается", async () => {
    let calls = 0;
    let open = true;
    const box: { app: App } = { app: null as never };
    const Screen = () => {
      const app = useApp();
      app.use(() => {
        calls++;
        return 1;
      });
      return null;
    };
    const p: AppPart = { manifest: man("m", { a: 1, b: 1 }), module: (a) => ({ screens: { a: { nav: "А", view: () => (open ? <Screen /> : null) }, b: { path: "b", view: () => "б" } }, start: () => void (box.app = a) }) };
    await stand([p]);
    expect(calls).toBeGreaterThan(0);
    open = false;
    box.app.open("b");
    await flush();
    calls = 0;
    box.app.changed();
    await flush();
    expect(calls).toBe(0);
  });

  it("7292 · выборка получает свой прошлый ответ аргументом", async () => {
    // источник: чьё: код — удержание ответа без своей копии в экране
    const prevs: unknown[] = [];
    let app!: App;
    function Screen() {
      app.use((prev?: number) => {
        prevs.push(prev);
        return 5;
      });
      return null;
    }
    await stand([{ manifest: man("m", { a: 1 }), module: (x) => ((app = x), { screens: { a: { nav: "А", view: Screen } } }) }]);
    expect(prevs[0]).toBeUndefined();
    expect(prevs.at(-1)).toBe(5);
  });

  /** Экран со своим ответом выборки: тест меняет данные и зовёт changed. */
  async function picked<T>(first: T) {
    const seen: T[] = [];
    let data = first;
    const box: { app: App } = { app: null as never };
    const V = () => {
      seen.push(box.app.use(() => data));
      return null;
    };
    await stand([{ manifest: man("m", { a: 1 }), module: (a) => ((box.app = a), { screens: { a: { nav: "А", view: V } } }) }]);
    const give = async (next: T) => {
      data = next;
      box.app.changed();
      await flush();
      return seen.at(-1)!;
    };
    return { seen, give };
  }

  it("6802 · всё равно — прошлый ответ, перерисовки нет; изменилась ветвь — соседние ветви прежними ссылками", async () => {
    const a = { list: [{ id: 1, s: { x: 1 } }, { id: 2, s: { x: 2 } }], n: 1 };
    const t = await picked(a);
    const renders = t.seen.length;
    expect(await t.give(structuredClone(a))).toBe(t.seen[0]);
    expect(t.seen).toHaveLength(renders);
    const b = structuredClone(a);
    b.list[1].s.x = 9;
    const c = await t.give(b);
    expect(c).not.toBe(t.seen[0]);
    expect(c.list[0]).toBe(t.seen[0].list[0]);
    expect(c.list[1].s.x).toBe(9);
  });

  it("6803 · ключ убран, длина изменилась, тип сменился, не простой объект — новый ответ верен", async () => {
    const t = await picked<unknown>({ a: 1, b: 2 });
    expect(await t.give({ a: 1 })).toEqual({ a: 1 });
    expect(await t.give([1, 2])).toEqual([1, 2]);
    expect(await t.give([1])).toEqual([1]);
    expect(await t.give({ 0: 1 })).toEqual({ 0: 1 });
    const d = new Date(5);
    const was = await t.give({ d: new Date(5) });
    const next = (await t.give({ d })) as { d: Date };
    expect(next.d).toBe(d);
    expect(next).not.toBe(was);
  });
});

describe("что ядро даёт модулю", () => {
  it("имя из пропуска, адрес от gate, вид, приложение; can по contract; worker из сборки, чужое имя — null; state — поле определения", async () => {
    const state = { n: 1 };
    const m = mod({ state });
    await stand([m.part], { options: { application: "pult" } });
    const a = m.box.app;
    expect(a.name).toBe("phone");
    expect(a.address()).toBe("phone~owner@example.com");
    expect(a.wide).toBe(false);
    expect(a.application).toBe("pult");
    expect(a.can("laptop", "answer")).toBe(true);
    expect(a.can("laptop", "nosuch")).toBe(false);
    expect(a.can("mac", "answer")).toBeNull();
    expect(a.worker("push")).toBe("https://push.test/");
    expect(a.worker("toString")).toBeNull();
    expect(a.current()).toEqual({ screen: "a", params: {}, master: null });
    expect(a.link()).toBe("open");
    expect(a.state).toBe(state);
  });
});
