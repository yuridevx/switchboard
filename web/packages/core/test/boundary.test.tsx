// Леса границы «основа страницы», ядро: настоящее ядро и настоящий клиент флота на поддельном relay стенда.
// Вход — контракт web-core и стенд, исход — кадры, адрес, хранилище и экран. Номер — эталон-источник; без номера — чьё: код.
import { IDBFactory } from "fake-indexeddb";
import { createElement, memo, useEffect, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "@switchboard/web-ui";
import { appGate, idbStore, memoryStore, startApp, startBuild, type App, type AppModule, type AppPart, type BuildList, type ConnState, type Manifest, type Params, type Roster, type SlotProps } from "../contract.ts";
import { personal, type Scope } from "../../ui/contract.ts";
import { boot as bootShell } from "../../../shell.ts";
import { defined, stand } from "../stand/app.ts";
import { FakeRelay, flush, homeRoster, INVITE, KEY, oneMachine } from "../stand/relay.ts";

describe("гейт, ключ и маршрут", () => {

  const man = (name: string, provides: Record<string, number>, uses: Record<string, number>): Manifest => ({
    name,
    type: "web",
    version: "1.0.0",
    provides,
    uses: { "app@web-core": 2, ...uses },
  });

  /** Модуль-образец: экран list (раздел), кадр question, запрос answer к Host, push.key к Worker push. */
  function sample(log: string[] = []) {
    let app!: App;
    const mod: AppModule = {
      frames: {
        question: (f) => {
          if (f.boom) throw new TypeError("boom");
          log.push(`question ${f.from}`);
          app.changed();
        },
      },
      on: { roster: (r) => log.push(`roster ${r.sessions.length}`), link: (s, m) => log.push(m ? `link ${s} @${m}` : `link ${s}`), show: () => void log.push("show sample") },
      screens: {
        list: {
          nav: "Сессии",
          mark: "need",
          label: "Список",
          view() {
            useEffect(() => () => void log.push("list closed"), []);
            return "список";
          },
          head: () => ({ title: "Флот", sub: `${app.roster()?.machines.length} машины` }),
        },
        item: {
          view: ({ params: p }) => `item ${p.callsign}`,
          head: (p) => ({ title: p.callsign, mono: true }),
        },
      },
      marks: { need: () => 1 },
      store: ["drafts"],
      start() {
        log.push("start sample");
      },
      async stop() {
        log.push("stop sample");
        await app.store("drafts").set({ x: "черновик" });
      },
    };
    const part: AppPart = {
      manifest: man("sample", { list: 1, item: 1, need: 1 }, {
        "roster@relay": 1,
        "question@host-questions": 1,
        "answer@host-questions": 1,
        "push.key@push": 1,
      }),
      module: (a) => {
        app = a;
        return mod;
      },
    };
    return { part, get app() {
      return app;
    } };
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

  async function boot(o: { parts?: AppPart[]; store?: ReturnType<typeof memoryStore>; relay?: FakeRelay; ios?: boolean; standalone?: boolean; pauseMs?: number } = {}) {
    const relay = o.relay ?? new FakeRelay(oneMachine());
    const store = o.store ?? memoryStore({ key: KEY });
    const s = sample();
    const run = startApp({
      root,
      workers: FakeRelay.WORKERS,
      fetch: relay.fetch,
      parts: o.parts ?? [s.part],
      store,
      WebSocket: relay.WebSocket,
      platform: { ios: !!o.ios, standalone: !!o.standalone },
      pauseMs: o.pauseMs ?? 5,
    });
    await run.ready;
    await flush();
    return { run, relay, store, s };
  }

  describe("гейт набора", () => {
    it("кадр с двумя принимающими модулями — приложение не стартует, связи нет", async () => {
      const a = sample().part;
      const dupe: AppPart = { manifest: man("dupe", {}, { "question@host-questions": 1 }), module: () => ({ frames: { question: () => {} } }) };
      expect(appGate(defined([a, dupe]))).toContain("имя question: два владельца — sample и dupe");
      const { run, relay } = await boot({ parts: [a, dupe] });
      expect(run.stopped).toBe("gate");
      expect(root.textContent).toContain("Приложение не стартует");
      expect(root.textContent).toContain("question: два владельца");
      expect(relay.socks).toHaveLength(0);
    });

    it("экран не из provides, кадр не из uses, uses к модулю выпуска другой версии", () => {
      const bad: AppPart = {
        manifest: man("bad", {}, { "list@sample": 2 }),
        module: () => ({ screens: { x: { view: () => null } }, frames: { answered: () => {} } }),
      };
      expect(appGate(defined([sample().part, bad]))).toEqual([
        "модуль bad: экрана x нет в provides",
        "модуль bad: кадр answered нет в uses",
        "модуль bad: uses list@sample v2 — у владельца v1",
      ]);
      // метка экрана не из marks, on.roster без roster@relay, раздел хранилища у двух модулей
      const bad2: AppPart = {
        manifest: man("bad2", { y: 1 }, {}),
        module: () => ({ screens: { y: { mark: "cnt", view: () => null } }, on: { roster: () => {} }, store: ["drafts"] }),
      };
      const errs = appGate(defined([sample().part, bad2]));
      expect(errs).toContain("модуль bad2: экран y — метки cnt нет в marks");
      expect(errs).toContain("модуль bad2: on.roster без roster@relay в uses");
      expect(errs.some((e) => e.includes("store.drafts") && e.includes("два владельца"))).toBe(true);
    });
  });

  describe("ключ и связь", () => {
    it("5101 · #invite → POST gate.redeem; пропуск в хранилище; адрес очищен; hello с ним; roster — экран раздела", async () => {
      history.replaceState(null, "", "/#invite=" + INVITE);
      const store = memoryStore();
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = (f) => (f.invite === INVITE ? { ok: true, result: { key: KEY } } : { ok: false, error: "bad_invite" });
      await boot({ store, relay });
      expect(relay.sent("gate.redeem").map((f) => f.invite)).toEqual([INVITE]);
      expect(store.data.key).toBe(KEY);
      expect(location.hash).toBe("");
      expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
      expect(relay.socks.every((s) => !s.url.includes("k2a9"))).toBe(true);
      expect(root.querySelector(".sb-bt b")!.textContent).toBe("Флот");
      expect(root.querySelector(".sb-pill")!.textContent).toBe("на связи");
      expect(root.textContent).toContain("список");
      expect(root.textContent).toContain("Вы во флоте: laptop на связи, 2 сессии.");
    });

    it("5102 · iPhone вне экрана «Домой»: экран установки, приглашение не погашено и ждёт в адресе, связи нет", async () => {
      history.replaceState(null, "", "/#invite=" + INVITE);
      const store = memoryStore();
      const { run, relay } = await boot({ store, ios: true });
      expect(relay.sent("gate.redeem")).toEqual([]);
      expect(run.stopped).toBe("install");
      expect(root.textContent).toContain("Добавьте Switchboard на экран «Домой»");
      expect([...root.querySelectorAll(".sb-ol li")].map((li) => li.textContent)).toEqual(["Нажмите «Поделиться» внизу", "«На экран „Домой“»", "Откройте Switchboard с экрана «Домой»"]);
      expect(location.hash).toBe("#invite=" + INVITE);
      expect(store.data.key).toBeUndefined();
      expect(relay.socks).toHaveLength(0);
    });

    it("нет пропуска — экран «Нужен пропуск флота», связи нет", async () => {
      const { run, relay } = await boot({ store: memoryStore() });
      expect(run.stopped).toBe("no_key");
      expect(relay.socks).toHaveLength(0);
      expect(root.textContent).toContain("Нужен пропуск флота");
      expect(root.textContent).toContain("keys.invite client phone <почта>");
    });

    it("5197 · iPhone, повторный запуск с экрана «Домой»: в адресе то же приглашение, пропуск из него уже в хранилище — gate не спрашивается, hello с пропуском, адрес очищен", async () => {
      // источник: живой прогон прода 3 нояб. — второй запуск иконки с #invite= давал «Приглашение не принято»
      history.replaceState(null, "", "/#invite=" + INVITE);
      const had = `client.phone.${INVITE.split(".")[0]}.Vt5sig`;
      const relay = new FakeRelay(oneMachine());
      const { run } = await boot({ store: memoryStore({ key: had }), relay, ios: true, standalone: true });
      expect(relay.sent("gate.redeem")).toEqual([]);
      expect(relay.hellos).toEqual([{ type: "hello", key: had, proto: 1 }]);
      expect(location.hash).toBe("");
      expect(run.stopped).toBeNull();
    });

    it("5198 · «Стереть данные приложения» на экранах отказа: хранилище пусто, адрес без приглашения, перезагрузка", async () => {
      // источник: слово пользователя 3 нояб. — «кнопки зачистки на страницы ошибки на телефоне, чтоб удалить сохранённый профиль»
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
      history.replaceState(null, "", "/#invite=" + INVITE);
      const store = memoryStore({ pushes: [1] });
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = () => ({ ok: false, error: "bad_invite" });
      await boot({ store, relay });
      expect(root.textContent).toContain("Приглашение не принято");
      root.querySelector<HTMLButtonElement>("[data-act=wipe]")!.click();
      await flush();
      expect(store.data).toEqual({});
      expect(location.hash).toBe("");
      expect(reload).toHaveBeenCalledTimes(1);

      // и на «Пропуск отозван»
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById("app")!;
      const s2 = memoryStore({ key: KEY });
      const r2 = new FakeRelay(oneMachine());
      r2.refuse = ["revoked"];
      await boot({ store: s2, relay: r2 });
      await flush(20);
      root.querySelector<HTMLButtonElement>("[data-act=wipe]")!.click();
      await flush();
      expect(s2.data).toEqual({});
      expect(reload).toHaveBeenCalledTimes(2);
    });

    it("gate_unavailable и обрыв — полоса «Нет связи», снова hello с паузой вдвое; принятый hello сбрасывает паузу", async () => {
      const warn = vi.mocked(console.warn);
      const pauses = () => warn.mock.calls.map((c) => String(c[0])).filter((x) => x.includes("оборвалась")).map((x) => /снова через (\d+) с/.exec(x)![1]);
      const relay = new FakeRelay(oneMachine());
      relay.refuse = ["gate_unavailable", "gate_unavailable"];
      const { run } = await boot({ relay, pauseMs: 1000 });
      expect(root.querySelector(".sb-off")!.hasAttribute("hidden")).toBe(false);
      expect(root.querySelector(".sb-off")!.textContent).toMatch(/^Нет связи с relay · снова через 1 сСейчас$/);
      expect(run.stopped).toBeNull();
      await new Promise((r) => setTimeout(r, 3300));
      await flush();
      expect(run.stopped).toBeNull();
      expect(relay.hellos).toHaveLength(3);
      expect(pauses()).toEqual(["1", "2"]);
      expect(root.textContent).toContain("список");
      expect(root.querySelector(".sb-off")!.hasAttribute("hidden")).toBe(true);
      // обрыв после принятого hello — пауза снова первая
      relay.drop();
      await flush();
      expect(pauses()).toEqual(["1", "2", "1"]);
      expect(root.querySelector(".sb-pill")!.textContent).toBe("нет связи");
    }, 10_000);

    it("обрыв: ждущий запрос — disconnected сразу; шапка «нет связи», «данные на ЧЧ:ММ»; после hello — link open", async () => {
      const log: string[] = [];
      const relay = new FakeRelay(homeRoster());
      const s = sample(log);
      await boot({ relay, parts: [s.part], pauseMs: 60 });
      const p = s.app.request("answer", { callsign: "profiles@laptop", question: "q1", answers: {} });
      await flush(1);
      expect(relay.sent("answer")[0]).toMatchObject({ type: "answer", v: 1, callsign: "profiles@laptop" });
      relay.drop();
      expect(await p).toEqual({ ok: false, error: "disconnected" });
      expect(await s.app.request("answer", { callsign: "profiles@laptop" })).toEqual({ ok: false, error: "disconnected" });
      expect(relay.sent("answer")).toHaveLength(1);
      await flush(1);
      expect(root.querySelector(".sb-pill")!.textContent).toBe("нет связи");
      expect(root.querySelector(".sb-bt span")!.textContent).toMatch(/^данные на \d\d:\d\d$/);
      await new Promise((r) => setTimeout(r, 120));
      await flush();
      expect(log.filter((x) => x.startsWith("link") && !x.includes("@"))).toEqual(["link open", "link closed", "link connecting", "link open"]);
    });
  });

  describe("маршрут и запросы", () => {
    it("кадр — модулю по type; ошибка модуля выключает его, экран показывает причину, roster идёт дальше", async () => {
      const log: string[] = [];
      const s = sample(log);
      const other: AppPart = { manifest: man("other", {}, { "roster@relay": 1 }), module: () => ({ on: { roster: () => log.push("other roster") } }) };
      const { relay, run } = await boot({ parts: [s.part, other] });
      relay.push({ type: "question", from: "profiles@laptop" });
      expect(log).toContain("question profiles@laptop");
      relay.push({ type: "question", from: "x@pc", boom: true });
      expect(run.failed.sample).toBe("Модуль sample упал на кадре question: TypeError: boom");
      await flush();
      expect(root.textContent).toContain("Список выключен");
      relay.push({ type: "question", from: "y@pc" });
      relay.setRoster(homeRoster());
      expect(log.filter((x) => x === "other roster")).toHaveLength(2);
      expect(log).not.toContain("question y@pc");
    });

    it("Worker-модулю — to: .push и v из uses; имя и версию проверяет получатель", async () => {
      const relay = new FakeRelay(homeRoster());
      relay.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl6" } });
      const { s } = await boot({ relay });
      expect(await s.app.request("push.key")).toEqual({ ok: true, result: { key: "BEl6" } });
      expect(relay.sent("push.key")[0]).toMatchObject({ type: "push.key", v: 1, to: ".push" });
    });

    it("E1 · страница: app.read молчит — timeout на 10 с; app.request в это время ждёт", async () => {
      // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»
      const relay = new FakeRelay(homeRoster());
      relay.handlers["answer"] = () => undefined as never;
      const { s } = await boot({ relay });
      vi.useFakeTimers();
      try {
        let read = "", act = "";
        void s.app.read("answer", { callsign: "profiles@laptop" }).then((r) => (read = r.ok ? "ok" : r.error));
        void s.app.request("answer", { callsign: "profiles@laptop" }).then((r) => (act = r.ok ? "ok" : r.error));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(read).toBe("");
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toBe("timeout");
        expect(act).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("E21 · страница: отказ с причиной доходит до модуля полем why, и у request, и у read", async () => {
      // факт: так отвечают службы флота; нужно экрану, чтобы показать имя слота в отказе
      const relay = new FakeRelay(homeRoster());
      relay.handlers["answer"] = () => ({ ok: false, error: "no_reserve", why: "слот main: нет запаса" });
      const { s } = await boot({ relay });
      const want = { ok: false, error: "no_reserve", why: "слот main: нет запаса" };
      expect(await s.app.request("answer", { callsign: "profiles@laptop" })).toEqual(want);
      expect(await s.app.read("answer", { callsign: "profiles@laptop" })).toEqual(want);
    });

    it("запрос к имени не из uses — ошибка модуля", async () => {
      const { s, run } = await boot();
      expect(await s.app.request("session.stop", { callsign: "site@laptop" })).toEqual({ ok: false, error: "module_error" });
      expect(run.failed.sample).toContain("session.stop нет в uses");
    });

    it("запрос к приложению — reply unknown_request отправителю", async () => {
      const { relay } = await boot();
      relay.push({ type: "who", id: "r-1", from: "site@laptop" });
      expect(relay.got.at(-1)).toMatchObject({ type: "reply", id: "r-1", ok: false, error: "unknown_request", to: "site@laptop" });
    });

    it("open — экран на весь экран с параметрами в адресе; назад — на раздел", async () => {
      const log: string[] = [];
      const s = sample(log);
      await boot({ parts: [s.part] });
      s.app.open("item", { callsign: "site@laptop" });
      await flush();
      expect(location.hash).toBe("#item?callsign=site%40laptop");
      expect(root.textContent).toContain("item site@laptop");
      expect(log).toContain("list closed");
      expect(root.querySelector(".sb-back")).not.toBeNull();
      s.app.back();
      await flush();
      expect(root.textContent).toContain("список");
    });
  });

  describe("уход с экрана", () => {
    it("возвращение на экран — on.show модулей, start один раз, hello с тем же ключом", async () => {
      const log: string[] = [];
      const s = sample(log);
      const { run, relay } = await boot({ parts: [s.part] });
      await run.hide();
      expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
      await run.show();
      await flush();
      expect(log.filter((x) => x === "start sample")).toHaveLength(1);
      expect(log.filter((x) => x === "show sample")).toHaveLength(1);
      expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }, { type: "hello", key: KEY, proto: 1 }]);
      expect(log.slice(log.lastIndexOf("show sample"))).toContain("link open");
    });
  });

  describe("хранилище IndexedDB", () => {
    it("раздел пишется, читается и обновляется в одной транзакции", async () => {
      const st = idbStore("t1", new IDBFactory());
      expect(await st.get("key")).toBeUndefined();
      await st.set("key", KEY);
      expect(await st.get("key")).toBe(KEY);
      await st.update<number[]>("pushes", (a = []) => [...a, 1]);
      expect(await st.update<number[]>("pushes", (a = []) => [...a, 2])).toEqual([1, 2]);
      await st.clear();
      expect([await st.get("key"), await st.get("pushes")]).toEqual([undefined, undefined]);
    });
  });
});

describe("флоу ядра", () => {

  const man = (name: string, provides: Record<string, number>, uses: Record<string, number>): Manifest => ({
    name,
    type: "web",
    version: "1.0.0",
    provides,
    uses: { "app@web-core": 2, ...uses },
  });


  /** Модуль-образец: раздел list с меткой need по roster, экран item, кадр question, запросы answer и push.key. */
  function sample(log: string[] = [], over: Partial<AppModule> = {}) {
    const box: { app: App } = { app: null as unknown as App };
    const mod: AppModule = {
      frames: { question: (f) => void log.push(`question ${f.from}`) },
      on: { roster: (r) => log.push(`roster ${r.sessions.length}`), link: (s, m) => log.push(m ? `link ${s} @${m}` : `link ${s}`) },
      screens: {
        list: {
          nav: "Сессии",
          mark: "need",
          label: "Список",
          view() {
            const n = box.app.use(() => box.app.roster()?.sessions.length);
            useEffect(() => () => void log.push("list closed"), []);
            return `список ${n}`;
          },
        },
        item: {
          label: "Карточка",
          view({ params: p }) {
            useEffect(() => () => void log.push(`item closed ${p.callsign}`), [p.callsign]);
            return `item ${p.callsign}`;
          },
        },
      },
      marks: { need: () => (box.app.roster()?.sessions ?? []).filter((s) => s.state === "waiting").length },
      store: ["drafts"],
      start() {
        log.push("start sample");
      },
      stop() {
        log.push("stop sample");
      },
      ...over,
    };
    const part: AppPart = {
      manifest: man("sample", { list: 1, item: 1, need: 1 }, { "roster@relay": 1, "question@host-questions": 1, "answer@host-questions": 1, "push.key@push": 1 }),
      module: (a) => {
        box.app = a;
        return mod;
      },
    };
    return { part, box, mod };
  }

  /** Второй модуль: свой экран side; uses — экран item и метка need модуля sample. */
  function other(log: string[] = [], over: Partial<AppModule> = {}) {
    const box: { app: App } = { app: null as unknown as App };
    const part: AppPart = {
      manifest: man("other", { side: 1 }, { "item@sample": 1, "need@sample": 1 }),
      module: (a) => ({
        screens: { side: { label: "Сбоку", view: () => "сбоку" } },
        start() {
          box.app = a;
          log.push("start other");
        },
        stop() {
          log.push("stop other");
        },
        ...over,
      }),
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

  describe("функция модуля", () => {
    it("7219 · функция модуля бросила: выключен только он, на его экране — причина; остальные работают", async () => {
      // источник: контракт ядра — бросил, значит выключен; его экраны показывают причину
      const log: string[] = [];
      const bad: AppPart = {
        manifest: man("bad", { broken: 1 }, {}),
        module: () => {
          throw new Error("сломалось при создании");
        },
      };
      history.replaceState(null, "", "/#broken");
      const { run } = await boot({ parts: [sample(log).part, bad] });
      expect(run.stopped).toBeNull();
      expect(run.failed.bad).toContain("сломалось при создании");
      expect(root.textContent).toContain("сломалось при создании");
      expect(log).toContain("start sample");
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
      history.replaceState(null, "", "/#side");
      await boot({ parts: [s.part, o.part] });
      expect(root.querySelector('[data-screen="side"]')!.textContent).toBe("item a@pc");
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
      const { relay } = await boot({ parts: [s.part] });
      relay.push({ type: "question", from: "a@pc" });
      await flush();
      history.pushState(null, "", "/#item?callsign=a%40pc");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await flush();
      expect(view).not.toHaveBeenCalled();
      expect(root.textContent).toContain("Карточка выключен");
      expect(root.textContent).toContain("Перезапустить приложение");
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

    // источник: слово пользователя 3 нояб. — «мигание, когда перезаходишь на уже открытую вкладку… стабильно, если свернуть и
    // развернуть окно хрома»: после возвращения экран не видит флот, собранный не до конца
    it("4033 · возвращение на экран: roster и «на связи» — когда ответили все машины, без промежуточного неполного", async () => {
      const log: string[] = [];
      const { run, relay } = await boot({ parts: [sample(log).part], relay: new FakeRelay(homeRoster()) });
      await flush(10);
      expect(root.textContent).toContain("список 4");
      await run.hide();
      log.length = 0;
      const seen: string[] = [];
      const watch = new MutationObserver(() => seen.push(root.querySelector('[data-screen="list"]')?.textContent ?? ""));
      watch.observe(root, { subtree: true, childList: true, characterData: true });
      await run.show();
      await flush(10);
      watch.disconnect();
      expect(relay.open).toHaveLength(2);
      expect(log.filter((x) => x.startsWith("roster"))).toEqual(["roster 4"]);
      expect(log.filter((x) => x.startsWith("link"))).toEqual(["link open"]);
      expect(seen.filter((x) => x && x !== "список 4")).toEqual([]);
    });

    it("4034 · машина не ответила при возвращении — её соединение закрылось, остальные видны", async () => {
      const log: string[] = [];
      const { run, relay } = await boot({ parts: [sample(log).part], relay: new FakeRelay(homeRoster()) });
      await flush(10);
      await run.hide();
      log.length = 0;
      relay.refuse = ["", "gate_unavailable"];
      await run.show();
      await flush(10);
      expect(log.filter((x) => x.startsWith("link") && !x.includes("@"))).toEqual(["link open"]);
      // pc закрылся — флот собран: видна laptop; pc вернулся своим переподключением — снова все
      expect(log.filter((x) => x.startsWith("roster"))[0]).toBe("roster 2");
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
        start() {
          void s.box.app.store("pushes").set([1]);
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
    const owner = (box: { app?: App }, slot?: SlotProps): AppPart => ({
      manifest: man("host-card", { card: 1, "card.tab": 1 }, {}),
      module: (a) => ({ screens: { card: { view: () => (slot ? createElement(a.Slot, slot) : null) } }, start: () => void (box.app = a) }),
    });
    const tab = (name: string, show: (p: Record<string, string>) => boolean): AppPart => ({
      manifest: man(name, { [`${name}.tab`]: 1 }, { "card.tab@host-card": 1 }),
      module: () => ({ screens: { [`${name}.tab`]: { place: "card.tab", label: name, show, view: () => `вкладка ${name}` } } }),
    });

    it("5121 · владелец места видит вставки через app.placed; show решает видимость; вставку рисует app.Slot", async () => {
      const box: { app?: App } = {};
      history.replaceState(null, "", "/#card");
      await boot({ parts: [owner(box, { screen: "hello.tab", params: { callsign: "site@laptop" } }), tab("hello", (p) => p.callsign === "site@laptop"), tab("bye", () => false)] });
      expect(box.app!.placed("card.tab", { callsign: "site@laptop" })).toEqual([{ name: "hello.tab", label: "hello" }]);
      expect(box.app!.placed("card.tab", { callsign: "x@pc" })).toEqual([]);
      expect(root.querySelector('[data-screen="card"]')!.textContent).toBe("вкладка hello");
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
      expect(box.app!.placed("card.tab")).toEqual([]);
      expect(Object.keys(run.failed)).toEqual(["boom"]);
      expect(box.app!.placed("card.tab")).toEqual([]);
      expect(box.app!.placed("chat.tab")).toEqual([]);
      expect(run.failed["host-card"]).toContain("места chat.tab нет в provides");
    });

    it("5123 · экран в месте, которого нет в uses, — приложение не стартует; полоса сверху — место top ядра", async () => {
      const stray: AppPart = { manifest: man("stray", { "stray.tab": 1 }, {}), module: () => ({ screens: { "stray.tab": { place: "card.tab", view: () => null } } }) };
      expect(appGate(defined([stray]))).toContain("модуль stray: экран stray.tab — места card.tab нет в uses");
      const bar: AppPart = { manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: () => ({ screens: { bar: { place: "top", view: () => "полоса" } } }) };
      expect(appGate(defined([bar]))).toEqual([]);
      await boot({ parts: [sample().part, bar] });
      expect(root.textContent).toContain("полоса");
    });
  });
});

describe("экран и выборка", () => {

  const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, ...uses } });

  type Seen = { screen: string; params: Params };

  /** Модуль с экранами a (раздел), b, командой cmd; записывает on.current. */
  function part(over: { current?(c: Seen): void; roster?(): void; run?(): void } = {}) {
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
        commands: { cmd: { run: () => over.run?.() } },
        start: () => void (box.app = a),
      }),
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
      m.box.app.run("cmd");
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
      const base = m.p.module;
      m.p.module = (a) => {
        const d = base(a);
        d.screens!.bar = { place: "top", path: "bar", view: () => null };
        return d;
      };
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
      const neighbour: AppPart = { manifest: man("n", { n: 1 }), module: () => ({ on: { current: (c) => void other.push(c) }, screens: { n: { label: "Н", view: () => "н" } } }) };
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
      const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: (a) => ({ screens: { main: { nav: "Г", view: Main } }, start: () => void (starts.main = a) }) };
      const side: AppPart = { manifest: man("side", { side: 1 }), module: (a) => ({ screens: { side: { view: Side } }, start: () => void (starts.side = a) }) };
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
      const main: AppPart = { manifest: man("main", { main: 1 }, { "bad@bad": 1 }), module: () => ({ screens: { main: { nav: "Г", view: Main } } }) };
      const bad: AppPart = { manifest: man("bad", { bad: 1 }), module: (a) => ({ screens: { bad: { label: "Бок", view: Bad } }, start: () => void (box = a) }) };
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
      const p: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", label: "А", view: Bad } } }) };
      const fake = new Proxy(real, { get: (o, k) => (k === "reload" ? reload : Reflect.get(o, k)) });
      const win = new Proxy(window, { get: (o, k) => { if (k === "location") return fake; const v = Reflect.get(o, k); return typeof v === "function" ? v.bind(o) : v; } });
      const t = await stand([p], { options: { window: win as Window } });
      expect(t.run.failed.m).toContain("сломан экран");
      await t.click(t.button("Перезапустить приложение"));
      expect(reload).toHaveBeenCalledOnce();
    });
  });
});

