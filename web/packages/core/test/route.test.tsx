// Открытый экран и выборка вида: on.current на каждый переход; useApp, снятый компонент, параметры, падение чужого места.
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, startApp, type App, type AppPart, type Manifest, type Params } from "../contract.ts";
import { useApp } from "@switchboard/web-ui";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../stand/app.ts";

const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 1, ...uses } });

type Seen = { screen: string; params: Params };

/** Модуль с экранами a (раздел), b, командой cmd; записывает on.current. */
function part(over: { current?(c: Seen): void; roster?(): void; run?(): void } = {}) {
  const seen: Seen[] = [];
  const box: { app: App } = { app: null as never };
  const p: AppPart = {
    manifest: man("m", { a: 1, b: 1, c: 1, cmd: 1 }, { "roster@relay": 1 }),
    module: {
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
        cmd: { run: () => over.run?.() },
      },
      start: (a) => void (box.app = a),
    },
  };
  return { p, seen, box };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("on.current", () => {
  it("6840 · адрес сменили снаружи: один раз, экран и параметры из адреса", async () => {
    // факт: types.ts «открыт экран: человек перешёл, новый адрес или команда app.open»
    const m = part();
    const t = await stand([m.p]);
    m.seen.length = 0;
    await t.go("#b?x=1");
    expect(m.seen).toEqual([{ screen: "b", params: { x: "1" } }]);
    expect(t.$('[data-s="b"]')!.textContent).toBe("б 1");
  });

  it("6841 · назад браузером: прежний экран; второе событие того же адреса экран не строит", async () => {
    // чьё: код — router.ts: routed
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

  it("6842 · назад без истории: домашний раздел, запись истории не добавлена", async () => {
    // чьё: код — router.ts: back
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

  it("6843 · первый roster открывает экран адреса после on.roster; следующий roster on.current не зовёт", async () => {
    // факт: core/contract.ts «start() модулей → link к relay → экран из адреса»; порядок — чьё: код
    const log: string[] = [];
    const m = part({ roster: () => log.push("roster"), current: () => log.push("current") });
    const relay = new FakeRelay(homeRoster());
    await stand([m.p], { relay, url: "/#b?x=2" });
    expect(m.seen).toEqual([{ screen: "b", params: { x: "2" } }]);
    expect(log.indexOf("roster")).toBeLessThan(log.indexOf("current"));
    relay.setRoster(homeRoster());
    await flush();
    expect(m.seen).toHaveLength(1);
  });

  it("6844 · app.open: экран — адрес и on.current; команда — run, адрес и экран прежние", async () => {
    // чьё: код — module-app.tsx: open
    const run = vi.fn();
    const m = part({ run });
    await stand([m.p]);
    m.seen.length = 0;
    m.box.app.open("b", { x: "1" });
    await flush();
    expect(location.hash).toBe("#b?x=1");
    expect(m.seen).toEqual([{ screen: "b", params: { x: "1" } }]);
    m.box.app.open("cmd");
    await flush();
    expect(run).toHaveBeenCalledOnce();
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

  it("6847 · незнакомый адрес и адрес полосы top: домашний раздел с пустыми параметрами", async () => {
    // чьё: код — router.ts: parseHash
    const m = part();
    m.p.manifest.provides.bar = 1;
    m.p.manifest.uses["top@web-core"] = 1;
    m.p.module.screens!.bar = { place: "top", path: "bar", view: () => null };
    await stand([m.p], { url: "/#b" });
    m.seen.length = 0;
    history.replaceState(null, "", "#nosuch?x=1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(m.seen).toEqual([{ screen: "a", params: {} }]);
    m.seen.length = 0;
    history.replaceState(null, "", "#b");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    m.seen.length = 0;
    history.replaceState(null, "", "#bar");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(m.seen).toEqual([{ screen: "a", params: {} }]);
  });

  it("6848 · до первого roster on.current нет; после отказа revoked — экран причины, on.current нет", async () => {
    // источник: устав — система ловит: останавливает и не пускает дальше
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
    const m = part();
    const relay = new FakeRelay(homeRoster());
    const run = startApp({ root: document.getElementById("app")!, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [m.p], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    await run.ready;
    history.replaceState(null, "", "#b");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(m.seen).toEqual([]);
    run.unmount();

    const n = part();
    const refused = new FakeRelay(homeRoster());
    refused.refuse = ["revoked", "revoked"];
    const t = await stand([n.p], { relay: refused });
    await flush(20);
    expect(t.run.stopped).toBe("revoked");
    n.seen.length = 0;
    history.replaceState(null, "", "#c");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
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
    const other: Seen[] = [];
    const neighbour: AppPart = { manifest: man("n", { n: 1 }), module: { on: { current: (c) => void other.push(c) }, screens: { n: { label: "Н", view: () => "н" } } } };
    const t = await stand([m.p, neighbour]);
    other.length = 0;
    m.box.app.open("b");
    await flush();
    expect(t.run.failed.m).toContain("сломан переход");
    expect(other).toEqual([{ screen: "b", params: {} }]);
    bad.mockClear();
    history.replaceState(null, "", "#n");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(bad).not.toHaveBeenCalled();
    expect(other.at(-1)).toEqual({ screen: "n", params: {} });
  });

  it("6850 · app.open мимо uses: выключен вызывающий; адрес и экран прежние, on.current нет", async () => {
    // источник: устав — части пользуются друг другом только через контракт
    const m = part();
    const side: AppPart = { manifest: man("s", { side: 1 }), module: { screens: { side: { path: "side", view: () => "бок" } } } };
    const t = await stand([m.p, side]);
    m.seen.length = 0;
    const before = location.hash;
    m.box.app.open("side");
    await flush();
    expect(t.run.failed.m).toContain("экрана side нет в uses");
    expect(location.hash).toBe(before);
    expect(m.seen).toEqual([]);
  });
});

describe("выборка и место экрана", () => {
  it("6860 · useApp: в экране и в чужом месте — app своего модуля", async () => {
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
    const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: { screens: { main: { nav: "Г", view: Main } }, start: (a) => void (starts.main = a) } };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: { screens: { side: { view: Side } }, start: (a) => void (starts.side = a) } };
    const t = await stand([side, main]);
    expect(t.$("[data-side]")).not.toBeNull();
    expect(got.main).toBe(starts.main);
    expect(got.side).toBe(starts.side);
    expect(got.main).not.toBe(got.side);
  });

  it("6861 · useApp вне экрана — исключение словами", () => {
    // источник: устав — система ловит; ловит его корень вида (эталон 5716)
    const Free = () => {
      useApp();
      return null;
    };
    expect(() => renderToString(<Free />)).toThrow("useApp вне экрана модуля");
  });

  it("6862 · снятый компонент: его выборка больше не считается", async () => {
    // чьё: код — bus.ts: подписка снята
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
    const p: AppPart = { manifest: man("m", { a: 1, b: 1 }), module: { screens: { a: { nav: "А", view: () => (open ? <Screen /> : null) }, b: { path: "b", view: () => "б" } }, start: (a) => void (box.app = a) } };
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
    const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: { screens: { main: { nav: "Г", view: Main } } } };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: { screens: { side: { view: Side } } } };
    const t = await stand([side, main]);
    await t.click(t.$("[data-side]"));
    expect(t.$("[data-side]")!.textContent).toBe("1");
    renders = 0;
    bump();
    await flush();
    expect(renders).toBe(0);
    expect(t.$("[data-side]")!.textContent).toBe("1");
  });

  it("6864 · чужой экран в Slot упал: выключен только он; экран вызывающего и его состояние целы", async () => {
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
        <div>
          <button data-main onClick={() => set(n + 1)}>
            {n}
          </button>
          <app.Slot screen="bad" />
        </div>
      );
    }
    const main: AppPart = { manifest: man("main", { main: 1 }, { "bad@bad": 1 }), module: { screens: { main: { nav: "Г", view: Main } } } };
    const bad: AppPart = { manifest: man("bad", { bad: 1 }), module: { screens: { bad: { label: "Бок", view: Bad } }, start: (a) => void (box = a) } };
    const t = await stand([bad, main]);
    await t.click(t.$("[data-main]"));
    boom = true;
    box.changed();
    await flush();
    expect(t.run.failed.bad).toContain("сломан бок");
    expect(t.run.failed.main).toBeUndefined();
    expect(t.$("[data-main]")!.textContent).toBe("1");
    expect(t.root.textContent).toContain("Бок выключен");
  });

  it("6865 · «Перезапустить приложение» на экране упавшего модуля перезагружает страницу", async () => {
    // источник: устав — чистый перезапуск компонента или процесса
    const reload = vi.fn();
    const real = window.location;
    const Bad = () => {
      throw new Error("сломан экран");
    };
    const p: AppPart = { manifest: man("m", { a: 1 }), module: { screens: { a: { nav: "А", label: "А", view: Bad } } } };
    const fake = new Proxy(real, { get: (o, k) => (k === "reload" ? reload : Reflect.get(o, k)) });
    const win = new Proxy(window, { get: (o, k) => { if (k === "location") return fake; const v = Reflect.get(o, k); return typeof v === "function" ? v.bind(o) : v; } });
    const t = await stand([p], { options: { window: win as Window } });
    expect(t.run.failed.m).toContain("сломан экран");
    await t.click(t.button("Перезапустить приложение"));
    expect(reload).toHaveBeenCalledOnce();
  });
});
