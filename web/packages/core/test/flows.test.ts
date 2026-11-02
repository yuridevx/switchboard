// Флоу ядра по плану цикла тестов (web): ключ, связь, roster, маршрут кадров, запросы, экраны, уход с экрана, метки.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appGate, memoryStore, startApp, type App, type AppModule, type AppPart, type Manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, INVITE, KEY, oneMachine } from "../stand/relay.ts";

const man = (name: string, provides: Record<string, number>, uses: Record<string, number>): Manifest => ({
  name,
  type: "web",
  version: "1.0.0",
  provides,
  uses: { "app@web-core": 1, ...uses },
});


/** Модуль-образец: раздел list с меткой need по roster, экран item, кадр question, запросы answer и push.key. */
function sample(log: string[] = [], over: Partial<AppModule> = {}) {
  const box: { app: App } = { app: null as unknown as App };
  const mod: AppModule = {
    frames: { question: (f) => void log.push(`question ${f.from}`) },
    on: { roster: (r) => log.push(`roster ${r.sessions.length}`), link: (s) => log.push(`link ${s}`) },
    screens: {
      list: {
        nav: "Сессии",
        mark: "need",
        label: "Список",
        mount(el) {
          const draw = () => (el.textContent = `список ${box.app.roster()?.sessions.length}`);
          draw();
          return { refresh: draw, close: () => log.push("list closed") };
        },
      },
      item: {
        label: "Карточка",
        mount(el, p) {
          el.append(`item ${p.callsign}`);
          return { close: () => log.push(`item closed ${p.callsign}`) };
        },
      },
    },
    marks: { need: () => (box.app.roster()?.sessions ?? []).filter((s) => s.state === "waiting").length },
    store: ["drafts"],
    start(a) {
      box.app = a;
      log.push("start sample");
    },
    stop() {
      log.push("stop sample");
    },
    ...over,
  };
  const part: AppPart = {
    manifest: man("sample", { list: 1, item: 1, need: 1 }, { "roster@relay": 1, "question@host-questions": 1, "answer@host-questions": 1, "push.key@push": 1 }),
    module: mod,
  };
  return { part, box };
}

/** Второй модуль: свой экран side; uses — экран item и метка need модуля sample. */
function other(log: string[] = [], over: Partial<AppModule> = {}) {
  const box: { app: App } = { app: null as unknown as App };
  const part: AppPart = {
    manifest: man("other", { side: 1 }, { "item@sample": 1, "need@sample": 1 }),
    module: {
      screens: { side: { label: "Сбоку", mount: (el) => void el.append("сбоку") } },
      start(a) {
        box.app = a;
        log.push("start other");
      },
      stop() {
        log.push("stop other");
      },
      ...over,
    },
  };
  return { part, box };
}

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
  history.replaceState(null, "", "/");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function boot(o: { parts: AppPart[]; store?: ReturnType<typeof memoryStore>; relay?: FakeRelay; pauseMs?: number; wide?: boolean; noWait?: boolean }) {
  const relay = o.relay ?? new FakeRelay(oneMachine());
  relay.handlers["gate.redeem"] ??= (f) => (f.invite === INVITE ? { ok: true, result: { key: KEY } } : { ok: false, error: "bad_invite" });
  const store = o.store ?? memoryStore({ key: KEY });
  const run = startApp({
    root,
    relayUrl: "wss://relay.test",
    workers: FakeRelay.WORKERS,
    fetch: relay.fetch,
    parts: o.parts,
    store,
    WebSocket: relay.WebSocket,
    platform: { ios: false, standalone: false },
    pauseMs: o.pauseMs ?? 5,
    wide: o.wide,
  });
  await run.ready;
  if (!o.noWait) await flush();
  return { run, relay, store };
}

const off = () => root.querySelector<HTMLElement>(".sb-off")!;

