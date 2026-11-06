// Леса ядра страницы, вход: набор модулей, пропуск и приглашение, экраны остановки, платформа, сборка, хранилище.
// Вход — контракт web-core и стенд, исход — кадры, адрес, хранилище и экран. Номер — эталон-источник; без номера — чьё: код.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { appGate, idbStore, memoryStore, startBuild, type AppModule, type AppPart, type BuildList } from "../contract.ts";
import { defined, stand } from "../stand/app.ts";
import { FakeRelay, flush, homeRoster, INVITE, KEY, oneMachine } from "../stand/relay.ts";
import { attrs, begin, man, mod, other, quiet, reloads, sample, shape } from "./kit.tsx";

quiet();
const [NUMBER, SECRET] = INVITE.split(".");
const part = (name: string, provides: Record<string, number>, uses: Record<string, number>, m: AppModule): AppPart => ({ manifest: man(name, provides, uses), module: () => m });

describe("гейт набора", () => {
  it.each<[string, AppPart[], string[]]>([
    ["экран не из provides, кадр не из uses, uses другой версии", [sample().part, part("bad", {}, { "list@sample": 2 }, { screens: { x: { view: () => null } }, frames: { answered: () => {} } })], ["модуль bad: экрана x нет в provides", "модуль bad: кадр answered нет в uses", "модуль bad: uses list@sample v2 — у владельца v1"]],
    ["метка экрана не из marks, on.roster без roster@relay, раздел у двух", [sample().part, part("bad2", { y: 1 }, {}, { screens: { y: { mark: "cnt", view: () => null } }, on: { roster: () => {} }, store: ["drafts"] })], ["модуль bad2: экран y — метки cnt нет в marks", "модуль bad2: on.roster без roster@relay в uses", "имя store.drafts: два владельца — sample и bad2"]],
    ["раздел ядра key — занят", [part("t", {}, {}, { store: ["key"] })], ["имя store.key: два владельца — web-core и t"]],
    ["команда и метка не из provides", [part("x", {}, {}, { commands: { c: { run: () => {} } }, marks: { z: () => 1 } })], ["модуль x: команды c нет в provides", "модуль x: метки z нет в provides"]],
    ["место команды и экрана не из uses", [part("y", { d: 1, e: 1 }, {}, { commands: { d: { place: "o.tab", run: () => {} } }, screens: { e: { place: "o.tab", view: () => null } } })], ["модуль y: экран e — места o.tab нет в uses", "модуль y: команда d — места o.tab нет в uses"]],
  ])("%s", (_n, parts, want) => {
    expect(appGate(defined(parts))).toEqual(want);
  });

  it("кадр с двумя принимающими — приложение не стартует, связи нет, причина на экране", async () => {
    const a = sample().part;
    const dupe = part("dupe", {}, { "question@host-questions": 1 }, { frames: { question: () => {} } });
    expect(appGate(defined([a, dupe]))).toContain("имя question: два владельца — sample и dupe");
    const t = await stand([a, dupe]);
    expect(t.run.stopped).toBe("gate");
    expect(t.root.textContent).toContain("Приложение не стартует");
    expect(t.$(".sb-errs")!.textContent).toContain("question: два владельца");
    expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-ring.bad", "div.sb-big", "ul.sb-errs"]);
    expect(t.relay.socks).toHaveLength(0);
  });
});