describe("вид", () => {

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
  });
  afterEach(() => vi.restoreAllMocks());

  const root = () => document.getElementById("app")!;
  const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, "roster@relay": 1, ...uses } });

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
    const mod: AppModule = { screens: { list: { nav: "Список", label: "Список", view: List } } };
    return {
      manifest: man("list", { list: 1 }),
      module: (a) => {
        app = a;
        return mod;
      },
    } satisfies AppPart;
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
      await boot([{ manifest: man("v", { v: 1 }), module: (a) => ({ screens: { v: { nav: "В", view: V } }, start: () => void (app = a) }) }]);
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
      const mod: AppModule = { screens: { v: { nav: "В", view: V } }, marks: { unread: () => ({ count: 3 }) } };
      await boot([
        {
          manifest: man("v", { v: 1, unread: 1 }),
          module: (a) => {
            app = a;
            return mod;
          },
        },
      ]);
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
      const broken: AppPart = { manifest: man("broken", { broken: 1 }), module: (a) => ({ screens: { broken: { nav: "Плохой", label: "Плохой", view: Bad } }, start: () => void (app = a) }) };
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
      const caller: AppPart = { manifest: man("caller", { caller: 1 }), module: (a) => ({ screens: { caller: { nav: "Вызов", label: "Вызов", view: V } }, start: () => void (app = a) }) };
      const side: AppPart = { manifest: man("side", { side: 1 }), module: () => ({ screens: { side: { label: "Бок", view: () => "бок" } } }) };
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
      const part: AppPart = { manifest: man("c", { card: 1 }), module: (a) => ({ screens: { card: { nav: "К", view: Card } }, start: () => void (app = a) }) };
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
        module: (a) => ({ screens: { outer: { nav: "Вне", view: () => <app.Slot screen="inner" /> } }, css: ".t{color:red}", start: () => void (app = a) }),
      };
      const inner: AppPart = { manifest: man("inner-m", { inner: 1 }), module: () => ({ screens: { inner: { view: () => <b className="t">внутри</b> } } }) };
      await boot([outer, inner]);
      expect(root().querySelector("style")!.textContent).toContain('@scope ([data-module="outer"]) to ([data-module]) {\n.t{color:red}\n}');
      expect(root().querySelector('[data-module="outer"] [data-module="inner-m"] .t')!.textContent).toBe("внутри");
    });

    it("браузер без @scope — экран «Браузер устарел», модули не стартуют", async () => {
      // источник: дизайн: «система ловит»; модуль без области стилей не показываем
      const relay = new FakeRelay(homeRoster());
      const started = vi.fn();
      const run = startApp({ root: root(), workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [{ manifest: man("m", {}), module: () => ({ start: started }) }], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false, scope: false } });
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
        load: (name) => (name === "slow" ? new Promise(() => {}) : Promise.resolve({ default: () => ok, manifest: man("ok", { ok: 1 }) })),
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
      const part: AppPart = { manifest: man("m", { m: 1 }), module: () => ({ screens: { m: broken } }) };
      const run = startApp({ root: root(), workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [part], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
      await run.ready;
      await flush();
      expect(root().textContent).toBe("Приложение упало: сломана группа раздела");
    });

    it("6805 · не загрузилась сборка — страница показывает причину", async () => {
      // чьё: код — оболочка; основание загружается раньше модулей, работать нечему
      vi.stubGlobal("fetch", () => Promise.reject(new Error("нет сети")));
      await expect(bootShell({})).rejects.toThrow("нет сети");
      expect(root().textContent).toBe("Сборка не загрузилась: нет сети");
      vi.unstubAllGlobals();
    });
  });
});

