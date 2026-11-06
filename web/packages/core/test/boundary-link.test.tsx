// Леса ядра страницы, связь: relay машин, уход с экрана и возвращение, запросы и кадры.
// Вход — контракт web-core и стенд, исход — кадры, журнал и экран. Номер — эталон-источник; без номера — чьё: код.
import { describe, expect, it, vi } from "vitest";
import type { App, AppPart, ConnState } from "../contract.ts";
import { stand } from "../stand/app.ts";
import { FakeRelay, flush, homeRoster, KEY, oneMachine } from "../stand/relay.ts";
import { attrs, begin, man, mod, other, quiet, sample, shape } from "./kit.tsx";

quiet();

/** Модуль a с журналом on.link. */
function linked() {
  const seen: Array<[ConnState, string | undefined]> = [];
  const m = mod({ on: { link: (s, x) => void seen.push([s, x]), roster: () => {} } }, {}, { "roster@relay": 1 });
  return { ...m, seen, machines: () => seen.filter(([, x]) => x) };
}

describe("связь с relay", () => {
  it("gate_unavailable и обрыв — полоса «Нет связи», снова hello с паузой вдвое; принятый hello сбрасывает паузу", async () => {
    const pauses = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((x) => x.includes("оборвалась")).map((x) => /снова через (\d+) с/.exec(x)![1]);
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["gate_unavailable", "gate_unavailable"];
    vi.useFakeTimers();
    const { run, root } = begin([sample().part], { relay, options: { pauseMs: 1000 } });
    await vi.advanceTimersByTimeAsync(50);
    const off = () => root.querySelector<HTMLElement>(".sb-off")!;
    expect(off().hidden).toBe(false);
    expect(off().textContent).toMatch(/^Нет связи с relay · снова через 1 сСейчас$/);
    await vi.advanceTimersByTimeAsync(3300);
    expect(run.stopped).toBeNull();
    expect(relay.hellos).toHaveLength(3);
    expect(pauses()).toEqual(["1", "2"]);
    expect(root.textContent).toContain("список");
    expect(off().hidden).toBe(true);
    relay.drop();
    await vi.advanceTimersByTimeAsync(50);
    expect(pauses()).toEqual(["1", "2", "1"]);
    expect(root.querySelector(".sb-pill")!.textContent).toBe("нет связи");
    run.unmount();
  });

  it("обрыв: ждущий запрос — disconnected сразу; шапка «нет связи», «данные на ЧЧ:ММ»; после hello — link open", async () => {
    const log: string[] = [];
    const s = sample(log);
    const relay = new FakeRelay(homeRoster());
    const t = await stand([s.part], { relay, pauseMs: 60 });
    const p = s.box.app.request("answer", { callsign: "profiles@laptop", question: "q1", answers: {} });
    await flush(1);
    expect(relay.sent("answer")[0]).toMatchObject({ type: "answer", v: 1, callsign: "profiles@laptop" });
    relay.drop();
    expect(await p).toEqual({ ok: false, error: "disconnected" });
    expect(await s.box.app.request("answer", { callsign: "profiles@laptop" })).toEqual({ ok: false, error: "disconnected" });
    expect(relay.sent("answer")).toHaveLength(1);
    await flush(1);
    expect(t.$(".sb-pill")!.textContent).toBe("нет связи");
    expect(t.$(".sb-bt span")!.textContent).toMatch(/^данные на \d\d:\d\d$/);
    await new Promise((r) => setTimeout(r, 120));
    await flush();
    expect(log.filter((x) => x.startsWith("link") && !x.includes("@"))).toEqual(["link open", "link closed", "link connecting", "link open"]);
  });

  it("4006 · 7280 · keys.list пуст: связь открыта, roster пуст, страница доходит до экрана", async () => {
    // источник: отчёт архитектора, ошибка 1 — без машин до «Настроек» и приглашения машины не добраться
    const s = linked();
    const t = await stand([s.part], { relay: new FakeRelay(homeRoster({ machines: [], sessions: [], clients: [] })) });
    await flush(10);
    expect(t.$('[data-s="a"]')).not.toBeNull();
    expect(t.$(".sb-off")!.hidden).toBe(true);
    expect(s.box.app.link()).toBe("open");
    expect(s.box.app.roster()!.machines).toEqual([]);
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
    const s = linked();
    const t = await stand([s.part], { relay, pauseMs: 20, options: { fetch: fetchFleet } });
    await flush(10);
    expect(t.$(".sb-off")!.hidden).toBe(false);
    expect(t.$(".sb-off")!.textContent).toContain("Нет связи");
    expect(s.box.app.link()).toBe("closed");
    down = false;
    // пауза растёт вдвое: срок попытки не задан, ждём исход с пределом
    for (const end = Date.now() + 3000; !t.$(".sb-off")!.hidden && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 20));
      await flush(1);
    }
    expect(t.$(".sb-off")!.hidden).toBe(true);
    expect(t.$('[data-s="a"]')).not.toBeNull();
  });

  it("4009 · «Сейчас» на полосе — новый hello сразу, прежнее закрыто 1000 now без экрана отказа", async () => {
    const relay = new FakeRelay(oneMachine());
    const t = await stand([sample().part], { relay, pauseMs: 60_000 });
    relay.drop();
    await flush();
    expect(t.$(".sb-off")!.hidden).toBe(false);
    await t.click(t.button("Сейчас"));
    expect(relay.hellos).toHaveLength(2);
    expect(t.run.stopped).toBeNull();
    expect(t.$(".sb-off")!.hidden).toBe(true);
  });

  it("4010 · отказ hello до первого roster — полоса «Нет связи» на экране подключения", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["gate_unavailable"];
    const t = await stand([sample().part], { relay, pauseMs: 60_000 });
    expect(t.root.textContent).toContain("подключаюсь · hello");
    expect(t.$(".sb-off")!.hidden).toBe(false);
    expect(t.$(".sb-off")!.textContent).toMatch(/^Нет связи с relay · снова через \d+ сСейчас$/);
  });

  it("полоса в широком виде: данные на ЧЧ:ММ; срок вышел, а связи всё нет — «подключаюсь»; разметка полосы и лампы", async () => {
    const relay = new FakeRelay(oneMachine());
    let made = 0;
    const hang = class extends relay.WebSocket {
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
    const down = new FakeRelay(homeRoster());
    const u = await stand([mod().part], { relay: down, wide: true, pauseMs: 60_000 });
    down.drop();
    await flush();
    expect(shape(u.$(".sb-off")!)).toEqual(["span.", "button.sb-tx"]);
    expect(u.$(".sb-off button")!.getAttribute("type")).toBe("button");
    expect(attrs(u.$(".sb-brand .sb-pill")!)).toMatchObject({ class: "sb-pill bad conn", title: "нет связи", "aria-label": "нет связи" });
    expect(u.$(".sb-brand .sb-pill")!.textContent).toBe("");
  });

  it("отказ relay без слова: причина «без причины», приложение остановлено; остановка закрывает остальные соединения", async () => {
    const relay = new FakeRelay(homeRoster());
    const t = await stand([mod().part], { relay });
    relay.socks[0].serverClose(1008, "");
    await flush();
    expect(t.run.stopped).toBe("");
    expect(t.$(".sb-full")!.textContent).toContain("relay закрыл соединение: без причины.");
    expect(relay.socks[1].closedWith).toMatchObject({ code: 1000 });
  });
});

