// Вид ядра: выборки, место экрана, падение модуля, области стилей — эталоны дизайна «Новая модульность фронта»
// (слово пользователя 3 нояб.: «нужен быстрый фронт», «делай»).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, useState } from "react";
import { memoryStore, startApp, startBuild, type App, type AppModule, type AppPart, type BuildList, type Manifest, type Roster } from "../contract.ts";
import { boot as bootShell } from "../../../shell.ts";
import { FakeRelay, flush, homeRoster, KEY } from "../stand/relay.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

const root = () => document.getElementById("app")!;
const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 1, "roster@relay": 1, ...uses } });

async function boot(parts: AppPart[], roster: Roster = homeRoster()) {
  const relay = new FakeRelay(roster);
  const run = startApp({ root: root(), workers: FakeRelay.WORKERS, fetch: relay.fetch, parts, store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
  await run.ready;
  await flush();
  return { relay, run };
}

/** Список строк: своя выборка у каждой строки; считает отрисовки. */
function listModule(renders: { rows: number }) {
  let app: App;
  const Row = memo(function Row({ callsign }: { callsign: string }) {
    const s = app.use(() => app.roster()?.sessions.find((x) => x.callsign === callsign));
    renders.rows++;
    return <div className="row" data-cs={callsign}>{String(s?.state)}</div>;
  });
  function List() {
    const names = app.use(() => (app.roster()?.sessions ?? []).map((s) => s.callsign));
    return (
      <>
        {names.map((c) => (
          <Row key={c} callsign={c} />
        ))}
      </>
    );
  }
  const module: AppModule = { screens: { list: { nav: "Список", label: "Список", view: List } }, start: (a) => void (app = a) };
  return { manifest: man("list", { list: 1 }), module } satisfies AppPart;
}

const manySessions = (n: number): Roster => {
  const r = homeRoster();
  return { ...r, sessions: Array.from({ length: n }, (_, i) => ({ ...r.sessions[0], callsign: `s${i}@laptop`, state: "idle" })) };
};

describe("выборки", () => {
  it("5701 · roster: сменилась 1 сессия из 200, все объекты новые — перерисована 1 строка", async () => {
    // источник: слово пользователя 3 нояб. «нужен быстрый фронт»; опыт дизайна: 1 строка из 200
    const renders = { rows: 0 };
    const roster = manySessions(200);
    const { relay } = await boot([listModule(renders)], roster);
    expect(root().querySelectorAll(".row")).toHaveLength(200);
    renders.rows = 0;
    const next = JSON.parse(JSON.stringify(roster)) as Roster;
    next.sessions[7].state = "busy";
    relay.setRoster(next);
    await flush();
    expect(root().querySelector('[data-cs="s7@laptop"]')!.textContent).toBe("busy");
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
    await boot([{ manifest: man("v", { v: 1 }), module: { screens: { v: { nav: "В", view: V } }, start: (a) => void (app = a) } }]);
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
    const module: AppModule = { screens: { v: { nav: "В", view: V } }, marks: { unread: () => ({ count: 3 }) }, start: (a) => void (app = a) };
    await boot([{ manifest: man("v", { v: 1, unread: 1 }), module }]);
    renders = 0;
    app.changed();
    await flush();
    expect(renders).toBe(0);
    expect(root().textContent).toContain("счёт 3");
  });

  it("5714 · сессия исчезла из roster — строка исчезла, модуль не выключен", async () => {
    // источник: опыт дизайна; чьё: код — список и строка читают roster независимо
    const roster = manySessions(3);
    const { relay, run } = await boot([listModule({ rows: 0 })], roster);
    relay.setRoster({ ...roster, sessions: roster.sessions.slice(1) });
    await flush();
    expect(root().querySelectorAll(".row")).toHaveLength(2);
    expect(run.failed).toEqual({});
  });
});

describe("место экрана", () => {
  const neighbour = (): AppPart => listModule({ rows: 0 });

  it("5704 · ошибка отрисовки: все места модуля показывают причину, сосед обновляется", async () => {
    // источник: устав — ошибка модуля: модуль выключен, остальные работают
    let app!: App;
    let bad = false;
    function Bad() {
      const v = app.use(() => bad);
      if (v) throw new Error("сломан рендер");
      return <div data-bad="1">жив</div>;
    }
    const broken: AppPart = { manifest: man("broken", { broken: 1 }), module: { screens: { broken: { nav: "Плохой", label: "Плохой", view: Bad } }, start: (a) => void (app = a) } };
    const { relay, run } = await boot([broken, neighbour()]);
    expect(root().querySelector("[data-bad]")).not.toBeNull();
    bad = true;
    app.changed();
    await flush();
    expect(run.failed.broken).toContain("сломан рендер");
    expect(root().querySelector("[data-bad]")).toBeNull();
    expect(root().textContent).toContain("Плохой выключен");
    location.hash = "#list";
    await flush();
    const next = manySessions(4);
    relay.setRoster(next);
    await flush();
    expect(root().querySelectorAll(".row")).toHaveLength(4);
  });

  it("5709 · app.Slot с экраном вне uses — выключен вызывающий, причина словом", async () => {
    // чьё: код — правило «экран — свой, из uses или вставленный в своё место»
    let app!: App;
    const V = () => <app.Slot screen="side" />;
    const caller: AppPart = { manifest: man("caller", { caller: 1 }), module: { screens: { caller: { nav: "Вызов", label: "Вызов", view: V } }, start: (a) => void (app = a) } };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: { screens: { side: { label: "Бок", view: () => "бок" } } } };
    const { run } = await boot([caller, side]);
    expect(run.failed.caller).toContain("экрана side нет в uses");
    expect(root().textContent).not.toContain("бок");
  });

  it("5715 · тот же экран с другими параметрами — экран начат заново, черновик не перешёл", async () => {
    // чьё: код — прежний экран заново монтировался при смене параметров
    let app!: App;
    function Card({ params }: { params: Record<string, string> }) {
      const [draft, set] = useState("");
      return (
        <button data-card={params.callsign} onClick={() => set("черновик")}>
          {`${params.callsign}:${draft}`}
        </button>
      );
    }
    const part: AppPart = { manifest: man("c", { card: 1 }), module: { screens: { card: { nav: "К", view: Card } }, start: (a) => void (app = a) } };
    await boot([part]);
    app.open("card", { callsign: "a@pc" });
    await flush();
    root().querySelector<HTMLElement>('[data-card="a@pc"]')!.click();
    await flush();
    expect(root().querySelector('[data-card="a@pc"]')!.textContent).toBe("a@pc:черновик");
    app.open("card", { callsign: "b@pc" });
    await flush();
    expect(root().querySelector('[data-card="b@pc"]')!.textContent).toBe("b@pc:");
  });

  it("5708 · стиль модуля заключён в область: до вложенного модуля, не дальше", async () => {
    // источник: опыт дизайна в Chrome, Firefox и WebKit; здесь — что ядро ставит область и место модуля
    let app!: App;
    const outer: AppPart = {
      manifest: man("outer", { outer: 1 }, { "inner@inner-m": 1 }),
      module: { screens: { outer: { nav: "Вне", view: () => <app.Slot screen="inner" /> } }, css: ".t{color:red}", start: (a) => void (app = a) },
    };
    const inner: AppPart = { manifest: man("inner-m", { inner: 1 }), module: { screens: { inner: { view: () => <b className="t">внутри</b> } } } };
    await boot([outer, inner]);
    expect(root().querySelector("style")!.textContent).toContain('@scope ([data-module="outer"]) to ([data-module]) {\n.t{color:red}\n}');
    expect(root().querySelector('[data-module="outer"] [data-module="inner-m"] .t')!.textContent).toBe("внутри");
  });

  it("браузер без @scope — экран «Браузер устарел», модули не стартуют", async () => {
    // источник: дизайн: «система ловит»; модуль без области стилей не показываем
    const relay = new FakeRelay(homeRoster());
    const started = vi.fn();
    const run = startApp({ root: root(), workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [{ manifest: man("m", {}), module: { start: started } }], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false, scope: false } });
    await run.ready;
    await flush();
    expect(run.stopped).toBe("browser");
    expect(root().textContent).toContain("Браузер устарел");
    expect(started).not.toHaveBeenCalled();
  });
});

