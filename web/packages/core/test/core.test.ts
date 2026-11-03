// Ядро на поддельном relay: гейт, ключ, связь, маршрут кадров, запросы, экраны, уход с экрана.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { appGate, idbStore, memoryStore, startApp, type App, type AppModule, type AppPart, type Manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, INVITE, KEY, oneMachine } from "../stand/relay.ts";

const man = (name: string, provides: Record<string, number>, uses: Record<string, number>): Manifest => ({
  name,
  type: "web",
  version: "1.0.0",
  provides,
  uses: { "app@web-core": 1, ...uses },
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
    on: { roster: (r) => log.push(`roster ${r.sessions.length}`), link: (s) => log.push(`link ${s}`) },
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
    start(a) {
      app = a;
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
    module: mod,
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
    const dupe: AppPart = { manifest: man("dupe", {}, { "question@host-questions": 1 }), module: { frames: { question: () => {} } } };
    expect(appGate([a, dupe])).toContain("имя question: два владельца — sample и dupe");
    const { run, relay } = await boot({ parts: [a, dupe] });
    expect(run.stopped).toBe("gate");
    expect(root.textContent).toContain("Приложение не стартует");
    expect(root.textContent).toContain("question: два владельца");
    expect(relay.socks).toHaveLength(0);
  });

  it("экран не из provides, кадр не из uses, uses к модулю выпуска другой версии", () => {
    const bad: AppPart = {
      manifest: man("bad", {}, { "list@sample": 2 }),
      module: { screens: { x: { view: () => null } }, frames: { answered: () => {} } },
    };
    expect(appGate([sample().part, bad])).toEqual([
      "модуль bad: экрана x нет в provides",
      "модуль bad: кадр answered нет в uses",
      "модуль bad: uses list@sample v2 — у владельца v1",
    ]);
    // метка экрана не из marks, on.roster без roster@relay, раздел хранилища у двух модулей
    const bad2: AppPart = {
      manifest: man("bad2", { y: 1 }, {}),
      module: { screens: { y: { mark: "cnt", view: () => null } }, on: { roster: () => {} }, store: ["drafts"] },
    };
    const errs = appGate([sample().part, bad2]);
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

  it("5103 · revoked — экран «Пропуск отозван», переподключений нет", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["revoked"];
    const { run } = await boot({ relay });
    await flush(20);
    expect(run.stopped).toBe("revoked");
    expect(root.textContent).toContain("Пропуск отозван");
    expect(root.textContent).toContain("keys.invite client phone <почта>");
    expect(root.textContent).toContain("client.phone.k2a9 больше не принимают");
    expect(relay.hellos).toHaveLength(1);

    // bad_key в широком виде: «Пропуск не принят»
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    const r2 = new FakeRelay(oneMachine());
    r2.refuse = ["bad_key"];
    const run2 = startApp({ root, workers: FakeRelay.WORKERS, fetch: r2.fetch, parts: [sample().part], store: memoryStore({ key: "client.panel-desk.k3f1.Qa7sig" }), WebSocket: r2.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5, wide: true });
    await run2.ready;
    await flush(20);
    expect(run2.stopped).toBe("bad_key");
    expect(root.textContent).toContain("Пропуск не принят");
    expect(root.textContent).toContain("keys.invite client panel-desk <почта>");
    expect(r2.hellos).toHaveLength(1);
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
    expect(log.filter((x) => x.startsWith("link"))).toEqual(["link open", "link closed", "link connecting", "link open"]);
  });
});

describe("маршрут и запросы", () => {
  it("кадр — модулю по type; ошибка модуля выключает его, экран показывает причину, roster идёт дальше", async () => {
    const log: string[] = [];
    const s = sample(log);
    const other: AppPart = { manifest: man("other", {}, { "roster@relay": 1 }), module: { on: { roster: () => log.push("other roster") } } };
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
  it("возвращение на экран — start модулей заново и hello с тем же ключом", async () => {
    const log: string[] = [];
    const s = sample(log);
    const { run, relay } = await boot({ parts: [s.part] });
    await run.hide();
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    await run.show();
    await flush();
    expect(log.filter((x) => x === "start sample")).toHaveLength(2);
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }, { type: "hello", key: KEY, proto: 1 }]);
    expect(log.slice(log.lastIndexOf("start sample"))).toContain("link open");
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