describe("машины флота", () => {
  it("5105 · соединение с relay каждой машины; relay laptop упал — сессии pc на экране и запросы к ним работают; вернулась — on.link с машиной", async () => {
    const relay = new FakeRelay(homeRoster());
    const log: string[] = [];
    const s = sample(log);
    const t = await stand([s.part], { relay, pauseMs: 5 });
    expect(relay.socks.map((x) => x.url).sort()).toEqual(["wss://relay.test/m/laptop", "wss://relay.test/m/pc"]);
    expect(s.box.app.roster()!.sessions.map((x) => x.callsign).sort()).toEqual(["poe-bot@pc", "profiles@laptop", "site@laptop", "wiki@pc"]);
    log.length = 0;
    relay.socks.find((x) => x.url.endsWith("/m/laptop"))!.serverClose(1006, "");
    await flush();
    expect(s.box.app.link()).toBe("open");
    expect(t.run.stopped).toBeNull();
    relay.handlers.answer = () => ({ ok: true, result: { done: 1 } });
    expect(await s.box.app.request("answer", { callsign: "poe-bot@pc", question: "q1" })).toEqual({ ok: true, result: { done: 1 } });
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(log.filter((x) => x.startsWith("link"))).toEqual(["link open @laptop"]);
  });

  it("6821 · 7283 · новый since — on.link open с машиной; пришла новая машина — тоже; смена только сессий и первый roster — молчит", async () => {
    // источник: отчёт архитектора, логика 1 — одно место вместо четырёх; гейт архитектора — лишняя коммуникация
    const s = linked();
    const relay = new FakeRelay(homeRoster());
    await stand([s.part], { relay });
    await flush(10);
    relay.setRoster(homeRoster({ sessions: [] }));
    await flush(10);
    expect(s.machines()).toEqual([]);
    const r = homeRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 1 } : m)) });
    await flush(10);
    expect(s.machines()).toEqual([["open", "pc"]]);
    const gone = homeRoster();
    relay.setRoster({ ...gone, machines: gone.machines.filter((m) => m.machine !== "pc") });
    await flush(10);
    relay.setRoster(gone);
    await flush(10);
    expect(s.machines()).toEqual([["open", "pc"], ["open", "pc"]]);
  });
});

