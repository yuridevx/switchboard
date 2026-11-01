// Ядро на поддельном relay: гейт, ключ, связь, маршрут кадров, запросы, экраны, уход с экрана.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appGate, idbStore, memoryStore, startApp, type App, type AppModule, type AppPart, type Manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY } from "../stand/relay.ts";

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
        mount(el) {
          el.append("список");
          return { head: () => ({ title: "Флот", sub: `${app.roster()?.machines.length} машины` }), close: () => log.push("list closed") };
        },
      },
      item: {
        mount(el, p) {
          el.append(`item ${p.callsign}`);
          return { head: () => ({ title: p.callsign, mono: true }) };
        },
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
  const relay = o.relay ?? new FakeRelay(homeRoster());
  const store = o.store ?? memoryStore({ key: KEY });
  const s = sample();
  const run = startApp({
    root,
    relayUrl: "wss://relay.test",
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
      module: { screens: { x: { mount() {} } }, frames: { answered: () => {} } },
    };
    expect(appGate([sample().part, bad])).toEqual([
      "модуль bad: экрана x нет в provides",
      "модуль bad: кадр answered нет в uses",
      "модуль bad: uses list@sample v2 — у владельца v1",
    ]);
  });
});

describe("ключ и связь", () => {
  it("ключ из адреса — в хранилище, из адреса убран; hello с ключом; roster — экран раздела", async () => {
    history.replaceState(null, "", "/#" + KEY);
    const store = memoryStore();
    const { relay } = await boot({ store });
    expect(store.data.key).toBe(KEY);
    expect(location.hash).toBe("");
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(root.querySelector(".sb-bt b")!.textContent).toBe("Флот");
    expect(root.querySelector(".sb-pill")!.textContent).toBe("на связи");
    expect(root.textContent).toContain("список");
    expect(root.textContent).toContain("Вы во флоте: laptop и pc на связи, 4 сессии.");
  });

  it("iPhone вне экрана «Домой»: экран установки, ключ ждёт в адресе, связи нет", async () => {
    history.replaceState(null, "", "/#" + KEY);
    const store = memoryStore();
    const { run, relay } = await boot({ store, ios: true });
    expect(run.stopped).toBe("install");
    expect(root.textContent).toContain("Добавьте Switchboard на экран «Домой»");
    expect(location.hash).toBe("#" + KEY);
    expect(store.data.key).toBeUndefined();
    expect(relay.socks).toHaveLength(0);
  });

  it("нет ключа — экран «Нужен ключ флота», связи нет", async () => {
    const { run, relay } = await boot({ store: memoryStore() });
    expect(run.stopped).toBe("no_key");
    expect(relay.socks).toHaveLength(0);
  });

  it("revoked — экран «Ключ отозван», повторных hello нет", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.refuse = ["revoked"];
    const { run } = await boot({ relay });
    await flush(20);
    expect(run.stopped).toBe("revoked");
    expect(root.textContent).toContain("Ключ отозван");
    expect(root.textContent).toContain("switchboard invite client phone --qr");
    expect(relay.hellos).toHaveLength(1);
  });

  it("gate_unavailable — полоса «Нет связи», снова hello с паузой, затем roster", async () => {
    const relay = new FakeRelay(homeRoster());
    relay.refuse = ["gate_unavailable"];
    const { run } = await boot({ relay, pauseMs: 60 });
    expect(root.querySelector(".sb-off")!.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector(".sb-off")!.textContent).toMatch(/^Нет связи с relay · снова через 1 сСейчас$/);
    expect(run.stopped).toBeNull();
    await new Promise((r) => setTimeout(r, 90));
    await flush();
    expect(run.stopped).toBeNull();
    expect(relay.hellos).toHaveLength(2);
    expect(root.textContent).toContain("список");
    expect(root.querySelector(".sb-off")!.hasAttribute("hidden")).toBe(true);
  });

  it("обрыв: ждущий запрос — disconnected сразу; шапка «нет связи», «данные на ЧЧ:ММ»; после hello — link open", async () => {
    const log: string[] = [];
    const relay = new FakeRelay(homeRoster());
    const s = sample(log);
    await boot({ relay, parts: [s.part] });
    const p = s.app.request("answer", { callsign: "profiles@laptop", question: "q1", answers: {} });
    await flush(1);
    expect(relay.sent("answer")[0]).toMatchObject({ type: "answer", v: 1, callsign: "profiles@laptop" });
    relay.drop();
    expect(await p).toEqual({ ok: false, error: "disconnected" });
    await flush(1);
    expect(root.querySelector(".sb-pill")!.textContent).toBe("нет связи");
    expect(root.querySelector(".sb-bt span")!.textContent).toMatch(/^данные на \d\d:\d\d$/);
    await new Promise((r) => setTimeout(r, 20));
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
    expect(root.textContent).toContain("Список выключен");
    relay.push({ type: "question", from: "y@pc" });
    relay.setRoster(homeRoster());
    expect(log.filter((x) => x === "other roster")).toHaveLength(2);
    expect(log).not.toContain("question y@pc");
  });

  it("возможности по roster: имени нет в contract машины — unknown_request без кадра; Worker-модулю — to: push", async () => {
    const r = homeRoster();
    r.machines[1].contract = { message: 1 };
    const relay = new FakeRelay(r);
    relay.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl6" } });
    const { s } = await boot({ relay });
    expect(await s.app.request("answer", { callsign: "poe-bot@pc" })).toEqual({ ok: false, error: "unknown_request" });
    expect(relay.sent("answer")).toHaveLength(0);
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
  it("ждущий reply доходит, stop() модулей, close(1000); возвращение — start и hello", async () => {
    const log: string[] = [];
    const s = sample(log);
    const store = memoryStore({ key: KEY });
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => undefined;
    const { run } = await boot({ parts: [s.part], store, relay });
    const p = s.app.request("answer", { callsign: "profiles@laptop" });
    await flush(1);
    const hiding = run.hide();
    await flush();
    expect(log).not.toContain("stop sample");
    relay.reply(relay.sent("answer")[0].id!, { ok: true });
    await hiding;
    expect(await p).toEqual({ ok: true, result: undefined });
    expect(log).toContain("stop sample");
    expect(store.data.drafts).toEqual({ x: "черновик" });
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    await run.show();
    await flush();
    expect(log.filter((x) => x === "start sample")).toHaveLength(2);
    expect(relay.hellos).toHaveLength(2);
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
  });
});