describe("старт и ключ", () => {
  it("4002 · start модуля бросил — выключен он, остальные стартуют, hello уходит", async () => {
    const log: string[] = [];
    const s = sample(log, {
      start() {
        throw new Error("нет памяти");
      },
    });
    const o = other(log);
    const { run, relay } = await boot({ parts: [s.part, o.part] });
    expect(run.failed).toEqual({ sample: "Модуль sample упал на старте: Error: нет памяти" });
    expect(log).toContain("start other");
    expect(relay.hellos).toHaveLength(1);
    expect(run.stopped).toBeNull();
    // экран упавшего модуля — с причиной
    expect(root.textContent).toContain("Список выключен");
  });

  it("4003 · ключ из хранилища при повторном входе — hello с ним, без тоста «Вы во флоте»", async () => {
    const { relay } = await boot({ parts: [sample().part], store: memoryStore({ key: KEY }) });
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(root.querySelector<HTMLElement>(".sb-toast")!.hidden).toBe(true);
  });

  it("4004 · 5104 · приглашение вставлено вручную — принято у gate, пропуск в хранилище, перезагрузка", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const store = memoryStore();
    const { run } = await boot({ parts: [sample().part], store });
    expect(run.stopped).toBe("no_key");
    const inp = root.querySelector<HTMLInputElement>(".sb-keyin")!;
    inp.value = `https://switchboard-phone.test/#invite=${INVITE}`;
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Принять приглашение")!.click();
    await flush();
    expect(store.data.key).toBe(KEY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("4005 · вставлено не приглашение — отказ словами, хранилище не тронуто", async () => {
    const store = memoryStore();
    const { run } = await boot({ parts: [sample().part], store });
    expect(run.stopped).toBe("no_key");
    root.querySelector<HTMLInputElement>(".sb-keyin")!.value = "hello";
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Принять приглашение")!.click();
    await flush();
    expect(root.querySelector('[role="alert"]')!.textContent).toBe("Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.");
    expect(store.data.key).toBeUndefined();
  });
});

describe("связь с relay", () => {
  it("4006 · hello принят — модули получают open, полосы «Нет связи» нет, app.link() = open", async () => {
    const log: string[] = [];
    const s = sample(log);
    await boot({ parts: [s.part] });
    expect(log.filter((x) => x.startsWith("link"))).toEqual(["link open"]);
    expect(off().hidden).toBe(true);
    expect(s.box.app.link()).toBe("open");
  });

  it("4007 · contract_mismatch — «Приложение устарело» с proto и «Перезагрузить», второго hello нет", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["contract_mismatch"];
    const { run } = await boot({ parts: [sample().part], relay });
    await flush(20);
    expect(run.stopped).toBe("contract_mismatch");
    expect(root.textContent).toContain("Приложение устарело");
    expect(root.textContent).toContain("У приложения proto 1");
    expect([...root.querySelectorAll("button")].some((b) => b.textContent === "Перезагрузить")).toBe(true);
    expect(relay.hellos).toHaveLength(1);
  });

  it("4008 · прочий отказ relay (replaced) — «Связь остановлена» со словом, без переподключений", async () => {
    const { run, relay } = await boot({ parts: [sample().part] });
    relay.drop(1000, "replaced");
    await flush(20);
    expect(run.stopped).toBe("replaced");
    expect(root.textContent).toContain("Связь остановлена");
    expect(root.textContent).toContain("relay закрыл соединение: replaced.");
    expect(relay.hellos).toHaveLength(1);
  });

  it("4009 · «Сейчас» на полосе — новый hello сразу, прежнее закрыто 1000 now без экрана отказа", async () => {
    const { run, relay } = await boot({ parts: [sample().part], pauseMs: 60_000 });
    relay.drop();
    await flush();
    expect(off().hidden).toBe(false);
    [...off().querySelectorAll("button")].find((b) => b.textContent === "Сейчас")!.click();
    await flush();
    expect(relay.hellos).toHaveLength(2);
    expect(run.stopped).toBeNull();
    expect(off().hidden).toBe(true);
  });

  it("4010 · отказ hello до первого roster — полоса «Нет связи» на экране подключения", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["gate_unavailable"];
    await boot({ parts: [sample().part], relay, pauseMs: 60_000 });
    expect(root.textContent).toContain("подключаюсь · hello");
    expect(off().hidden).toBe(false);
    expect(off().textContent).toMatch(/^Нет связи с relay · снова через \d+ сСейчас$/);
  });
});