describe("уход с экрана", () => {
  /** Сменить видимость страницы и сказать об этом. */
  const visible = (v: string) => {
    Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("вкладка скрылась и вернулась: stop, close 1000 hidden; on.show, start один раз, hello с тем же ключом, link open", async () => {
    const log: string[] = [];
    const relay = new FakeRelay(oneMachine());
    await stand([sample(log).part], { relay });
    try {
      visible("hidden");
      await flush();
      expect(log.filter((x) => x === "stop sample")).toHaveLength(1);
      expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
      visible("visible");
      await flush();
      expect(log.filter((x) => x === "start sample")).toHaveLength(1);
      expect(log.filter((x) => x === "show sample")).toHaveLength(1);
      expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }, { type: "hello", key: KEY, proto: 1 }]);
      expect(log.slice(log.lastIndexOf("show sample"))).toContain("link open");
    } finally {
      visible("visible");
    }
  });

  it("4026 · stop модуля бросил — он выключен, остальные остановлены, соединение закрыто 1000", async () => {
    const log: string[] = [];
    const s = sample(log, {
      stop() {
        throw new Error("не дописал");
      },
    });
    const relay = new FakeRelay(oneMachine());
    const t = await stand([s.part, other(log).part], { relay });
    await t.run.hide();
    expect(t.run.failed.sample).toContain("упал на остановке");
    expect(log).toContain("stop other");
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
  });

  it("4027 · страница открылась скрытой — связи нет до показа", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      const relay = new FakeRelay(oneMachine());
      const t = await stand([sample().part], { relay });
      expect(relay.socks).toHaveLength(0);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await t.run.show();
      await flush();
      expect(relay.hellos).toHaveLength(1);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("4028 · pagehide после hidden — остановка одна", async () => {
    const log: string[] = [];
    const t = await stand([sample(log).part]);
    const a = t.run.hide();
    window.dispatchEvent(new Event("pagehide"));
    await a;
    await t.run.hide();
    expect(log.filter((x) => x === "stop sample")).toHaveLength(1);
  });

  // источник: слово пользователя 3 нояб. — «мигание, когда перезаходишь на уже открытую вкладку… стабильно, если свернуть и
  // развернуть окно хрома»: после возвращения экран не видит флот, собранный не до конца
  it("4033 · возвращение на экран: roster и «на связи» — когда ответили все машины, без промежуточного неполного", async () => {
    const log: string[] = [];
    const t = await stand([sample(log).part]);
    await flush(10);
    expect(t.root.textContent).toContain("список 4");
    await t.run.hide();
    log.length = 0;
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(t.$('[data-screen="list"]')?.textContent ?? ""));
    watch.observe(t.root, { subtree: true, childList: true, characterData: true });
    await t.run.show();
    await flush(10);
    watch.disconnect();
    expect(t.relay.open).toHaveLength(2);
    expect(log.filter((x) => x.startsWith("roster"))).toEqual(["roster 4"]);
    expect(log.filter((x) => x.startsWith("link"))).toEqual(["link open"]);
    expect(seen.filter((x) => x && x !== "список 4")).toEqual([]);
  });

  it("4034 · машина не ответила при возвращении — её соединение закрылось, остальные видны", async () => {
    const log: string[] = [];
    const t = await stand([sample(log).part]);
    await flush(10);
    await t.run.hide();
    log.length = 0;
    t.relay.refuse = ["", "gate_unavailable"];
    await t.run.show();
    await flush(10);
    expect(log.filter((x) => x.startsWith("link") && !x.includes("@"))).toEqual(["link open"]);
    // pc закрылся — флот собран: видна laptop; pc вернулся своим переподключением — снова все
    expect(log.filter((x) => x.startsWith("roster"))[0]).toBe("roster 2");
  });

  it("вернулись, ушли и снова вернулись, пока уход ждёт запрос: одно новое соединение, один on.show", async () => {
    // источник: чьё: код — второе соединение осиротело бы: уход закрывает только последнее, прежнее живёт и переподключается
    let shows = 0;
    const relay = new FakeRelay(oneMachine());
    relay.handlers.ask = () => undefined as never;
    const m = mod({ on: { show: () => void shows++ } }, {}, { "ask@x": 1 });
    await stand([m.part], { relay });
    void m.box.app.request("ask", { callsign: "site@laptop" });
    await flush();
    try {
      visible("hidden");
      visible("visible");
      visible("hidden");
      visible("visible");
      await flush();
      relay.reply(relay.sent("ask")[0].id as string, { ok: true });
      await flush(10);
      expect(shows).toBe(1);
      expect(relay.hellos).toHaveLength(2);
      expect(relay.open).toHaveLength(1);
    } finally {
      visible("visible");
    }
  });

  it("возвращение на экран: пока связь собирается — без красной лампы и старых данных; модуль в on.show видит connecting", async () => {
    // источник: слово пользователя 3 нояб. о мигании при возвращении на вкладку; чьё: код — уход ставил connecting
    const links: string[] = [];
    const s = sample([], { on: { show: () => void links.push(s.box.app.link()) } });
    const relay = new FakeRelay(oneMachine());
    let held = false;
    let go = () => {};
    const fetchHeld = (async (url: string, init?: RequestInit) => {
      if (held) await new Promise<void>((r) => (go = r));
      return relay.fetch(url, init);
    }) as typeof fetch;
    const t = await stand([s.part], { relay, options: { fetch: fetchHeld } });
    await flush(10);
    const pill = () => t.$(".sb-bar .sb-pill")!.textContent;
    expect(pill()).toBe("на связи");
    await t.run.hide();
    held = true;
    await t.run.show();
    await flush();
    expect(links).toEqual(["connecting"]);
    expect(pill()).not.toBe("нет связи");
    expect(t.$(".sb-bt")!.textContent).not.toContain("данные на");
    held = false;
    go();
    await flush(10);
    expect(pill()).toBe("на связи");
  });

  it("4029 · после отказа relay возвращение на экран не подключает", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = ["revoked"];
    const log: string[] = [];
    const t = await stand([sample(log).part], { relay });
    await flush(10);
    await t.run.hide();
    await t.run.show();
    await flush(10);
    expect(relay.hellos).toHaveLength(1);
    expect(log.filter((x) => x === "start sample")).toHaveLength(1);
    expect(t.root.textContent).toContain("Пропуск отозван");
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

  it("после ухода: запрос — disconnected, кадра нет; адрес от gate прежний", async () => {
    const relay = new FakeRelay(oneMachine());
    const m = mod({}, {}, { "ask@x": 1 });
    const t = await stand([m.part], { relay });
    await t.run.hide();
    expect(await m.box.app.request("ask", { callsign: "site@laptop" })).toEqual({ ok: false, error: "disconnected" });
    expect(relay.sent("ask")).toEqual([]);
    expect(m.box.app.address()).toBe("phone~owner@example.com");
  });
});