describe("разделы", () => {

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
  });
  afterEach(() => vi.restoreAllMocks());

  const man = (name: string, provides: Record<string, number>): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2 } });

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

  async function run(wide: boolean) {
    const relay = new FakeRelay(homeRoster());
    const r = startApp({
      root: document.getElementById("app")!,
      workers: FakeRelay.WORKERS,
      fetch: relay.fetch,
      parts: parts(),
      wide,
      sections: ["work", "machines", "access"],
      store: memoryStore({ key: KEY }),
      WebSocket: relay.WebSocket,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
    });
    await r.ready;
    await flush();
    return r;
  }
  const texts = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((b) => b.textContent);

  describe("разделы страницы", () => {
    it("5170 · широкий вид: раздел и группа «Флот» с подписью; подпунктов под разделом нет, кнопки шапки нет", async () => {
      await run(true);
      expect(texts(".sb-navcol .sb-nv")).toEqual(["Работа", "Машины", "Аккаунты"]);
      expect(texts(".sb-navcol .sb-grp")).toEqual(["Флот"]);
      // машин и имени устройства в колонке больше нет
      expect(document.querySelector(".sb-nm, .sb-me, .sb-ncap")).toBeNull();
      expect(document.querySelector("[data-find], [data-new]")).toBeNull();
      [...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")][1].click();
      await flush();
      expect(location.hash).toBe("#machines");
      expect(document.querySelector('.sb-navcol .sb-nv[aria-current="page"]')!.textContent).toBe("Машины");
    });

    it("5173 · узкий вид: в шапке раздела — поиск и кнопка раздела; поиск открывает тот же Ctrl K; кнопка зовёт действие раздела", async () => {
      added = 0;
      await run(false);
      document.querySelector<HTMLElement>("[data-find]")!.click();
      await flush();
      expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(false);
      document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
      document.querySelector<HTMLElement>("[data-new]")!.click();
      expect(added).toBe(1);
    });

    it("5171 · Ctrl K: разделы и строки find экранов; Enter открывает первую; Esc закрывает", async () => {
      await run(true);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
      await flush();
      const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
      expect(input).not.toBeNull();
      // поиск открылся — ввод сразу в поле
      expect(document.activeElement).toBe(input);
      expect(texts(".sb-palit .l")).toEqual(["Работа", "refactor@win", "api@wsl", "Машины", "Аккаунты"]);
      input.value = "api";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(texts(".sb-palit .l")).toEqual(["api@wsl"]);
      document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flush();
      expect(location.hash).toBe("#work?callsign=api%40wsl");
      expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(true);
      document.querySelector<HTMLElement>(".sb-goto")!.click();
      await flush();
      document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
      expect(document.querySelector<HTMLElement>(".sb-palw")!.hidden).toBe(true);
    });

    it("5175 · narrowGroup: в широком виде раздел отдельно, в узком — в группе («Инциденты» во «Флоте» телефона)", async () => {
      // источник: прототип «Пульт и телефон» (подписан 2 нояб.): телефон — Вам, Работа, Флот (аккаунты, машины, инциденты, настройки)
      const relay = new FakeRelay(homeRoster());
      const mods = (): AppPart[] => [
        ...parts(),
        { manifest: man("i", { incidents: 1 }), module: () => ({ screens: { incidents: { nav: "Инциденты", narrowGroup: "Флот", view: () => "инциденты" } } }) },
      ];
      const start = (wide: boolean) =>
        startApp({ root: document.getElementById("app")!, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: mods(), wide, sections: ["work", "incidents", "machines", "access"], store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
      await start(true).ready;
      await flush();
      expect(texts(".sb-navcol .sb-nv:not(.sub)")).toEqual(["Работа", "Инциденты", "Машины", "Аккаунты"]);
      document.body.innerHTML = '<div id="app"></div>';
      await start(false).ready;
      await flush();
      expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
      location.hash = "#incidents";
      await flush();
      expect(texts(".sb-navrow .sb-nv")).toEqual(["Инциденты", "Машины", "Аккаунты"]);
    });

    it("5174 · beside списком: карточка открыта от «Вам» — слева «Вам», от «Работы» — «Работа»; поиск ведёт и на экран из uses", async () => {
      const relay = new FakeRelay(homeRoster());
      const lists: AppModule = {
        screens: {
          inbox: { nav: "Вам", find: () => [{ label: "site@laptop", screen: "card", params: { callsign: "site@laptop" } }], view: () => "вам" },
          board: { nav: "Работа", view: () => "работа" },
        },
      };
      const card: AppModule = { screens: { card: { view: ({ params: p }) => `карточка ${p.callsign}` } } };
      const r = startApp({
        root: document.getElementById("app")!,
        workers: FakeRelay.WORKERS,
        fetch: relay.fetch,
        parts: [
          { manifest: { ...man("l", { inbox: 1, board: 1 }), uses: { "app@web-core": 2, "card@c": 1 } }, module: () => lists },
          { manifest: man("c", { card: 1 }), module: () => card },
        ],
        wide: true,
        beside: { card: ["board", "inbox"] },
        store: memoryStore({ key: KEY }),
        WebSocket: relay.WebSocket,
        platform: { ios: false, standalone: false },
        pauseMs: 5,
      });
      await r.ready;
      await flush();
      location.hash = "#inbox";
      await flush();
      location.hash = "#card?callsign=site%40laptop";
      await flush();
      expect(document.querySelector(".sb-master")!.getAttribute("data-screen")).toBe("inbox");
      location.hash = "#board";
      await flush();
      location.hash = "#card?callsign=site%40laptop";
      await flush();
      expect(document.querySelector(".sb-master")!.getAttribute("data-screen")).toBe("board");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
      await flush();
      expect(texts(".sb-palit .l")).toContain("site@laptop");
    });

    it("5172 · узкий вид: вкладки внизу — разделы без группы и одна вкладка группы; открыт раздел группы — его соседи лентой над экраном", async () => {
      await run(false);
      expect(texts(".sb-tabs .sb-nv")).toEqual(["Работа", "Флот"]);
      expect(document.querySelector<HTMLElement>(".sb-navrow")!.hidden).toBe(true);
      document.querySelector<HTMLElement>('.sb-tabs [data-group="Флот"]')!.click();
      await flush();
      expect(location.hash).toBe("#machines");
      expect(texts(".sb-navrow .sb-nv")).toEqual(["Машины", "Аккаунты"]);
      expect(document.querySelector('.sb-tabs [data-group="Флот"]')!.getAttribute("aria-current")).toBe("page");
    });
  });
});

describe("края связи", () => {

  const man = (provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name: "m", type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, "roster@relay": 1, ...uses } });

  /** Модуль с разделом a и командой cmd; записывает on.link. */
  function sample() {
    const seen: Array<[ConnState, string | undefined]> = [];
    const run = vi.fn<(p: Params) => void>();
    const box: { app: App | null } = { app: null };
    const part: AppPart = {
      manifest: man({ a: 1, cmd: 1 }),
      module: (app) => {
        box.app = app;
        return {
          on: { link: (s, m) => void seen.push([s, m]), roster: () => {} },
          screens: { a: { nav: "А", label: "А", view: () => <div data-s="a">а</div> } },
          commands: { cmd: { run } },
        };
      },
    };
    return { part, seen, run, box };
  }

  const emptyFleet = () => homeRoster({ machines: [], sessions: [], clients: [] });
  afterEach(() => vi.useRealTimers());

  describe("флот без машин и gate", () => {
    it("7280 · keys.list пуст: связь открыта, roster пуст, страница доходит до экрана", async () => {
      // источник: отчёт архитектора, ошибка 1 — без машин до «Настроек» и приглашения машины не добраться
      const s = sample();
      const t = await stand([s.part], { relay: new FakeRelay(emptyFleet()) });
      await flush(10);
      expect(t.$('[data-s="a"]')).not.toBeNull();
      expect(s.box.app!.link()).toBe("open");
      expect(s.box.app!.roster()!.machines).toEqual([]);
      expect(s.seen).toEqual([["open", undefined]]);
    });

    it("7281 · gate недоступен при старте: полоса «Нет связи», gate ответил — полоса снята, экран виден", async () => {
      // источник: контракт web-core — «обрыв и gate_unavailable — полоса «Нет связи», переподключение с растущей паузой»
      const relay = new FakeRelay(homeRoster());
      let down = true;
      const fetchFleet = (async (url: string, init?: RequestInit) => {
        const f = JSON.parse(String(init?.body ?? "{}")) as { type?: string; id?: string };
        if (down && f.type === "keys.list") return Response.json({ type: "reply", id: f.id, ok: false, error: "gate_unavailable" });
        return relay.fetch(url, init);
      }) as typeof fetch;
      const s = sample();
      const t = await stand([s.part], { relay, pauseMs: 20, options: { fetch: fetchFleet } });
      await flush(10);
      expect(t.$(".sb-off")!.hidden).toBe(false);
      expect(t.$(".sb-off")!.textContent).toContain("Нет связи");
      expect(s.box.app!.link()).toBe("closed");
      down = false;
      await new Promise((r) => setTimeout(r, 60));
      await flush(10);
      expect(t.$(".sb-off")!.hidden).toBe(true);
      expect(t.$('[data-s="a"]')).not.toBeNull();
    });

    it("7282 · адрес команды #cmd — домашний экран, команда не выполнена; app.open команды не исполняет", async () => {
      // источник: отчёт архитектора, ошибка 7 — #pin?callsign=… вёл на команду, пустой экран
      const s = sample();
      const t = await stand([s.part], { url: "/#cmd?x=1" });
      await flush(10);
      expect(t.$('[data-s="a"]')).not.toBeNull();
      expect(s.box.app!.current()!.screen).toBe("a");
      expect(s.run).not.toHaveBeenCalled();
      s.box.app!.run("cmd", { x: "2" });
      expect(s.run).toHaveBeenCalledWith({ x: "2" });
    });
  });

  describe("машина вернулась или перезапустилась — сообщает только ядро", () => {
    const machineLinks = (s: ReturnType<typeof sample>) => s.seen.filter(([, m]) => m).map(([state, m]) => [state, m]);

    it("6821 · roster без смены since: сменились только сессии — on.link молчит", async () => {
      // источник: гейт архитектора — лишняя коммуникация
      const s = sample();
      const relay = new FakeRelay(homeRoster());
      await stand([s.part], { relay });
      await flush(10);
      relay.setRoster(homeRoster({ sessions: [] }));
      await flush(10);
      expect(machineLinks(s)).toEqual([]);
    });

    it("7283 · новый since — on.link open с машиной; пришла новая машина — тоже; первый roster — точка отсчёта", async () => {
      // источник: отчёт архитектора, логика 1 — одно место вместо четырёх
      const s = sample();
      const relay = new FakeRelay(homeRoster());
      await stand([s.part], { relay });
      await flush(10);
      expect(machineLinks(s)).toEqual([]);
      const r = homeRoster();
      relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 1 } : m)) });
      await flush(10);
      expect(machineLinks(s)).toEqual([["open", "pc"]]);
      const gone = homeRoster();
      relay.setRoster({ ...gone, machines: gone.machines.filter((m) => m.machine !== "pc") });
      await flush(10);
      relay.setRoster(gone);
      await flush(10);
      expect(machineLinks(s)).toEqual([["open", "pc"], ["open", "pc"]]);
    });
  });

});