describe("сборка страницы", () => {
  const list: BuildList = { app: "phone", version: "1.0.0+1", fleet: "test", modules: [{ name: "slow", version: "1.0.0" }, { name: "ok", version: "1.0.0" }], workers: FakeRelay.WORKERS };

  it("5706 · файл модуля не отвечает — через предел выключен только он", async () => {
    // источник: устав — у всех операций лимит
    const relay = new FakeRelay(homeRoster());
    const ok: AppModule = { screens: { ok: { nav: "Живой", view: () => "живой" } } };
    const run = await startBuild({
      root: root(),
      build: list,
      loadMs: 10,
      load: (name) => (name === "slow" ? new Promise(() => {}) : Promise.resolve({ default: ok, manifest: man("ok", { ok: 1 }) })),
      fetch: relay.fetch,
      store: memoryStore({ key: KEY }),
      WebSocket: relay.WebSocket,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
    });
    await run.ready;
    await flush();
    expect(run.failed.slow).toContain("не загрузился за 10 мс");
    expect(root().textContent).toContain("живой");
  });

  it("5716 · упал вид ядра — страница показывает причину, а не пустоту", async () => {
    // источник: дизайн «Новая модульность фронта», эталон основания; вид ядра — вне границы модуля
    const relay = new FakeRelay(homeRoster());
    const broken = { nav: "М", view: () => "экран", get group(): string { throw new Error("сломана группа раздела"); } };
    const part: AppPart = { manifest: man("m", { m: 1 }), module: { screens: { m: broken } } };
    const run = startApp({ root: root(), workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [part], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    await run.ready;
    await flush();
    expect(root().textContent).toBe("Приложение упало: сломана группа раздела");
  });

  it("5716 · не загрузилась сборка — страница показывает причину", async () => {
    // чьё: код — оболочка; основание загружается раньше модулей, работать нечему
    vi.stubGlobal("fetch", () => Promise.reject(new Error("нет сети")));
    await expect(bootShell({})).rejects.toThrow("нет сети");
    expect(root().textContent).toBe("Сборка не загрузилась: нет сети");
    vi.unstubAllGlobals();
  });
});