describe("запросы", () => {
  const asking = async (answer: (f: Record<string, unknown>) => { ok: true; result?: unknown } | { ok: false; error: string; why?: string }) => {
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = answer;
    const t = await stand([s.part], { relay });
    return { app: s.box.app, relay, run: t.run };
  };

  it("4016 · 4194 · запрос к Host: кадр с v и callsign, reply ok — результат; версия, названная в вызове, — как есть, не названа — из uses", async () => {
    // источник: чьё: код (ядро Host: названная — как есть, иначе из uses/provides); слепое расширение 2 нояб. — веб перезаписывал названную
    const t = await asking(() => ({ ok: true, result: { done: 1 } }));
    expect(await t.app.request("answer", { callsign: "profiles@laptop", question: "q1" })).toEqual({ ok: true, result: { done: 1 } });
    expect(t.relay.sent("answer")).toEqual([{ type: "answer", v: 1, callsign: "profiles@laptop", question: "q1", id: expect.any(String) }]);
    await t.app.request("answer", { callsign: "profiles@laptop", v: 2 });
    expect(t.relay.sent("answer").map((f) => f.v)).toEqual([1, 2]);
  });

  it("4018 · 4019 · E21 · отказ владельца и отказ машины не из roster — слово и why модулю, ядро не бросает, модуль не выключен", async () => {
    // факт: так отвечают службы флота; нужно экрану, чтобы показать имя слота в отказе
    const t = await asking(() => ({ ok: false, error: "no_reserve", why: "слот main: нет запаса" }));
    const want = { ok: false, error: "no_reserve", why: "слот main: нет запаса" };
    expect(await t.app.request("answer", { callsign: "profiles@laptop" })).toEqual(want);
    expect(await t.app.read("answer", { callsign: "profiles@laptop" })).toEqual(want);
    expect(await t.app.request("answer", { callsign: "x@mac" })).toEqual(want);
    expect(t.relay.sent("answer").at(-1)).toMatchObject({ callsign: "x@mac", v: 1 });
    expect(t.run.failed).toEqual({});
  });

  it("E1 · app.read молчит — timeout на 10 с; app.request в это время ждёт", async () => {
    // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»
    const s = sample();
    const relay = new FakeRelay(homeRoster());
    relay.handlers.answer = () => undefined as never;
    await stand([s.part], { relay });
    vi.useFakeTimers();
    let read = "";
    let act = "";
    void s.box.app.read("answer", { callsign: "profiles@laptop" }).then((r) => (read = r.ok ? "ok" : r.error));
    void s.box.app.request("answer", { callsign: "profiles@laptop" }).then((r) => (act = r.ok ? "ok" : r.error));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toBe("timeout");
    expect(act).toBe("");
  });

  it("Worker-модулю — to: .push и v из uses; имя и версию проверяет получатель", async () => {
    const s = sample();
    const relay = new FakeRelay(homeRoster());
    relay.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl6" } });
    await stand([s.part], { relay });
    expect(await s.box.app.request("push.key")).toEqual({ ok: true, result: { key: "BEl6" } });
    expect(relay.sent("push.key")[0]).toMatchObject({ type: "push.key", v: 1, to: ".push" });
  });

  it("запрос к имени не из uses — ошибка модуля", async () => {
    const s = sample();
    const t = await stand([s.part]);
    expect(await s.box.app.request("session.stop", { callsign: "site@laptop" })).toEqual({ ok: false, error: "module_error" });
    expect(t.run.failed.sample).toContain("session.stop нет в uses");
  });
});