describe("пропуск и приглашение", () => {
  const invited = (roster = oneMachine()) => {
    const relay = new FakeRelay(roster);
    relay.handlers["gate.redeem"] = (f) => (f.invite === INVITE ? { ok: true, result: { key: KEY } } : { ok: false, error: "bad_invite" });
    return relay;
  };
  const paste = async (t: Awaited<ReturnType<typeof stand>>, value: string) => {
    t.$<HTMLInputElement>(".sb-keyin")!.value = value;
    await t.click(t.button("Принять приглашение"));
    await flush();
  };

  it("5101 · #invite → POST gate.redeem; пропуск в хранилище; адрес очищен; hello с ним; roster — экран раздела", async () => {
    const store = memoryStore();
    const relay = invited();
    const t = await stand([sample().part], { relay, store, url: `/#invite=${INVITE}` });
    expect(relay.sent("gate.redeem").map((f) => f.invite)).toEqual([INVITE]);
    expect(store.data.key).toBe(KEY);
    expect(location.hash).toBe("");
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(relay.socks.every((s) => !s.url.includes("k2a9"))).toBe(true);
    expect(t.$(".sb-bt b")!.textContent).toBe("Флот");
    expect(t.$(".sb-pill")!.textContent).toBe("на связи");
    expect(t.root.textContent).toContain("список");
  });

  it.each([
    ["одна машина", oneMachine(), "Вы во флоте: laptop на связи, 2 сессии."],
    ["две машины", homeRoster(), "Вы во флоте: laptop и pc на связи, 4 сессии."],
    ["пустой флот", homeRoster({ machines: [], sessions: [], clients: [] }), "Вы во флоте: машин нет на связи, 0 сессий."],
  ])("приглашение принято, %s: слова про флот", async (_n, roster, text) => {
    const t = await stand([mod().part], { relay: invited(roster), store: memoryStore(), url: `/#invite=${INVITE}` });
    expect(t.$(".sb-toast.ok")!.textContent).toBe(text);
  });

  it("5102 · iPhone вне экрана «Домой»: экран установки, приглашение не погашено и ждёт в адресе, связи нет", async () => {
    const store = memoryStore();
    const relay = invited();
    const t = await stand([sample().part], { relay, store, ios: true, url: `/#invite=${INVITE}` });
    expect(relay.sent("gate.redeem")).toEqual([]);
    expect(t.run.stopped).toBe("install");
    const text = t.$(".sb-full")!.textContent!;
    expect(text).toContain("Добавьте Switchboard на экран «Домой»");
    expect(text).toContain("На iPhone уведомления приходят только приложению с экрана «Домой».");
    expect(text).toContain(`Приглашение ${NUMBER} ждёт в адресе страницы до установки.`);
    expect(text).not.toContain(SECRET);
    expect(t.$$(".sb-ol li").map((li) => li.textContent)).toEqual(["Нажмите «Поделиться» внизу", "«На экран „Домой“»", "Откройте Switchboard с экрана «Домой»"]);
    expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-logo.xl", "div.sb-big", "p.", "ol.sb-ol", "p."]);
    expect(location.hash).toBe(`#invite=${INVITE}`);
    expect(store.data.key).toBeUndefined();
    expect(relay.socks).toHaveLength(0);
  });

  it("нет пропуска — экран «Нужен пропуск флота», связи нет; широкий вид просит имя устройства", async () => {
    const t = await stand([mod().part], { store: memoryStore() });
    expect(t.run.stopped).toBe("no_key");
    expect(t.relay.socks).toHaveLength(0);
    const text = t.$(".sb-full")!.textContent!;
    expect(text).toContain("Нужен пропуск флота");
    expect(text).toContain("keys.invite client phone <почта>");
    expect(text).toContain("Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:");
    expect(text).toContain("Или вставьте приглашение:");
    expect(t.$<HTMLInputElement>(".sb-keyin")!.placeholder).toBe("приглашение или ссылка с #invite=");
    expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-logo.xl", "div.sb-big", "p.", "code.sb-cmd", "p.", "input.sb-in.sb-keyin", "button.sb-cta", "p."]);
    expect(attrs(t.$(".sb-keyin")!)).toMatchObject({ type: "text", "aria-label": "Приглашение" });
    const w = await stand([mod().part], { store: memoryStore(), wide: true });
    expect(w.$(".sb-full")!.textContent).toContain("keys.invite client <имя> <почта>");
  });

  it("5197 · iPhone, повторный запуск с экрана «Домой»: в адресе то же приглашение, пропуск из него уже в хранилище — gate не спрашивается, hello с пропуском, адрес очищен", async () => {
    // источник: живой прогон прода 3 нояб. — второй запуск иконки с #invite= давал «Приглашение не принято»
    const had = `client.phone.${NUMBER}.Vt5sig`;
    const t = await stand([sample().part], { roster: oneMachine(), store: memoryStore({ key: had }), ios: true, standalone: true, url: `/#invite=${INVITE}` });
    expect(t.relay.sent("gate.redeem")).toEqual([]);
    expect(t.relay.hellos).toEqual([{ type: "hello", key: had, proto: 1 }]);
    expect(location.hash).toBe("");
    expect(t.run.stopped).toBeNull();
  });

  it("5198 · «Стереть данные приложения» на экранах отказа: хранилище пусто, адрес без приглашения, перезагрузка", async () => {
    // источник: слово пользователя 3 нояб. — «кнопки зачистки на страницы ошибки на телефоне, чтоб удалить сохранённый профиль»
    const reload = reloads();
    const store = memoryStore({ pushes: [1] });
    const relay = new FakeRelay(oneMachine());
    relay.handlers["gate.redeem"] = () => ({ ok: false, error: "bad_invite" });
    const t = await stand([sample().part], { relay, store, url: `/#invite=${INVITE}` });
    expect(t.root.textContent).toContain("Приглашение не принято");
    await t.click(t.$("[data-act=wipe]"));
    expect(store.data).toEqual({});
    expect(location.hash).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);

    const s2 = memoryStore({ key: KEY });
    const r2 = new FakeRelay(oneMachine());
    r2.refuse = ["revoked"];
    const u = await stand([sample().part], { relay: r2, store: s2 });
    await flush(20);
    await u.click(u.$("[data-act=wipe]"));
    expect(s2.data).toEqual({});
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("4003 · ключ из хранилища при повторном входе — hello с ним, без тоста «Вы во флоте»", async () => {
    const t = await stand([sample().part], { roster: oneMachine() });
    expect(t.relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(t.$<HTMLElement>(".sb-toast")!.hidden).toBe(true);
  });

  it("4004 · 5104 · приглашение вставлено вручную — принято у gate, пропуск в хранилище, перезагрузка", async () => {
    const reload = reloads();
    const store = memoryStore();
    const t = await stand([sample().part], { relay: invited(), store });
    await paste(t, `https://switchboard-phone.test/#invite=${INVITE}`);
    expect(store.data.key).toBe(KEY);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["не приглашение", "hello", "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=."],
    ["негодное экранирование", "abc%", "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=."],
    ["отказ gate", `#invite=${INVITE}x`, "Приглашение не принято: bad_invite."],
  ])("4005 · вставлено: %s — отказ словами, хранилище не тронуто", async (_n, value, word) => {
    const store = memoryStore();
    const t = await stand([sample().part], { relay: invited(), store });
    await paste(t, value);
    expect(t.$('[role="alert"]')!.textContent).toBe(word);
    expect(store.data.key).toBeUndefined();
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
    expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-ring.bad", "div.sb-big", "p.", "button.sb-cta"]);
    expect(t.$(".sb-cta")!.getAttribute("data-act")).toBe("wipe");
    expect(location.hash).toBe("");
    expect(relay.socks).toHaveLength(0);
  });

  it("gate не отвечает на приём приглашения: сеть упала — gate_unavailable; молчит — через 30 с то же", async () => {
    const down = await stand([mod().part], { store: memoryStore(), url: `/#invite=${INVITE}`, options: { fetch: (() => Promise.reject(new Error("нет сети"))) as never } });
    expect(down.run.stopped).toBe("gate_unavailable");
    vi.useFakeTimers();
    const { run } = begin([mod().part], { store: memoryStore(), url: `/#invite=${INVITE}`, options: { fetch: (() => new Promise(() => {})) as never } });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run.stopped).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.stopped).toBe("gate_unavailable");
  });

  describe("чужое приглашение при имеющемся пропуске", () => {
    const OTHER = "client.phone.q7w1.Zzsig";
    const open = async (answer: () => { ok: true; result: { key: string } } | { ok: false; error: string } = () => ({ ok: true, result: { key: OTHER } })) => {
      const relay = new FakeRelay(oneMachine());
      relay.handlers["gate.redeem"] = answer;
      const store = memoryStore({ key: KEY });
      return { ...(await stand([mod().part], { relay, store, url: `/#invite=${INVITE}` })), relay, store, reload: reloads() };
    };

    it("6760 · связи нет, gate не тронут, пропуск прежний, адрес чист, спрашиваем человека", async () => {
      const t = await open();
      expect(t.run.stopped).toBe("replace");
      expect(t.relay.sent("gate.redeem")).toEqual([]);
      expect(t.store.data.key).toBe(KEY);
      expect(t.relay.socks).toHaveLength(0);
      expect(location.hash).toBe("");
      expect(t.root.textContent).toContain("Заменить пропуск этого устройства?");
      expect(t.$(".sb-full")!.textContent).toContain(`Ссылка несёт приглашение ${NUMBER}. Сейчас устройство входит пропуском client.phone.k2a9. Заменяйте, только если сами просили эту ссылку.`);
      expect(t.root.textContent).not.toContain(SECRET);
      expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-ring.wait", "div.sb-big", "p.", "button.sb-cta", "button.sb-b", "p."]);
      expect(t.$(".sb-ring")!.textContent).toBe("?");
      expect(t.$$("button").map((b) => b.getAttribute("data-act"))).toEqual(["replace", "keep"]);
    });

    it("6761 · «Заменить пропуск»: gate.redeem, новый пропуск, перезагрузка", async () => {
      const t = await open();
      await t.click(t.button("Заменить пропуск"));
      await flush();
      expect(t.relay.sent("gate.redeem").map((f) => f.invite)).toEqual([INVITE]);
      expect(t.store.data.key).toBe(OTHER);
      expect(t.reload).toHaveBeenCalledOnce();
    });

    it("6762 · «Оставить текущий»: приглашение не гасится, пропуск прежний, перезагрузка", async () => {
      const t = await open();
      await t.click(t.button("Оставить текущий"));
      expect(t.relay.sent("gate.redeem")).toEqual([]);
      expect(t.store.data.key).toBe(KEY);
      expect(t.reload).toHaveBeenCalledOnce();
    });

    it("6763 · отказ gate при замене: причина словами, пропуск прежний, без перезагрузки", async () => {
      const t = await open(() => ({ ok: false, error: "bad_invite" }));
      await t.click(t.button("Заменить пропуск"));
      await flush();
      expect(t.$('[role="alert"]')!.textContent).toBe("Приглашение не принято: bad_invite.");
      expect(t.store.data.key).toBe(KEY);
      expect(t.reload).not.toHaveBeenCalled();
    });
  });
});