describe("roster", () => {
  it("4011 · до первого roster — «подключаюсь»; первый roster открывает экран из адреса", async () => {
    history.replaceState(null, "", "/#item?callsign=site%40laptop");
    const relay = new FakeRelay(oneMachine());
    const pending = boot({ parts: [sample().part], relay, noWait: true });
    await pending;
    expect(root.textContent).toContain("подключаюсь · hello");
    await flush();
    expect(root.querySelector('[data-screen="item"]')!.textContent).toBe("item site@laptop");
  });

  it("4013 · следующий roster — счётчик раздела в колонке широкого вида", async () => {
    const { relay } = await boot({ parts: [sample().part], wide: true });
    const nav = () => root.querySelector('.sb-navcol button[data-screen="list"]')!.textContent;
    expect(nav()).toBe("Сессии1");
    const r = oneMachine();
    r.sessions = [...r.sessions, { callsign: "x@laptop", state: "waiting" }, { callsign: "y@laptop", state: "waiting" }];
    relay.setRoster(r);
    await flush();
    expect(nav()).toBe("Сессии3");
  });

  it("4014 · владелец метки раздела выключен — счётчика нет, раздел и roster работают", async () => {
    const log: string[] = [];
    const s = sample(log, {
      frames: {
        question: () => {
          throw new Error("boom");
        },
      },
    });
    const { relay, run } = await boot({ parts: [s.part], wide: true });
    relay.push({ type: "question", from: "site@laptop" });
    await flush();
    expect(run.failed.sample).toContain("boom");
    relay.setRoster(homeRoster());
    await flush();
    expect(root.querySelector('.sb-navcol button[data-screen="list"]')!.textContent).toBe("Сессии");
  });
});

describe("кадры и запросы", () => {
  it("4015 · кадр без владельца и без id — пропущен с предупреждением, ответа нет", async () => {
    const warn = vi.spyOn(console, "warn");
    const { relay, run } = await boot({ parts: [sample().part] });
    const before = relay.got.length;
    relay.push({ type: "nobody" });
    await flush();
    expect(warn).toHaveBeenCalledWith("switchboard: кадр nobody — владельца в приложении нет");
    expect(relay.got.length).toBe(before);
    expect(run.failed).toEqual({});
  });

  it("4194 · версия, названная в вызове, — как есть; не названа — из uses (одно правило с ядром Host)", async () => {
    // источник: чьё: код (ядро Host: названная — как есть, иначе из uses/provides); слепое расширение 2 нояб. — веб перезаписывал названную
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = () => ({ ok: true });
    await boot({ parts: [s.part], relay });
    await s.box.app.request("answer", { callsign: "profiles@laptop", question: "q1", v: 2 });
    await s.box.app.request("answer", { callsign: "profiles@laptop", question: "q2" });
    expect(relay.sent("answer").map((f) => f.v)).toEqual([2, 1]);
  });

  it("4016 · запрос к Host — кадр с v из uses и callsign; reply ok — результат", async () => {
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = () => ({ ok: true, result: { done: 1 } });
    await boot({ parts: [s.part], relay });
    expect(await s.box.app.request("answer", { callsign: "profiles@laptop", question: "q1" })).toEqual({ ok: true, result: { done: 1 } });
    expect(relay.sent("answer")).toEqual([{ type: "answer", v: 1, callsign: "profiles@laptop", question: "q1", id: expect.any(String) }]);
  });

  it("4018 · отказ владельца — слово модулю, ядро не бросает, модуль не выключен", async () => {
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = () => ({ ok: false, error: "offline" });
    const { run } = await boot({ parts: [s.part], relay });
    expect(await s.box.app.request("answer", { callsign: "profiles@laptop" })).toEqual({ ok: false, error: "offline" });
    expect(run.failed).toEqual({});
  });

  it("4019 · машины нет в roster — кадр уходит, отказ relay словом", async () => {
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = () => ({ ok: false, error: "offline" });
    await boot({ parts: [s.part], relay });
    expect(await s.box.app.request("answer", { callsign: "x@mac" })).toEqual({ ok: false, error: "offline" });
    expect(relay.sent("answer")).toEqual([expect.objectContaining({ callsign: "x@mac", v: 1 })]);
  });
});