describe("кадры", () => {
  it("кадр — модулю по type; ошибка модуля выключает его, экран показывает причину, roster идёт дальше", async () => {
    const log: string[] = [];
    const s = sample(log);
    const neighbour: AppPart = { manifest: man("other", {}, { "roster@relay": 1 }), module: () => ({ on: { roster: () => log.push("other roster") } }) };
    const relay = new FakeRelay(oneMachine());
    const t = await stand([s.part, neighbour], { relay });
    relay.push({ type: "question", from: "profiles@laptop" });
    expect(log).toContain("question profiles@laptop");
    relay.push({ type: "question", from: "x@pc", boom: true });
    expect(t.run.failed.sample).toBe("Модуль sample упал на кадре question: TypeError: boom");
    await flush();
    expect(t.root.textContent).toContain("Список выключен");
    log.length = 0;
    relay.push({ type: "question", from: "y@pc" });
    relay.setRoster(homeRoster());
    expect(log.filter((x) => x === "other roster")).toHaveLength(1);
    expect(log).not.toContain("question y@pc");
  });

  it("запрос без владельца — reply unknown_request отправителю; поздний ответ и кадр без id без ответа: кадр — с предупреждением", async () => {
    const relay = new FakeRelay(oneMachine());
    const t = await stand([sample().part], { relay });
    relay.push({ type: "who", id: "r-1", from: "site@laptop" });
    expect(relay.got.at(-1)).toMatchObject({ type: "reply", id: "r-1", ok: false, error: "unknown_request", to: "site@laptop" });
    const before = relay.got.length;
    relay.push({ type: "reply", id: "late", ok: true, from: "site@laptop" });
    relay.push({ type: "nobody" });
    await flush();
    expect(relay.got).toHaveLength(before);
    expect(console.warn).toHaveBeenCalledWith("switchboard: кадр nobody — владельца в приложении нет");
    expect(t.run.failed).toEqual({});
  });

  it("deliver: кадр владельцу с ctx open; без владельца — предупреждение", async () => {
    const got: Array<[string, boolean]> = [];
    const m = mod({ frames: { ping: (f, c) => void got.push([String(f.from), c.open]) } }, {}, { "ping@x": 1 });
    await stand([m.part], { roster: oneMachine() });
    m.box.app.deliver({ type: "ping", from: "a" }, { open: true });
    m.box.app.deliver({ type: "ping", from: "b" });
    expect(got).toEqual([["a", true], ["b", false]]);
    m.box.app.deliver({ type: "nobody" });
    expect(console.warn).toHaveBeenCalledWith("switchboard: кадр nobody — владельца в приложении нет");
  });
});