describe("экраны остановки", () => {
  const refused = (word: string, key = KEY, wide?: boolean) => {
    const relay = new FakeRelay(oneMachine());
    relay.refuse = [word];
    return { relay, store: memoryStore({ key }), wide };
  };

  it.each([
    ["5103 revoked", "revoked", refused("revoked"), ["Пропуск отозван", "client.phone.k2a9 больше не принимают. Новый пропуск — приглашением от агента флота:", "keys.invite client phone <почта>", "Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.", "Стереть данные приложения"], ["div.sb-ring.bad", "div.sb-big", "p.", "code.sb-cmd", "p.", "button.sb-cta"], "×", "wipe"],
    ["5103 bad_key, широкий вид", "bad_key", refused("bad_key", "client.panel-desk.k3f1.Qa7sig", true), ["Пропуск не принят", "client.panel-desk.k3f1 не принят флотом. Новый пропуск — приглашением от агента флота:", "keys.invite client panel-desk <почта>"], ["div.sb-ring.bad", "div.sb-big", "p.", "code.sb-cmd", "p.", "button.sb-cta"], "×", "wipe"],
    ["4007 contract_mismatch", "contract_mismatch", refused("contract_mismatch"), ["Приложение устарело", "У приложения proto 1; relay эту версию не принял — его обновили, пока приложение было открыто.", "Перезагрузить"], ["div.sb-ring.wait", "div.sb-big", "p.", "button.sb-cta"], "↻", null],
    ["4008 прочий отказ relay", "replaced", refused("replaced"), ["Связь остановлена", "relay закрыл соединение: replaced.", "Перезагрузить"], ["div.sb-ring.bad", "div.sb-big", "p.", "button.sb-cta"], "×", null],
  ])("%s: причина, текст, разметка, второго hello нет, разделов нет", async (_n, why, o, want, kids, ring, act) => {
    const t = await stand([mod().part], o);
    await flush(20);
    expect(t.run.stopped).toBe(why);
    for (const s of want) expect(t.$(".sb-full")!.textContent).toContain(s);
    expect(shape(t.$(".sb-view")!)).toEqual(["div.sb-full"]);
    expect(shape(t.$(".sb-full")!)).toEqual(kids);
    expect(t.$(".sb-ring")!.textContent).toBe(ring);
    expect(t.$(".sb-cta")!.getAttribute("data-act")).toBe(act);
    expect(t.$(".sb-cta")!.hasAttribute("type")).toBe(false);
    expect(o.relay.hellos).toHaveLength(1);
    expect(t.$<HTMLElement>(".sb-navcol")!.hidden).toBe(true);
    expect(t.$<HTMLElement>(".sb-bar")!.hidden).toBe(true);
    expect(t.$<HTMLElement>(".sb-off")!.hidden).toBe(true);
  });

  it("браузер без @scope — экран «Браузер устарел», модули не стартуют, стилей модулей нет", async () => {
    const started = vi.fn();
    const t = await stand([{ manifest: man("m"), module: () => ({ start: started, css: ".z{}" }) }], { options: { platform: { ios: false, standalone: false, scope: false } } });
    expect(t.run.stopped).toBe("browser");
    expect(t.$(".sb-full")!.textContent).toContain("Браузер устарел");
    expect(t.$(".sb-full")!.textContent).toContain("Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.");
    expect(shape(t.$(".sb-full")!)).toEqual(["div.sb-ring.wait", "div.sb-big", "p."]);
    expect(started).not.toHaveBeenCalled();
    expect(t.root.querySelector("style")!.textContent).not.toContain("@scope");
  });

  it("экран подключения: номер пропуска, после приглашения — «Ключ сохранён»; unmount очищает страницу", async () => {
    const relay = new FakeRelay(oneMachine());
    relay.handlers["gate.redeem"] = () => ({ ok: true, result: { key: KEY } });
    const { run, root } = begin([mod().part], { relay, store: memoryStore(), url: `/#invite=${INVITE}` });
    await run.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(".sb-big")!.textContent).toBe("Ключ сохранён");
    expect(root.querySelector(".sb-k")!.textContent).toBe("client.phone.k2a9");
    expect(root.querySelector(".sb-full p")!.textContent).toBe("подключаюсь · hello");
    run.unmount();
    expect(root.innerHTML).toBe("");
    const again = begin([mod().part]);
    await again.run.ready;
    expect(shape(again.root.querySelector(".sb-full")!)).toEqual(["div.sb-logo.xl", "span.sb-k", "p."]);
    await flush();
    again.run.unmount();
  });

  it("экран упавшего модуля: женский род по подписи, на «я» — мужской, без подписи — «Экран»; причина и совет", async () => {
    const Bad = () => {
      throw new Error("сломан");
    };
    const screen = async (label?: string) => (await stand([{ manifest: man("m", { a: 1 }), module: () => ({ screens: { a: { nav: "А", label, view: Bad } } }) }])).$(".sb-badc")!;
    const fem = await screen("Лента");
    expect(fem.querySelector("b")!.textContent).toBe("Лента выключена");
    expect(fem.querySelector("code")!.textContent).toBe("Модуль m упал на экране a: Error: сломан");
    expect(fem.textContent).toContain("Остальные экраны работают. Этот вернётся после перезапуска приложения.");
    expect((await screen()).querySelector("b")!.textContent).toBe("Экран выключен");
    expect((await screen("Сессия")).querySelector("b")!.textContent).toBe("Сессия выключен");
  });
});