describe("сборка", () => {

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
  });
  afterEach(() => vi.restoreAllMocks());

  const man = (name: string, provides: Record<string, number>): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2 } });
  const screenMod = (name: string, nav: string): AppModule => ({ screens: { [name]: { nav, label: nav, view: () => nav } } });

  describe("сборка страницы", () => {
    it("6594 · имя приложения из списка сборки — у модуля; настройка области приложения уходит с ним; область флота и человека — своими словами", async () => {
      const relay = new FakeRelay(homeRoster());
      let got: App | null = null;
      const build: BuildList = { app: "pult", version: "1.1.0+2", fleet: "test", modules: [{ name: "web-core", version: "1.1.0" }, { name: "list", version: "1.0.0" }], workers: FakeRelay.WORKERS };
      const mod: AppPart["module"] = (a) => {
        got = a;
        return screenMod("list", "Список");
      };
      const run = await startBuild({ root: document.getElementById("app")!, build, load: async () => ({ manifest: man("list", { list: 1 }), default: mod }), fetch: relay.fetch, store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket as never, platform: { ios: false, standalone: false }, pauseMs: 5 });
      await run.ready;
      expect(got!.application).toBe("pult");
      const scopeOf = async (scope?: Scope) => {
        const asked: Array<Record<string, unknown>> = [];
        const ask = async (_n: string, body?: Record<string, unknown>) => (asked.push(body ?? {}), { ok: true, result: { values: {} } }) as never;
        const p = personal({ application: got!.application, read: ask, request: ask, toast: () => {} }, "x", () => {}, scope);
        await p.onLink("open");
        return asked[0].scope;
      };
      expect(await scopeOf("app")).toBe("app:pult");
      expect(await scopeOf("global")).toBe("global");
      expect(await scopeOf()).toBeUndefined();
    });

    it("5134 · startBuild: модули по списку сборки (ядро — само), relay и Worker'ы — из build.json; модуль не загрузился — выключен только он", async () => {
      // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адреса relay и Worker'ов страница берёт из
      // списка сборки; модуль не загрузился — выключен только он, остальные работают
      const relay = new FakeRelay(homeRoster());
      const urls: string[] = [];
      const WS = relay.WebSocket;
      const build: BuildList = {
        app: "phone",
        version: "1.1.0+2",
        fleet: "test",
        modules: [
          { name: "web-core", version: "1.1.0" },
          { name: "list", version: "1.0.0" },
          { name: "broken", version: "2.0.0" },
        ],
        // адрес relay — в той же карте Worker'ов: объекты машин — wss того же адреса
        workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" },
      };
      const asked: string[] = [];
      const run = await startBuild({
        root: document.getElementById("app")!,
        build,
        load: async (name) => {
          asked.push(name);
          if (name === "broken") throw new Error("404 m/broken.js");
          return { manifest: man("list", { list: 1 }), default: () => screenMod("list", "Список") };
        },
        fetch: relay.fetch,
        store: memoryStore({ key: KEY }),
        WebSocket: class extends (WS as unknown as new (u: string) => object) {
          constructor(u: string) {
            urls.push(u);
            super(u);
          }
        } as never,
        platform: { ios: false, standalone: false },
        pauseMs: 5,
      });
      await run.ready;
      await flush();
      expect(asked).toEqual(["list", "broken"]);
      expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
      expect(Object.keys(run.failed)).toEqual(["broken"]);
      expect(run.failed.broken).toContain("импорт: 404 m/broken.js");
      expect(run.stopped).toBeNull();
      expect(document.querySelector(".sb-main")!.textContent).toContain("Список");
    });

    it("5135 · порядок разделов — у оболочки: sections первыми, остальные — следом по списку модулей; домашний — первый", async () => {
      // источник: дизайн «Открытый флот»: «beside и порядок разделов — у оболочки; разделы, которых в ней нет, встают следом»
      const parts: AppPart[] = [
        { manifest: man("a", { a: 1 }), module: () => screenMod("a", "А") },
        { manifest: man("b", { b: 1 }), module: () => screenMod("b", "Б") },
        { manifest: man("c", { c: 1 }), module: () => screenMod("c", "В") },
        { manifest: man("d", { d: 1 }), module: () => screenMod("d", "Г") },
      ];
      const relay = new FakeRelay(homeRoster());
      const run = startApp({
        root: document.getElementById("app")!,
        workers: FakeRelay.WORKERS,
        fetch: relay.fetch,
        parts,
        wide: true,
        sections: ["c", "a"],
        store: memoryStore({ key: KEY }),
        WebSocket: relay.WebSocket,
        platform: { ios: false, standalone: false },
        pauseMs: 5,
      });
      await run.ready;
      await flush();
      expect([...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")].map((b) => b.dataset.screen)).toEqual(["c", "a", "b", "d"]);
      expect(document.querySelector('.sb-navcol button[aria-current="page"]')!.getAttribute("data-screen")).toBe("c");
    });
  });
});