describe("экраны и адрес", () => {
  it("4020 · экран в месте другого модуля — адрес не меняется, close() убирает его", async () => {
    const log: string[] = [];
    const s = sample(log);
    const o = other(log);
    await boot({ parts: [s.part, o.part] });
    const place = document.createElement("div");
    root.querySelector('[data-screen="list"]')!.append(place);
    const h = o.box.app.open("item", { callsign: "a@pc" }, place)!;
    expect(place.textContent).toBe("item a@pc");
    expect(location.hash).toBe("");
    h.close!();
    expect(log).toContain("item closed a@pc");
  });

  it("4022 · неизвестный путь в адресе — домашний раздел", async () => {
    history.replaceState(null, "", "/#nope");
    await boot({ parts: [sample().part] });
    expect(root.querySelector('[data-screen="list"]')).not.toBeNull();
  });

  it("4023 · экран не свой и не из uses — ошибка модуля, экран не открыт", async () => {
    const s = sample();
    const o = other();
    const { run } = await boot({ parts: [s.part, o.part] });
    s.box.app.open("side");
    await flush();
    expect(run.failed.sample).toContain("экрана side нет в uses");
    expect(root.querySelector('[data-screen="side"]')).toBeNull();
  });

  it("4024 · экран выключенного модуля — причина вместо экрана, mount не зовётся", async () => {
    const mount = vi.fn();
    const s = sample([], {
      frames: {
        question: () => {
          throw new Error("boom");
        },
      },
    });
    s.part.module.screens!.item.mount = mount;
    const { relay } = await boot({ parts: [s.part] });
    relay.push({ type: "question", from: "a@pc" });
    await flush();
    history.pushState(null, "", "/#item?callsign=a%40pc");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(mount).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Карточка выключен");
    expect(root.textContent).toContain("Перезапустить приложение");
  });

  it("4025 · адрес сменили вручную — экран из адреса", async () => {
    await boot({ parts: [sample().part] });
    history.pushState(null, "", "/#item?callsign=b%40pc");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(root.querySelector('[data-screen="item"]')!.textContent).toBe("item b@pc");
  });
});

describe("уход с экрана", () => {
  it("4026 · stop модуля бросил — он выключен, остальные остановлены, соединение закрыто 1000", async () => {
    const log: string[] = [];
    const s = sample(log, {
      stop() {
        throw new Error("не дописал");
      },
    });
    const o = other(log);
    const { run, relay } = await boot({ parts: [s.part, o.part] });
    await run.hide();
    expect(run.failed.sample).toContain("упал на остановке");
    expect(log).toContain("stop other");
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
  });

  it("4027 · страница открылась скрытой — связи нет до показа", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      const { run, relay } = await boot({ parts: [sample().part] });
      expect(relay.socks).toHaveLength(0);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await run.show();
      await flush();
      expect(relay.hellos).toHaveLength(1);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("4028 · pagehide после hidden — остановка одна", async () => {
    const log: string[] = [];
    const { run } = await boot({ parts: [sample(log).part] });
    const a = run.hide();
    window.dispatchEvent(new Event("pagehide"));
    await a;
    await run.hide();
    expect(log.filter((x) => x === "stop sample")).toHaveLength(1);
  });

  it("4029 · после отказа relay возвращение на экран не подключает", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["revoked"];
    const log: string[] = [];
    const { run } = await boot({ parts: [sample(log).part], relay });
    await flush(10);
    await run.hide();
    await run.show();
    await flush(10);
    expect(relay.hellos).toHaveLength(1);
    expect(log.filter((x) => x === "start sample")).toHaveLength(1);
    expect(root.textContent).toContain("Пропуск отозван");
  });
});

describe("машины флота", () => {
  it("5105 · соединение с relay каждой машины; relay laptop упал — сессии pc на экране и запросы к ним работают", async () => {
    const relay = new FakeRelay(homeRoster());
    const s = sample();
    const { run } = await boot({ parts: [s.part], relay });
    expect(relay.socks.map((x) => x.url).sort()).toEqual(["wss://relay.test/m/laptop", "wss://relay.test/m/pc"]);
    expect(s.box.app.roster()!.sessions.map((x) => x.callsign).sort()).toEqual(["poe-bot@pc", "profiles@laptop", "site@laptop", "wiki@pc"]);
    relay.socks.find((x) => x.url.endsWith("/m/laptop"))!.serverClose(1006, "");
    await flush();
    expect(s.box.app.link()).toBe("open");
    expect(run.stopped).toBeNull();
    relay.handlers.answer = () => ({ ok: true, result: { done: 1 } });
    expect(await s.box.app.request("answer", { callsign: "poe-bot@pc", question: "q1" })).toEqual({ ok: true, result: { done: 1 } });
  });
});