describe("старт", () => {
  it("4002 · start модуля бросил — выключен он, остальные стартуют, hello уходит", async () => {
    const log: string[] = [];
    const s = sample(log, {
      start() {
        throw new Error("нет памяти");
      },
    });
    const t = await stand([s.part, other(log).part], { roster: oneMachine() });
    expect(t.run.failed).toEqual({ sample: "Модуль sample упал на старте: Error: нет памяти" });
    expect(log).toContain("start other");
    expect(t.relay.hellos).toHaveLength(1);
    expect(t.run.stopped).toBeNull();
    expect(t.root.textContent).toContain("Список выключен");
  });

  it("7219 · функция модуля бросила: выключен только он, на его экране — причина; остальные работают", async () => {
    // источник: контракт ядра — бросил, значит выключен; его экраны показывают причину
    const log: string[] = [];
    const bad: AppPart = {
      manifest: man("bad", { broken: 1 }),
      module: () => {
        throw new Error("сломалось при создании");
      },
    };
    const t = await stand([sample(log).part, bad], { url: "/#broken" });
    expect(t.run.stopped).toBeNull();
    expect(t.run.failed.bad).toContain("сломалось при создании");
    expect(t.root.textContent).toContain("сломалось при создании");
    expect(log).toContain("start sample");
  });

  const silent = { get: () => new Promise(() => {}), set: async () => {}, update: async () => undefined, clear: async () => {} };

  it("хранилище молчит: через 30 с причина на странице, а не пустой экран", async () => {
    vi.useFakeTimers();
    const t = begin([mod().part], { store: silent });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.root.textContent).not.toContain("Приложение упало");
    await vi.advanceTimersByTimeAsync(1);
    await t.run.ready;
    expect(t.root.textContent).toBe("Приложение упало: хранилище не ответило за 30 с");
  });

  it("хранилище отказало: причина на странице; ready не бросает", async () => {
    const t = begin([mod().part], { store: { ...silent, get: () => Promise.reject(new Error("нет места")) } });
    await t.run.ready;
    await flush();
    expect(t.root.textContent).toBe("Приложение упало: нет места");
  });

  it("start модуля не отвечает: через 30 с связь всё равно идёт, причина в журнале", async () => {
    vi.useFakeTimers();
    const t = begin([mod({ start: () => new Promise<void>(() => {}) }).part]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.relay.socks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await t.run.ready;
    await vi.advanceTimersByTimeAsync(10);
    expect(t.relay.socks).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith("switchboard: модули не запустились за 30 с");
  });

  it("5716 · упал вид ядра — страница показывает причину, а не пустоту", async () => {
    // источник: дизайн «Новая модульность фронта», эталон основания; вид ядра — вне границы модуля
    const broken = {
      nav: "М",
      view: () => "экран",
      get group(): string {
        throw new Error("сломана группа раздела");
      },
    };
    const t = begin([{ manifest: man("m", { m: 1 }), module: () => ({ screens: { m: broken } }) }], { relay: new FakeRelay(homeRoster()) });
    await t.run.ready;
    await flush();
    expect(t.root.textContent).toBe("Приложение упало: сломана группа раздела");
  });
});