describe("чужое приглашение", () => {

  const OTHER = "client.phone.q7w1.Zzsig";
  const part = (): AppPart => ({
    manifest: { name: "web-x", type: "web", version: "1.0.0", provides: { list: 1 }, uses: { "app@web-core": 2 } },
    module: () => ({ screens: { list: { nav: "Список", view: () => null, head: () => ({ title: "Список" }) } } }),
  });

  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;

  async function open(key: string | undefined, answer: () => { ok: true; result: { key: string } } | { ok: false; error: string }) {
    const relay = new FakeRelay(oneMachine());
    relay.handlers["gate.redeem"] = answer;
    const store = memoryStore(key ? { key } : {});
    const t = await stand([part()], { relay, store, url: `/#invite=${INVITE}` });
    await flush();
    return { ...t, relay, store };
  }

  afterEach(() => vi.restoreAllMocks());

  describe("приглашение при имеющемся пропуске", () => {
    it("6760 · чужое приглашение: связи нет, gate не тронут, пропуск прежний, адрес чист, спрашиваем человека", async () => {
      const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
      expect(t.relay.sent("gate.redeem")).toEqual([]);
      expect(t.store.data.key).toBe(KEY);
      expect(t.relay.socks).toHaveLength(0);
      expect(location.hash).toBe("");
      expect(t.root.textContent).toContain("Заменить пропуск этого устройства?");
      expect(t.root.textContent).toContain(INVITE.split(".")[0]);
      expect(t.root.textContent).not.toContain(INVITE.split(".")[1]);
    });

    it("6761 · «Заменить пропуск»: gate.redeem, новый пропуск, перезагрузка", async () => {
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
      const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
      await t.click(button("Заменить пропуск"));
      await flush();
      expect(t.relay.sent("gate.redeem").map((f) => f.invite)).toEqual([INVITE]);
      expect(t.store.data.key).toBe(OTHER);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("6762 · «Оставить текущий»: приглашение не гасится, пропуск прежний, перезагрузка", async () => {
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
      const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
      await t.click(button("Оставить текущий"));
      expect(t.relay.sent("gate.redeem")).toEqual([]);
      expect(t.store.data.key).toBe(KEY);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("6763 · отказ gate при замене: причина словами, пропуск прежний, без перезагрузки", async () => {
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
      const t = await open(KEY, () => ({ ok: false, error: "bad_invite" }));
      await t.click(button("Заменить пропуск"));
      await flush();
      expect(t.root.querySelector('[role="alert"]')!.textContent).toBe("Приглашение не принято: bad_invite.");
      expect(t.store.data.key).toBe(KEY);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe("ответ выборки", () => {

  describe("выборка", () => {
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
      const part: AppPart = {
        manifest: { name: "m", type: "web", version: "1.0.0", provides: { a: 1 }, uses: {} },
        module: (x) => {
          app = x;
          return { screens: { a: { nav: "А", view: Screen } } };
        },
      };
      await stand([part], { relay: new FakeRelay(homeRoster()) });
      await flush();
      expect(prevs[0]).toBeUndefined();
      expect(prevs.at(-1)).toBe(5);
    });
  });

  describe("on.current", () => {
    it("6804 · открытый экран приходит модулю с параметрами на каждый переход; экран в снимке уже новый", async () => {
      const seen: Array<{ screen: string; params: Params }> = [];
      const shown: Array<string | undefined> = [];
      let app!: App;
      const part: AppPart = {
        manifest: { name: "m", type: "web", version: "1.0.0", provides: { a: 1, b: 1 }, uses: {} },
        module: (x) => ({
          on: {
            current: (c) => {
              seen.push(c);
              shown.push(app.current()?.screen);
            },
          },
          screens: { a: { nav: "А", view: () => null }, b: { path: "b", view: () => null } },
          start: () => {
            app = x;
          },
        }),
      };
      await stand([part], { relay: new FakeRelay(homeRoster()) });
      await flush();
      expect(seen).toEqual([{ screen: "a", params: {} }]);
      app.open("b", { callsign: "x@y" });
      await flush();
      expect(seen.at(-1)).toEqual({ screen: "b", params: { callsign: "x@y" } });
      expect(shown).toEqual(["a", "b"]);
    });
  });
});

describe("контракт ядра сверх старых тестов (чьё: код)", () => {
  const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, ...uses } });
  /** Модуль m: раздел a, экран b; app — в коробке. */
  function mod(over: Partial<AppModule> = {}, provides: Record<string, number> = {}, uses: Record<string, number> = {}) {
    const box: { app: App } = { app: null as never };
    const part: AppPart = {
      manifest: man("m", { a: 1, b: 1, ...provides }, uses),
      module: (a) => {
        box.app = a;
        return { screens: { a: { nav: "А", label: "А", view: () => <div data-s="a">а</div> }, b: { label: "Б", view: () => <div data-s="b">б</div> } }, ...over };
      },
    };
    return { part, box };
  }
  const key = (over: Partial<KeyboardEventInit>) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...over }));
  const ctrlK = () => key({ key: "k", code: "KeyK", ctrlKey: true });
  const texts = (root: Element, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].map((b) => b.textContent);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("экраны остановки: весь текст", () => {
    const refused = (word: string, o: { key?: string; wide?: boolean } = {}) => {
      const relay = new FakeRelay(oneMachine());
      relay.refuse = [word];
      return { relay, store: memoryStore({ key: o.key ?? KEY }), wide: o.wide };
    };
    it.each([
      ["5103 revoked", "revoked", () => refused("revoked"), ["Пропуск отозван", "client.phone.k2a9 больше не принимают. Новый пропуск — приглашением от агента флота:", "keys.invite client phone <почта>", "Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.", "Стереть данные приложения"]],
      ["5103 bad_key, широкий вид", "bad_key", () => refused("bad_key", { key: "client.panel-desk.k3f1.Qa7sig", wide: true }), ["Пропуск не принят", "client.panel-desk.k3f1 не принят флотом. Новый пропуск — приглашением от агента флота:", "keys.invite client panel-desk <почта>"]],
      ["4007 contract_mismatch", "contract_mismatch", () => refused("contract_mismatch"), ["Приложение устарело", "У приложения proto 1; relay эту версию не принял — его обновили, пока приложение было открыто.", "Перезагрузить"]],
      ["4008 прочий отказ relay", "replaced", () => refused("replaced"), ["Связь остановлена", "relay закрыл соединение: replaced.", "Перезагрузить"]],
    ])("%s: причина, текст, второго hello нет, разделов нет", async (_n, why, make, want) => {
      const o = make();
      const t = await stand([mod().part], o);
      await flush(20);
      expect(t.run.stopped).toBe(why);
      for (const s of want) expect(t.root.querySelector(".sb-full")!.textContent).toContain(s);
      expect(o.relay.hellos).toHaveLength(1);
      expect(t.$<HTMLElement>(".sb-navcol")!.hidden).toBe(true);
      expect(t.$<HTMLElement>(".sb-bar")!.hidden).toBe(true);
      expect(t.$<HTMLElement>(".sb-off")!.hidden).toBe(true);
    });

    it("«Браузер устарел»: что сделать", async () => {
      const t = await stand([mod().part], { options: { platform: { ios: false, standalone: false, scope: false } } });
      expect(t.$(".sb-full")!.textContent).toContain("Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.");
    });

    it("5102 установка на iPhone: номер приглашения, секрета нет", async () => {
      const t = await stand([mod().part], { store: memoryStore(), url: `/#invite=${INVITE}`, ios: true });
      const text = t.$(".sb-full")!.textContent!;
      expect(text).toContain("На iPhone уведомления приходят только приложению с экрана «Домой».");
      expect(text).toContain(`Приглашение ${INVITE.split(".")[0]} ждёт в адресе страницы до установки.`);
      expect(text).not.toContain(INVITE.split(".")[1]);
    });

    it.each([
      ["bad_invite", { ok: false, error: "bad_invite" }, "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое."],
      ["gate_unavailable", { ok: false, error: "gate_unavailable" }, "gate не ответил: gate_unavailable. Откройте ссылку ещё раз позже."],
    ] as const)("приглашение не принято %s: своё слово, адрес очищен, связи нет", async (word, answer, text) => {
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = () => answer;
      const t = await stand([mod().part], { relay, store: memoryStore(), url: `/#invite=${INVITE}` });
      expect(t.run.stopped).toBe(word);
      expect(t.$(".sb-big")!.textContent).toBe("Приглашение не принято");
      expect(t.$(".sb-full")!.textContent).toContain(text);
      expect(location.hash).toBe("");
      expect(relay.socks).toHaveLength(0);
    });

    it("gate не отвечает на приём приглашения: сеть упала — gate_unavailable; молчит — через 30 с то же", async () => {
      const down = await stand([mod().part], { store: memoryStore(), url: `/#invite=${INVITE}`, options: { fetch: (() => Promise.reject(new Error("нет сети"))) as never } });
      expect(down.run.stopped).toBe("gate_unavailable");
      document.body.innerHTML = '<div id="app"></div>';
      history.replaceState(null, "", `/#invite=${INVITE}`);
      vi.useFakeTimers();
      const relay = new FakeRelay(oneMachine());
      const run = startApp({ root: document.getElementById("app")!, workers: FakeRelay.WORKERS, fetch: (() => new Promise(() => {})) as never, parts: [mod().part], store: memoryStore(), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false } });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(run.stopped).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(run.stopped).toBe("gate_unavailable");
    });

    it("замена пропуска: кто и чем заменяет", async () => {
      const t = await stand([mod().part], { url: `/#invite=${INVITE}` });
      expect(t.run.stopped).toBe("replace");
      expect(t.$(".sb-full")!.textContent).toContain(`Ссылка несёт приглашение ${INVITE.split(".")[0]}. Сейчас устройство входит пропуском client.phone.k2a9. Заменяйте, только если сами просили эту ссылку.`);
    });

    it("нужен пропуск: текст, поле; широкий вид просит имя устройства", async () => {
      const t = await stand([mod().part], { store: memoryStore() });
      const text = t.$(".sb-full")!.textContent!;
      expect(text).toContain("Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:");
      expect(text).toContain("Или вставьте приглашение:");
      expect(t.$<HTMLInputElement>(".sb-keyin")!.placeholder).toBe("приглашение или ссылка с #invite=");
      const w = await stand([mod().part], { store: memoryStore(), wide: true });
      expect(w.$(".sb-full")!.textContent).toContain("keys.invite client <имя> <почта>");
    });

    it("отказ gate на вставленном приглашении: слово на экране, пропуска нет", async () => {
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = () => ({ ok: false, error: "bad_invite" });
      const store = memoryStore();
      const t = await stand([mod().part], { relay, store });
      t.$<HTMLInputElement>(".sb-keyin")!.value = `#invite=${INVITE}`;
      await t.click(t.button("Принять приглашение"));
      await flush();
      expect(t.$('[role="alert"]')!.textContent).toBe("Приглашение не принято: bad_invite.");
      expect(store.data.key).toBeUndefined();
    });

    it("экран упавшего модуля: женский род по подписи, без подписи — «Экран»; причина и совет", async () => {
      const Bad = () => {
        throw new Error("сломан");
      };
      const fem = await stand([{ manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", label: "Лента", view: Bad } } }) }]);
      expect(fem.$(".sb-badc b")!.textContent).toBe("Лента выключена");
      expect(fem.$(".sb-badc code")!.textContent).toBe("Модуль m упал на экране a: Error: сломан");
      expect(fem.$(".sb-badc")!.textContent).toContain("Остальные экраны работают. Этот вернётся после перезапуска приложения.");
      const plain = await stand([{ manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", view: Bad } } }) }]);
      expect(plain.$(".sb-badc b")!.textContent).toBe("Экран выключен");
    });
  });

  describe("шапка и связь", () => {
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
      const t = await stand([
        mod({ screens: { a: { nav: "А", view: () => null, head: () => ({ title: "site@laptop", mono: true, sub: "работает", dot: "busy", pill: { text: "ждёт", tone: "wait" } }) } } }).part,
      ], { relay, pauseMs: 60_000 });
      expect(t.$(".sb-bt b.m")!.textContent).toBe("site@laptop");
      expect(t.$(".sb-bt span")!.textContent).toBe("работает");
      expect(t.$(".sb-bar .sb-dot.busy")).not.toBeNull();
      expect(t.$(".sb-pill.wait")!.textContent).toBe("ждёт");
      relay.drop();
      await flush();
      expect(t.$(".sb-pill.bad")!.textContent).toBe("нет связи");
      expect(t.$(".sb-pill")!.classList.contains("conn")).toBe(true);
    });

    it("полоса в широком виде: данные на ЧЧ:ММ; срок вышел, а связи всё нет — «подключаюсь»", async () => {
      const relay = new FakeRelay(oneMachine());
      let made = 0;
      const WS = relay.WebSocket;
      const hang = class extends WS {
        constructor(u: string) {
          super(u);
          // второе соединение повисает: ни открытия, ни закрытия
          if (++made > 1) (this as { readyState: number }).readyState = 9;
        }
      };
      const t = await stand([mod().part], { relay, wide: true, pauseMs: 100, options: { WebSocket: hang } });
      relay.drop();
      await flush();
      expect(t.$(".sb-off")!.textContent).toMatch(/^Нет связи с relay · данные на \d\d:\d\d · снова через 1 сСейчас$/);
      await new Promise((r) => setTimeout(r, 1200));
      await flush();
      expect(t.$(".sb-off")!.textContent).toMatch(/^Нет связи с relay · данные на \d\d:\d\d · подключаюсьСейчас$/);
    });

    it("экран подключения: номер пропуска, после приглашения — «Ключ сохранён»", async () => {
      document.body.innerHTML = '<div id="app"></div>';
      history.replaceState(null, "", `/#invite=${INVITE}`);
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = () => ({ ok: true, result: { key: KEY } });
      const root = document.getElementById("app")!;
      const run = startApp({ root, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [mod().part], store: memoryStore(), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
      await run.ready;
      await new Promise((r) => setTimeout(r, 0));
      expect(root.querySelector(".sb-big")!.textContent).toBe("Ключ сохранён");
      expect(root.querySelector(".sb-k")!.textContent).toBe("client.phone.k2a9");
      expect(root.querySelector(".sb-full p")!.textContent).toBe("подключаюсь · hello");
      run.unmount();
    });

    it("уход ждёт начатый запрос, потом стоп модуля; после стопа ещё один запрос тоже доводится", async () => {
      const log: string[] = [];
      const relay = new FakeRelay(oneMachine());
      relay.handlers.ask = () => undefined as never;
      const box: { app: App } = { app: null as never };
      const part: AppPart = {
        manifest: man("m", { a: 1 }, { "ask@x": 1 }),
        module: (a) => {
          box.app = a;
          return {
            screens: { a: { nav: "А", view: () => null } },
            stop() {
              log.push("stop");
              void a.request("ask", { callsign: "site@laptop", n: 2 }).then(() => log.push("ответ 2"));
            },
          };
        },
      };
      const t = await stand([part], { relay });
      void box.app.request("ask", { callsign: "site@laptop", n: 1 }).then(() => log.push("ответ 1"));
      await flush();
      const left = t.run.hide();
      await flush();
      expect(log).toEqual([]);
      relay.reply(relay.sent("ask")[0].id as string, { ok: true });
      await flush();
      expect([...log].sort()).toEqual(["stop", "ответ 1"]);
      expect(relay.socks[0].closedWith).toBeNull();
      relay.reply(relay.sent("ask")[1].id as string, { ok: true });
      await left;
      expect(log.at(-1)).toBe("ответ 2");
      expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    });

    it("7284 · модуль не отпускает: уход закрывает связь за 30 с; не вернулся — hello всё равно за 30 с; причина в журнале", async () => {
      // источник: устав — у всех операций лимит и graceful shutdown; не успела — жёсткий выход, это ожидаемая ветка
      const never = new Promise<void>(() => {});
      const relay = new FakeRelay(oneMachine());
      const t = await stand([mod({ stop: () => never, on: { show: () => never } }).part], { relay });
      vi.useFakeTimers();
      const left = t.run.hide();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(relay.socks[0].closedWith).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await left;
      expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
      expect(console.warn).toHaveBeenCalledWith("switchboard: прощание модулей не успело за 30 с");
      const back = t.run.show();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(relay.socks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await back;
      expect(relay.socks).toHaveLength(2);
      expect(console.warn).toHaveBeenCalledWith("switchboard: возвращение модулей не успело за 30 с");
    });

    it("вкладка скрылась и вернулась: visibilitychange — уход и возвращение", async () => {
      const log: string[] = [];
      const relay = new FakeRelay(oneMachine());
      await stand([mod({ stop: () => void log.push("stop"), on: { show: () => void log.push("show") } }).part], { relay });
      const set = (v: string) => {
        Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      try {
        set("hidden");
        await flush();
        expect(log).toEqual(["stop"]);
        expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
        set("visible");
        await flush();
        expect(log).toEqual(["stop", "show"]);
        expect(relay.hellos).toHaveLength(2);
      } finally {
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      }
    });

    it("машина оборвалась при открытом флоте и вернулась: on.link open с машиной, флот открыт всё время", async () => {
      const seen: Array<[ConnState, string | undefined]> = [];
      const relay = new FakeRelay(homeRoster());
      await stand([mod({ on: { link: (s, m) => void seen.push([s, m]) } }).part], { relay, pauseMs: 5 });
      seen.length = 0;
      relay.socks.find((x) => x.url.endsWith("/m/laptop"))!.serverClose(1006, "");
      await new Promise((r) => setTimeout(r, 40));
      await flush();
      expect(seen).toEqual([["open", "laptop"]]);
    });

    it("запрос при закрытой связи — disconnected, кадра нет; после ухода — тоже", async () => {
      const relay = new FakeRelay(oneMachine());
      const m = mod({}, {}, { "ask@x": 1 });
      const t = await stand([m.part], { relay });
      await t.run.hide();
      expect(await m.box.app.request("ask", { callsign: "site@laptop" })).toEqual({ ok: false, error: "disconnected" });
      expect(relay.sent("ask")).toEqual([]);
    });
  });

  describe("тост", () => {
    it("своя строка и тон; по умолчанию bad; новая сменяет прежнюю; через 6 с скрыт", async () => {
      const m = mod();
      const t = await stand([m.part]);
      m.box.app.toast("упало");
      await flush();
      expect(t.$(".sb-toast.bad")!.textContent).toBe("упало");
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(5_000);
      m.box.app.toast("ладно", "ok");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(t.$<HTMLElement>(".sb-toast.ok")!.hidden).toBe(false);
      expect(t.$(".sb-toast")!.textContent).toBe("ладно");
      await vi.advanceTimersByTimeAsync(4_500);
      expect(t.$<HTMLElement>(".sb-toast")!.hidden).toBe(true);
    });

    it("приглашение принято: слова про флот, склонение и пустой флот", async () => {
      const answer = () => ({ ok: true as const, result: { key: KEY } });
      const home = new FakeRelay(homeRoster());
      home.handlers["gate.redeem"] = answer;
      const a = await stand([mod().part], { relay: home, store: memoryStore(), url: `/#invite=${INVITE}` });
      expect(a.$(".sb-toast.ok")!.textContent).toBe("Вы во флоте: laptop и pc на связи, 4 сессии.");
      const empty = new FakeRelay(homeRoster({ machines: [], sessions: [], clients: [] }));
      empty.handlers["gate.redeem"] = answer;
      const b = await stand([mod().part], { relay: empty, store: memoryStore(), url: `/#invite=${INVITE}` });
      expect(b.$(".sb-toast.ok")!.textContent).toBe("Вы во флоте: машин нет на связи, 0 сессий.");
    });
  });

  describe("поиск", () => {
    const parts = (): AppPart[] => [
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

    it("строка ведёт на свой экран или экран из uses; подпись раздела — группа или «раздел»; ничего — словами; первый отмечен", async () => {
      const t = await stand(parts(), { wide: true });
      ctrlK();
      await flush();
      expect(t.$<HTMLInputElement>(".sb-palin")!.placeholder).toBe("");
      expect(texts(t.root, ".sb-palit .l")).toEqual(["Работа", "своя", "из uses", "Машины"]);
      expect(texts(t.root, ".sb-palit .k")).toEqual(["раздел", "сессия", "Флот"]);
      expect(t.$(".sb-palit.first .l")!.textContent).toBe("Работа");
      expect(t.$$(".sb-palit")[1].querySelector(".sb-dot.busy")).not.toBeNull();
      await t.click(t.$$(".sb-palit")[2]);
      expect(location.hash).toBe("#card");
      expect(t.$<HTMLElement>(".sb-palw")!.hidden).toBe(true);
    });

    it("«Ничего не нашлось»; Ctrl K закрывает открытый, ⌘K и русская раскладка открывают; покрывало закрывает; не больше 40 строк", async () => {
      const many: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", find: (q) => (q === "нет" ? [] : Array.from({ length: 50 }, (_, i) => ({ label: `s${i}`, screen: "a" }))), view: () => "а" } } }) };
      const t = await stand([many], { wide: true });
      ctrlK();
      await flush();
      expect(t.$$(".sb-palit")).toHaveLength(40);
      const input = t.$<HTMLInputElement>(".sb-palin")!;
      input.value = "нет";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(t.$(".sb-pal .sb-note")!.textContent).toBe("Ничего не нашлось");
      ctrlK();
      await flush();
      expect(t.$<HTMLElement>(".sb-palw")!.hidden).toBe(true);
      key({ key: "л", code: "KeyK", metaKey: true });
      await flush();
      expect(t.$<HTMLElement>(".sb-palw")!.hidden).toBe(false);
      await t.click(t.$(".sb-palveil"));
      expect(t.$<HTMLElement>(".sb-palw")!.hidden).toBe(true);
    });

    it("узкий вид и остановленное приложение: Ctrl K ничего не открывает; упавший модуль и полоса top в поиск не идут", async () => {
      const narrow = await stand(parts());
      ctrlK();
      await flush();
      expect(narrow.$<HTMLElement>(".sb-palw")!.hidden).toBe(true);
      const relay = new FakeRelay(oneMachine());
      relay.refuse = ["revoked"];
      const off = await stand(parts(), { relay, wide: true });
      await flush(20);
      ctrlK();
      await flush();
      expect(off.$<HTMLElement>(".sb-palw")!.hidden).toBe(true);
      const bar: AppPart = { manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: () => ({ screens: { bar: { place: "top", nav: "Полоса", view: () => null } } }) };
      const bad = mod({ screens: { a: { nav: "Плохой", find: () => [{ label: "ни за что", screen: "a" }], view: () => null } }, frames: { boom: () => { throw new Error("boom"); } } }, {}, { "boom@x": 1 });
      const t = await stand([bar, bad.part], { wide: true });
      bad.box.app.deliver({ type: "boom" });
      ctrlK();
      await flush();
      expect(texts(t.root, ".sb-palit .l")).toEqual([]);
    });
  });

  describe("разделы и места", () => {
    it("колонка: имя приложения из опций, иначе Switchboard; лампа с подписью; «Перейти…» и Ctrl K", async () => {
      const a = await stand([mod().part], { wide: true });
      expect(a.$(".sb-brand b")!.textContent).toBe("Switchboard");
      expect(a.$(".sb-brand .sb-pill")!.getAttribute("title")).toBe("на связи");
      expect(a.$(".sb-brand .sb-pill")!.getAttribute("aria-label")).toBe("на связи");
      expect(a.$(".sb-goto")!.textContent).toBe("Перейти…Ctrl K");
      const b = await stand([mod().part], { wide: true, options: { brand: "Пульт" } });
      expect(b.$(".sb-brand b")!.textContent).toBe("Пульт");
    });

    it("вкладки: один раздел — их нет; счёт группы — сумма; открытая группа нажатием не перескакивает; счётчик раздела на ленте", async () => {
      const one = await stand([mod().part]);
      expect(one.$<HTMLElement>(".sb-tabs")!.hidden).toBe(true);
      const f: AppPart = {
        manifest: man("f", { x: 1, y: 1, z: 1, cnt: 1, cn2: 1 }),
        module: () => ({
          screens: { x: { nav: "Икс", group: "Г", mark: "cnt", view: () => "икс" }, y: { nav: "Игрек", group: "Г", mark: "cn2", view: () => "игрек" }, z: { nav: "Зет", view: () => "зет" } },
          marks: { cnt: () => 2, cn2: () => 3 },
        }),
      };
      const t = await stand([f]);
      expect(texts(t.root, '.sb-tabs [data-group="Г"] .sb-badge')).toEqual(["5"]);
      await t.click(t.$('.sb-tabs [data-screen="z"]'));
      await flush();
      await t.click(t.$('.sb-tabs [data-group="Г"]'));
      await flush();
      expect(location.hash).toBe("#x");
      expect(texts(t.root, ".sb-navrow .sb-badge")).toEqual(["2", "3"]);
      await t.click(t.$('.sb-navrow [data-screen="y"]'));
      await flush();
      expect(location.hash).toBe("#y");
      await t.click(t.$('.sb-tabs [data-group="Г"]'));
      await flush();
      expect(location.hash).toBe("#y");
      expect(t.$('.sb-navrow [aria-current="page"]')!.textContent).toBe("Игрек3");
    });

    it("полоса top: над разделом и над списком рядом; над экраном не раздела скрыта", async () => {
      const bar: AppPart = { manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: () => ({ screens: { bar: { place: "top", view: () => <i data-bar>полоса</i> } } }) };
      const m = mod();
      const t = await stand([m.part, bar]);
      expect(t.$<HTMLElement>(".sb-top")!.hidden).toBe(false);
      expect(t.$(".sb-top [data-bar]")).not.toBeNull();
      m.box.app.open("b");
      await flush();
      expect(t.$<HTMLElement>(".sb-top")!.hidden).toBe(true);
      const w = mod();
      const u = await stand([w.part, bar], { wide: true, options: { beside: { b: "a" } } });
      w.box.app.open("b");
      await flush();
      expect(u.$<HTMLElement>(".sb-top")!.hidden).toBe(false);
      expect(w.box.app.current()).toEqual({ screen: "b", params: {}, master: "a" });
    });

    it("место: команда пунктом с подписью, скрытая show; без подписи — имя; run владельца; open экрана в своём месте", async () => {
      const run = vi.fn();
      const box: { app?: App } = {};
      const owner: AppPart = {
        manifest: man("o", { o: 1, "o.tab": 1 }),
        module: (a) => ({ screens: { o: { nav: "О", view: () => null } }, start: () => void (box.app = a) }),
      };
      const guest: AppPart = {
        manifest: man("g", { "g.tab": 1, "g.act": 1, "g.off": 1 }, { "o.tab@o": 1 }),
        module: () => ({
          screens: { "g.tab": { place: "o.tab", label: "Вкладка", view: () => <i data-tab>вкладка</i> } },
          commands: { "g.act": { place: "o.tab", run }, "g.off": { place: "o.tab", show: () => false, run } },
        }),
      };
      const t = await stand([owner, guest]);
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
      const side: AppPart = { manifest: man("s", { go: 1, boom: 1 }), module: () => ({ commands: { go: { run: () => {} }, boom: { run: () => { throw new Error("сломана"); } } } }) };
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

    it("Slot: close передан экрану; экран в месте получает свой useApp", async () => {
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

  describe("что ядро даёт модулю", () => {
    it("имя из пропуска, адрес от gate, вид, приложение; can по contract; worker из сборки, чужое имя — null", async () => {
      const m = mod();
      await stand([m.part], { relay: new FakeRelay(homeRoster()), options: { application: "pult" } });
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
    });

    it("адрес переживает уход: новое соединение ещё не спросило gate, вид показывает прежний", async () => {
      const m = mod();
      const t = await stand([m.part]);
      expect(m.box.app.address()).toBe("phone~owner@example.com");
      await t.run.hide();
      expect(m.box.app.address()).toBe("phone~owner@example.com");
    });

    it("deliver: кадр владельцу с ctx open; без владельца — предупреждение; запрос к странице — unknown_request", async () => {
      const got: Array<[string, boolean]> = [];
      const m = mod({ frames: { ping: (f, c) => void got.push([String(f.from), c.open]) } }, {}, { "ping@x": 1 });
      const relay = new FakeRelay(oneMachine());
      await stand([m.part], { relay });
      m.box.app.deliver({ type: "ping", from: "a" }, { open: true });
      m.box.app.deliver({ type: "ping", from: "b" });
      expect(got).toEqual([["a", true], ["b", false]]);
      m.box.app.deliver({ type: "nobody" });
      expect(console.warn).toHaveBeenCalledWith("switchboard: кадр nobody — владельца в приложении нет");
    });

    it("свой раздел хранилища: чтение, запись, правка; у раздела ядра key свой владелец", async () => {
      const m = mod({ store: ["drafts"] });
      const store = memoryStore({ key: KEY });
      await stand([m.part], { store });
      const s = m.box.app.store<number[]>("drafts");
      expect(await s.get()).toBeUndefined();
      await s.set([1]);
      expect(await s.update((a = []) => [...a, 2])).toEqual([1, 2]);
      expect(store.data.drafts).toEqual([1, 2]);
      const thief: AppPart = { manifest: man("t", {}), module: () => ({ store: ["key"] }) };
      expect(appGate(defined([thief])).some((e) => e.includes("store.key") && e.includes("два владельца"))).toBe(true);
    });

    it("своя метка и метка из uses: аргументы доходят; метка бросила — выключен её владелец", async () => {
      const own: AppPart = { manifest: man("own", { lab: 1, bad: 1 }), module: () => ({ marks: { lab: (x) => `метка ${x}`, bad: () => { throw new Error("сломана"); } } }) };
      const m = mod({ marks: { mine: () => 7 } }, { mine: 1 }, { "lab@own": 1, "bad@own": 1 });
      const t = await stand([own, m.part]);
      expect(m.box.app.mark("mine")).toBe(7);
      expect(m.box.app.mark("lab", "x")).toBe("метка x");
      expect(m.box.app.mark("bad")).toBeUndefined();
      expect(t.run.failed.own).toBe("Модуль own упал на метке bad: Error: сломана");
      expect(t.run.failed.m).toBeUndefined();
    });

    it("состояние модуля: app.state — поле state его определения", async () => {
      const state = { n: 1 };
      const m = mod({ state });
      await stand([m.part]);
      expect(m.box.app.state).toBe(state);
    });

    it("гейт: команда и метка не из provides, место команды не из uses; набор без ошибок — пусто", () => {
      const bad: AppPart = {
        manifest: man("x", {}),
        module: () => ({ commands: { c: { run: () => {} } }, marks: { z: () => 1 } }),
      };
      expect(appGate(defined([bad]))).toEqual(["модуль x: команды c нет в provides", "модуль x: метки z нет в provides"]);
      const place: AppPart = { manifest: man("y", { d: 1 }), module: () => ({ commands: { d: { place: "o.tab", run: () => {} } } }) };
      expect(appGate(defined([place]))).toEqual(["модуль y: команда d — места o.tab нет в uses"]);
      expect(appGate(defined([{ manifest: man("ok", {}), module: () => ({}) }]))).toEqual([]);
    });
  });

  describe("сборка и платформа", () => {
    const list = (...names: string[]): BuildList => ({ app: "phone", version: "1.0.0+1", fleet: "test", modules: names.map((name) => ({ name, version: "1.0.0" })), workers: FakeRelay.WORKERS });
    const start = (build: BuildList, load: (n: string) => Promise<unknown>) => {
      document.body.innerHTML = '<div id="app"></div>';
      const relay = new FakeRelay(homeRoster());
      return startBuild({ root: document.getElementById("app")!, build, load, fetch: relay.fetch, store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    };

    it("файл без default или manifest — причина словами; библиотека страницы (default — объект) — без экранов и без сбоя", async () => {
      const run = await start(list("empty", "lib", "ok"), async (n) => {
        if (n === "empty") return { default: () => ({}) };
        if (n === "lib") return { default: {}, manifest: man("lib", {}) };
        return { default: () => ({ screens: { ok: { nav: "Живой", view: () => "живой" } } }), manifest: man("ok", { ok: 1 }) };
      });
      await run.ready;
      await flush();
      expect(run.failed).toEqual({ empty: "Модуль empty упал на старте: Error: импорт: в файле модуля нет default или manifest" });
      expect(document.body.textContent).toContain("живой");
      run.unmount();
    });

    /** Окно с нужным navigator и @scope или без него. */
    const windowWith = (ua: string, o: { standalone?: boolean; scope?: boolean }) => {
      const nav = new Proxy(navigator, { get: (x, k) => (k === "userAgent" ? ua : k === "standalone" ? o.standalone : Reflect.get(x, k)) });
      return new Proxy(window, {
        has: (x, k) => (k === "CSSScopeRule" ? !!o.scope : k in x),
        get(x, k) {
          if (k === "navigator") return nav;
          const v = Reflect.get(x, k);
          return typeof v === "function" && k !== "Response" ? v.bind(x) : v;
        },
      });
    };
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

    it.each([
      ["браузер без @scope", "Mozilla/5.0", { scope: false }, "browser"],
      ["iPhone вне экрана «Домой»", IPHONE, { scope: true }, "install"],
      ["iPhone с экрана «Домой»", IPHONE, { scope: true, standalone: true }, null],
      ["обычный браузер с @scope", "Mozilla/5.0", { scope: true }, null],
    ] as const)("платформа по navigator: %s", async (_n, ua, o, want) => {
      document.body.innerHTML = '<div id="app"></div>';
      history.replaceState(null, "", `/#invite=${INVITE}`);
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = () => ({ ok: true, result: { key: KEY } });
      const run = startApp({ root: document.getElementById("app")!, window: windowWith(ua, o) as Window, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: [mod().part], store: memoryStore(), WebSocket: relay.WebSocket, pauseMs: 5 });
      await run.ready;
      await flush();
      expect(run.stopped).toBe(want);
      run.unmount();
    });

    it("хранилище в памяти: копии при чтении и записи; clear стирает всё", async () => {
      const init = { a: { n: 1 } };
      const s = memoryStore(init);
      const got = await s.get<{ n: number }>("a");
      got!.n = 9;
      expect(await s.get("a")).toEqual({ n: 1 });
      const put = { n: 2 };
      await s.set("a", put);
      put.n = 3;
      expect(s.data.a).toEqual({ n: 2 });
      expect(init.a.n).toBe(1);
      await s.clear();
      expect(s.data).toEqual({});
    });

    it("две базы IndexedDB не видят друг друга; запись правки в одной транзакции — два update подряд не теряются", async () => {
      const f = new IDBFactory();
      const a = idbStore("a", f);
      const b = idbStore("b", f);
      await a.set("k", 1);
      expect(await b.get("k")).toBeUndefined();
      await Promise.all([a.update<number>("n", (x = 0) => x + 1), a.update<number>("n", (x = 0) => x + 1)]);
      expect(await a.get("n")).toBe(2);
    });
  });

  describe("ответ выборки", () => {
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
});

describe("спорные места после сверки (устав: предел у всех операций, система ловит)", () => {
  const man = (name: string, provides: Record<string, number>): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2 } });
  const part = (over: Partial<AppModule> = {}): AppPart => ({ manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", view: () => <i data-s="a">а</i> } }, ...over }) });
  const start = (o: { parts?: AppPart[]; store?: unknown; relay?: FakeRelay }) => {
    document.body.innerHTML = '<div id="app"></div>';
    const relay = o.relay ?? new FakeRelay(oneMachine());
    const root = document.getElementById("app")!;
    const run = startApp({ root, workers: FakeRelay.WORKERS, fetch: relay.fetch, parts: o.parts ?? [part()], store: (o.store ?? memoryStore({ key: KEY })) as never, WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    return { run, root, relay };
  };
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("адрес с негодным экранированием: страница работает, домашний раздел", async () => {
    history.replaceState(null, "", "/#%");
    const t = start({});
    await t.run.ready;
    await flush();
    expect(t.relay.hellos).toHaveLength(1);
    expect(t.root.querySelector('[data-s="a"]')).not.toBeNull();
    t.run.unmount();
  });

  it("вставка с негодным экранированием: отказ словами, а не молчание", async () => {
    const t = await stand([part()], { store: memoryStore() });
    t.$<HTMLInputElement>(".sb-keyin")!.value = "abc%";
    await t.click(t.button("Принять приглашение"));
    await flush();
    expect(t.$('[role="alert"]')!.textContent).toBe("Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.");
  });

  it("хранилище молчит: через 30 с причина на странице, а не пустой экран", async () => {
    vi.useFakeTimers();
    const t = start({ store: { get: () => new Promise(() => {}), set: async () => {}, update: async () => undefined, clear: async () => {} } });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.root.textContent).not.toContain("Приложение упало");
    await vi.advanceTimersByTimeAsync(1);
    await t.run.ready;
    expect(t.root.textContent).toBe("Приложение упало: хранилище не ответило за 30 с");
  });

  it("хранилище отказало: причина на странице; ready не бросает", async () => {
    const t = start({ store: { get: () => Promise.reject(new Error("нет места")), set: async () => {}, update: async () => undefined, clear: async () => {} } });
    await t.run.ready;
    await flush();
    expect(t.root.textContent).toBe("Приложение упало: нет места");
  });

  it("start модуля не отвечает: через 30 с связь всё равно идёт, причина в журнале", async () => {
    const relay = new FakeRelay(oneMachine());
    vi.useFakeTimers();
    const t = start({ relay, parts: [part({ start: () => new Promise<void>(() => {}) })] });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(relay.socks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await t.run.ready;
    await vi.advanceTimersByTimeAsync(10);
    expect(relay.socks).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith("switchboard: модули не запустились за 30 с");
  });
});

describe("разметка вида: на ней стоят стили и снимки (чьё: код)", () => {
  const man = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name, type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, ...uses } });
  /** Модуль: раздел a с меткой и шапкой, экран b, разделы группы; полоса top — отдельным модулем. */
  const pair = () => {
    const box: { app: App } = { app: null as never };
    const parts: AppPart[] = [
      {
        manifest: man("m", { a: 1, b: 1, g1: 1, g2: 1, cnt: 1, zero: 1 }),
        module: (app) => {
          box.app = app;
          return {
            marks: { cnt: () => 2, zero: () => 0 },
            screens: {
              a: { nav: "А", mark: "cnt", label: "А", view: () => <i data-s="a" />, head: () => ({ title: "Т", sub: "под", dot: "busy", action: { label: "Новая", text: "+", run() {} } }) },
              b: { label: "Б", view: () => <i data-s="b" /> },
              g1: { nav: "Г1", group: "Г", mark: "zero", view: () => <i data-s="g1" /> },
              g2: { nav: "Г2", group: "Г", view: () => <i data-s="g2" /> },
            },
          };
        },
      },
      { manifest: man("bar", { bar: 1 }, { "top@web-core": 1 }), module: () => ({ screens: { bar: { place: "top", view: () => <i data-bar /> } } }) },
    ];
    return { parts, box };
  };
  const shape = (el: Element) => [...el.children].map((c) => `${c.tagName.toLowerCase()}.${c.className.trim().replace(/ +/g, ".")}`);
  /** Атрибуты элемента по имени. */
  const attrs = (el: Element) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("остов страницы: стиль модулей первым, колонка, главная часть по порядку, поиск; область экрана", async () => {
    const { parts } = pair();
    const t = await stand(parts);
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
    const { parts, box } = pair();
    const t = await stand(parts, { wide: true, options: { beside: { b: "a" }, brand: "Пульт" } });
    box.app.open("b");
    await flush();
    expect(t.$(".sb-app")!.className).toBe("sb-app wide");
    expect(shape(t.$(".sb-view")!)).toEqual(["div.sb-split"]);
    expect(shape(t.$(".sb-split")!)).toEqual(["div.sb-master", "div.sb-detail"]);
    expect(t.$(".sb-master")!.getAttribute("style")).toBeNull();
    expect(t.$('.sb-master[data-screen="a"] > [data-module="m"] > [data-s="a"]')).not.toBeNull();
    expect(t.$('.sb-detail > .sb-screen[data-screen="b"] > [data-module="m"] > [data-s="b"]')).not.toBeNull();
    expect(shape(t.$(".sb-navcol")!)).toEqual(["div.sb-brand", "button.sb-tx.sb-goto", "button.sb-rw.sb-nv", "div.sb-grp", "button.sb-rw.sb-nv", "button.sb-rw.sb-nv"]);
    expect(shape(t.$(".sb-brand")!)).toEqual(["b.", "span.sb-pill.ok.conn"]);
    expect(t.$(".sb-goto kbd")!.textContent).toBe("Ctrl K");
  });

  it("шапка раздела: логотип, лампа, заголовок, поиск, действие, пилюля; шапка экрана: назад и заголовок", async () => {
    const { parts, box } = pair();
    const t = await stand(parts);
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

  it("пункт раздела: подпись и счётчик ждущего цвета; метка 0 — счётчика нет; лента и вкладки одной формы", async () => {
    const { parts, box } = pair();
    const t = await stand(parts);
    const tab = t.$('.sb-tabs [data-screen="a"]')!;
    expect(tab.className).toBe("sb-rw sb-nv");
    expect(tab.getAttribute("type")).toBe("button");
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(shape(tab)).toEqual(["span.", "span.sb-badge.wait"]);
    box.app.open("g1");
    await flush();
    expect(shape(t.$('.sb-navrow [data-screen="g1"]')!)).toEqual(["span."]);
    expect(t.$('.sb-tabs [data-group="Г"]')!.className).toBe("sb-rw sb-nv");
    expect(t.$(".sb-navrow")!.hasAttribute("hidden")).toBe(false);
  });

  it("полоса связи: текст и кнопка; пилюля шапки и лампа колонки говорят «нет связи»", async () => {
    const relay = new FakeRelay(homeRoster());
    const t = await stand(pair().parts, { relay, wide: true, pauseMs: 60_000 });
    relay.drop();
    await flush();
    expect(shape(t.$(".sb-off")!)).toEqual(["span.", "button.sb-tx"]);
    expect(t.$(".sb-off button")!.getAttribute("type")).toBe("button");
    expect(attrs(t.$(".sb-brand .sb-pill")!)).toMatchObject({ class: "sb-pill bad conn", title: "нет связи", "aria-label": "нет связи" });
    expect(t.$(".sb-brand .sb-pill")!.textContent).toBe("");
  });

  it.each([
    ["revoked", "client", ["div.sb-ring.bad", "div.sb-big", "p.", "code.sb-cmd", "p.", "button.sb-cta"], "×", "wipe"],
    ["contract_mismatch", "client", ["div.sb-ring.wait", "div.sb-big", "p.", "button.sb-cta"], "↻", null],
    ["replaced", "client", ["div.sb-ring.bad", "div.sb-big", "p.", "button.sb-cta"], "×", null],
  ] as const)("экран отказа %s: значок, порядок, кнопка", async (word, _who, want, ring, act) => {
    const relay = new FakeRelay(homeRoster());
    relay.refuse = [word, word];
    const t = await stand(pair().parts, { relay });
    await flush(20);
    expect(shape(t.$(".sb-view")!)).toEqual(["div.sb-full"]);
    expect(shape(t.$(".sb-full")!)).toEqual(want);
    expect(t.$(".sb-ring")!.textContent).toBe(ring);
    expect(t.$(".sb-cta")!.getAttribute("data-act")).toBe(act);
    expect(t.$(".sb-cta")!.hasAttribute("type")).toBe(false);
  });

  it("экраны до связи: установка, нужен пропуск, замена, приглашение не принято, браузер, гейт, подключение", async () => {
    const parts = () => pair().parts;
    const install = await stand(parts(), { store: memoryStore(), url: `/#invite=${INVITE}`, ios: true });
    expect(shape(install.$(".sb-full")!)).toEqual(["div.sb-logo.xl", "div.sb-big", "p.", "ol.sb-ol", "p."]);
    const none = await stand(parts(), { store: memoryStore() });
    expect(shape(none.$(".sb-full")!)).toEqual(["div.sb-logo.xl", "div.sb-big", "p.", "code.sb-cmd", "p.", "input.sb-in.sb-keyin", "button.sb-cta", "p."]);
    expect(attrs(none.$(".sb-keyin")!)).toMatchObject({ type: "text", "aria-label": "Приглашение" });
    const swap = await stand(parts(), { url: `/#invite=${INVITE}` });
    expect(shape(swap.$(".sb-full")!)).toEqual(["div.sb-ring.wait", "div.sb-big", "p.", "button.sb-cta", "button.sb-b", "p."]);
    expect(swap.$(".sb-ring")!.textContent).toBe("?");
    expect([...swap.$$("button")].map((b) => b.getAttribute("data-act"))).toEqual(["replace", "keep"]);
    const relay = new FakeRelay(oneMachine());
    relay.handlers["gate.redeem"] = () => ({ ok: false, error: "bad_invite" });
    const refused = await stand(parts(), { relay, store: memoryStore(), url: `/#invite=${INVITE}` });
    expect(shape(refused.$(".sb-full")!)).toEqual(["div.sb-ring.bad", "div.sb-big", "p.", "button.sb-cta"]);
    expect(refused.$(".sb-cta")!.getAttribute("data-act")).toBe("wipe");
    const old = await stand(parts(), { options: { platform: { ios: false, standalone: false, scope: false } } });
    expect(shape(old.$(".sb-full")!)).toEqual(["div.sb-ring.wait", "div.sb-big", "p."]);
    const twin: AppPart = { manifest: man("m", {}), module: () => ({}) };
    const gate = await stand([twin, twin]);
    expect(shape(gate.$(".sb-full")!)).toEqual(["div.sb-ring.bad", "div.sb-big", "ul.sb-errs"]);
    expect(gate.$(".sb-errs li")!.textContent).toBe("модуль m: имя уже занято");
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
    const fresh = new FakeRelay(oneMachine());
    const root = document.getElementById("app")!;
    const run = startApp({ root, workers: FakeRelay.WORKERS, fetch: fresh.fetch, parts: parts(), store: memoryStore({ key: KEY }), WebSocket: fresh.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5 });
    await run.ready;
    expect(shape(root.querySelector(".sb-full")!)).toEqual(["div.sb-logo.xl", "span.sb-k", "p."]);
    await flush();
    run.unmount();
    expect(root.innerHTML).toBe("");
  });

  it("поиск: окно и подписи для чтения с экрана; строка — лампа, подпись, вид", async () => {
    const part: AppPart = { manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", find: () => [{ label: "л", hint: "х", dot: "busy", screen: "a" }], view: () => null } } }) };
    const t = await stand([part], { wide: true });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
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

  it("Slot: только место модуля, без имени экрана; упал — причина в том же месте, сосед цел", async () => {
    const box: { app: App } = { app: null as never };
    let boom = false;
    const Side = () => {
      if (box.app.use(() => boom)) throw new Error("x");
      return <b data-side />;
    };
    const main: AppPart = { manifest: man("main", { main: 1 }, { "side@side": 1 }), module: (a) => ({ screens: { main: { nav: "Г", view: () => <div data-main><a.Slot screen="side" /></div> } } }) };
    const side: AppPart = { manifest: man("side", { side: 1 }), module: (a) => ((box.app = a), { screens: { side: { label: "Бок", view: Side } } }) };
    const t = await stand([side, main]);
    const place = t.$('[data-main] > [data-module="side"]')!;
    expect(place.hasAttribute("data-screen")).toBe(false);
    expect(place.className).toBe("");
    expect(place.getAttribute("style")).toBe("display: contents;");
    boom = true;
    box.app.changed();
    await flush();
    expect(t.$("[data-main] > [data-module]")).toBeNull();
    expect(shape(t.$("[data-main] > .sb-pad")!)).toEqual(["div.sb-badc", "button.sb-cta"]);
    expect(shape(t.$(".sb-badc")!)).toEqual(["b.", "code.", "span."]);
  });
});