describe("хранилище и метки", () => {
  it("4030 · раздел не из store модуля — ошибка модуля, хранилище не тронуто", async () => {
    const store = memoryStore({ key: KEY });
    const s = sample([], {
      start(a) {
        void a.store("pushes").set([1]);
      },
    });
    const { run } = await boot({ parts: [s.part], store });
    expect(run.failed.sample).toContain("раздела pushes нет в store модуля sample");
    expect(store.data.pushes).toBeUndefined();
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
    const { relay, run } = await boot({ parts: [s.part, o.part] });
    expect(o.box.app.mark("need")).toBe(1);
    relay.push({ type: "question", from: "a@pc" });
    await flush();
    expect(o.box.app.mark("need")).toBeUndefined();
    expect(run.failed.other).toBeUndefined();
  });

  it("4032 · метки нет ни в uses, ни своей — ошибка модуля", async () => {
    const o = other();
    const { run } = await boot({ parts: [sample().part, o.part] });
    expect(o.box.app.mark("fire")).toBeUndefined();
    expect(run.failed.other).toContain("метки fire нет в uses");
  });
});

describe("места в странице", () => {
  // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): place у экрана, app.placed и show у владельца места
  const owner = (box: { app?: App }): AppPart => ({
    manifest: man("host-card", { card: 1, "card.tab": 1 }, {}),
    module: { screens: { card: { mount() {} } }, start: (a) => void (box.app = a) },
  });
  const tab = (name: string, show: (p: Record<string, string>) => boolean): AppPart => ({
    manifest: man(name, { [`${name}.tab`]: 1 }, { "card.tab@host-card": 1 }),
    module: { screens: { [`${name}.tab`]: { place: "card.tab", label: name, show, mount: (el) => void el.append(`вкладка ${name}`) } } },
  });

  it("5121 · владелец места видит вставки через app.placed; show решает видимость; вставку открывает app.open в своём элементе", async () => {
    const box: { app?: App } = {};
    await boot({ parts: [owner(box), tab("hello", (p) => p.callsign === "site@laptop"), tab("bye", () => false)] });
    const placed = box.app!.placed("card.tab");
    expect(placed.map((t) => [t.screen, t.label, t.show({ callsign: "site@laptop" })])).toEqual([
      ["hello.tab", "hello", true],
      ["bye.tab", "bye", false],
    ]);
    expect(placed[0].show({ callsign: "x@pc" })).toBe(false);
    const el = document.createElement("div");
    expect(box.app!.open("hello.tab", { callsign: "site@laptop" }, el)).toBeDefined();
    expect(el.textContent).toBe("вкладка hello");
  });

  it("5122 · show бросил — выключен модуль вставки, а не владелец места; место не из provides — ошибка модуля владельца", async () => {
    const box: { app?: App } = {};
    const { run } = await boot({
      parts: [
        owner(box),
        tab("boom", () => {
          throw new Error("сломалось");
        }),
      ],
    });
    expect(box.app!.placed("card.tab")[0].show({})).toBe(false);
    expect(Object.keys(run.failed)).toEqual(["boom"]);
    expect(box.app!.placed("card.tab")).toEqual([]);
    expect(box.app!.placed("chat.tab")).toEqual([]);
    expect(run.failed["host-card"]).toContain("места chat.tab нет в provides");
  });

  it("5123 · экран в месте, которого нет в uses, — приложение не стартует; полоса сверху — место top ядра", async () => {
    const stray: AppPart = { manifest: man("stray", { "stray.tab": 1 }, {}), module: { screens: { "stray.tab": { place: "card.tab", mount() {} } } } };
    expect(appGate([stray])).toContain("модуль stray: экран stray.tab — места card.tab нет в uses");
    const bar: AppPart = { manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: { screens: { bar: { place: "top", mount: (el) => void el.append("полоса") } } } };
    expect(appGate([bar])).toEqual([]);
    await boot({ parts: [sample().part, bar] });
    expect(root.textContent).toContain("полоса");
  });
});