describe("платформа по navigator", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  /** Окно с нужным navigator, @scope и режимом отображения. */
  const windowWith = (ua: string, o: { standalone?: boolean; scope?: boolean; display?: boolean }) => {
    const nav = new Proxy(navigator, { get: (x, k) => (k === "userAgent" ? ua : k === "standalone" ? o.standalone : Reflect.get(x, k)) });
    return new Proxy(window, {
      has: (x, k) => (k === "CSSScopeRule" ? !!o.scope : k in x),
      get(x, k) {
        if (k === "navigator") return nav;
        if (k === "matchMedia" && o.display) return (q: string) => ({ matches: q === "(display-mode: standalone)" });
        const v = Reflect.get(x, k);
        return typeof v === "function" && k !== "Response" ? v.bind(x) : v;
      },
    });
  };

  it.each([
    ["браузер без @scope", "Mozilla/5.0", { scope: false }, "browser"],
    ["iPhone вне экрана «Домой»", IPHONE, { scope: true }, "install"],
    ["iPhone с экрана «Домой»", IPHONE, { scope: true, standalone: true }, null],
    ["iPhone по режиму отображения", IPHONE, { scope: true, display: true }, null],
    ["обычный браузер с @scope", "Mozilla/5.0", { scope: true }, null],
  ] as const)("%s", async (_n, ua, o, want) => {
    const relay = new FakeRelay(oneMachine());
    relay.handlers["gate.redeem"] = () => ({ ok: true, result: { key: KEY } });
    const { run } = begin([mod().part], { relay, store: memoryStore(), url: `/#invite=${INVITE}`, options: { window: windowWith(ua, o) as Window, platform: undefined } });
    await run.ready;
    await flush();
    expect(run.stopped).toBe(want);
    run.unmount();
  });
});

describe("сборка страницы", () => {
  const list = (names: string[], over: Partial<BuildList> = {}): BuildList => ({ app: "phone", version: "1.1.0+2", fleet: "test", modules: names.map((name) => ({ name, version: "1.0.0" })), workers: FakeRelay.WORKERS, ...over });
  const build = (b: BuildList, load: (n: string) => Promise<unknown>, over: { loadMs?: number; WebSocket?: never } = {}) => {
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, "", "/");
    const relay = new FakeRelay(homeRoster());
    return startBuild({ root: document.getElementById("app")!, build: b, load, fetch: relay.fetch, store: memoryStore({ key: KEY }), WebSocket: relay.WebSocket, platform: { ios: false, standalone: false }, pauseMs: 5, ...over });
  };
  const live = (name: string, nav: string) => ({ manifest: man(name, { [name]: 1 }), default: () => ({ screens: { [name]: { nav, label: nav, view: () => nav } } }) });

  it("5134 · модули по списку сборки (ядро — само), relay и Worker'ы — из build.json, имя приложения — у модуля; модуль не загрузился — выключен только он", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адреса relay и Worker'ов страница берёт из
    // списка сборки; модуль не загрузился — выключен только он, остальные работают
    const relay = new FakeRelay(homeRoster());
    const urls: string[] = [];
    const WS = relay.WebSocket;
    const asked: string[] = [];
    let application = "";
    const run = await build(
      list(["web-core", "list", "broken"], { workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" } }),
      async (name) => {
        asked.push(name);
        if (name === "broken") throw new Error("404 m/broken.js");
        return { ...live("list", "Список"), default: (a: { application: string }) => ((application = a.application), live("list", "Список").default()) };
      },
      {
        WebSocket: class extends (WS as unknown as new (u: string) => object) {
          constructor(u: string) {
            urls.push(u);
            super(u);
          }
        } as never,
      },
    );
    await run.ready;
    await flush();
    expect(asked).toEqual(["list", "broken"]);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
    expect(Object.keys(run.failed)).toEqual(["broken"]);
    expect(run.failed.broken).toContain("импорт: 404 m/broken.js");
    expect(run.stopped).toBeNull();
    expect(application).toBe("phone");
    expect(document.querySelector(".sb-main")!.textContent).toContain("Список");
    run.unmount();
  });

  it("5706 · файл модуля не отвечает — через предел выключен только он", async () => {
    // источник: устав — у всех операций лимит
    const run = await build(list(["slow", "ok"]), (name) => (name === "slow" ? new Promise(() => {}) : Promise.resolve(live("ok", "Живой"))), { loadMs: 10 });
    await run.ready;
    await flush();
    expect(run.failed.slow).toContain("не загрузился за 10 мс");
    expect(document.body.textContent).toContain("Живой");
    run.unmount();
  });

  it("файл без default или manifest — причина словами; библиотека страницы (default — объект) — без экранов и без сбоя", async () => {
    const run = await build(list(["empty", "lib", "ok"]), async (n) => {
      if (n === "empty") return { default: () => ({}) };
      if (n === "lib") return { default: {}, manifest: man("lib") };
      return live("ok", "Живой");
    });
    await run.ready;
    await flush();
    expect(run.failed).toEqual({ empty: "Модуль empty упал на старте: Error: импорт: в файле модуля нет default или manifest" });
    expect(document.body.textContent).toContain("Живой");
    run.unmount();
  });
});

describe("хранилище", () => {
  it("формат на устройстве: база switchboard версии 1, разделы — ключи таблицы sections", async () => {
    const f = new IDBFactory();
    await idbStore(undefined, f).set("key", KEY);
    expect(await f.databases()).toEqual([{ name: "switchboard", version: 1 }]);
    const db = await new Promise<IDBDatabase>((ok) => {
      const r = f.open("switchboard");
      r.onsuccess = () => ok(r.result);
    });
    const got = await new Promise((ok) => {
      const r = db.transaction("sections").objectStore("sections").get("key");
      r.onsuccess = () => ok(r.result);
    });
    expect(got).toBe(KEY);
  });

  it.each([
    ["IndexedDB", () => idbStore("t1", new IDBFactory())],
    ["в памяти", () => memoryStore()],
  ])("%s: раздел пишется, читается и правится; clear стирает всё", async (_n, make) => {
    const st = make();
    expect(await st.get("key")).toBeUndefined();
    await st.set("key", KEY);
    expect(await st.get("key")).toBe(KEY);
    await st.update<number[]>("pushes", (a = []) => [...a, 1]);
    expect(await st.update<number[]>("pushes", (a = []) => [...a, 2])).toEqual([1, 2]);
    await st.clear();
    expect([await st.get("key"), await st.get("pushes")]).toEqual([undefined, undefined]);
  });

  it("две базы IndexedDB не видят друг друга; правка в одной транзакции — два update подряд не теряются", async () => {
    const f = new IDBFactory();
    const a = idbStore("a", f);
    const b = idbStore("b", f);
    await a.set("k", 1);
    expect(await b.get("k")).toBeUndefined();
    await Promise.all([a.update<number>("n", (x = 0) => x + 1), a.update<number>("n", (x = 0) => x + 1)]);
    expect(await a.get("n")).toBe(2);
  });

  it("в памяти: копии при чтении и записи", async () => {
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
  });
});
