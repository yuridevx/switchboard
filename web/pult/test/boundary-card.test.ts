// Леса границы «обзор флота на странице»: карточка сессии на телефоне и пульте — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPart, Roster } from "@switchboard/web-core";
import { memoryStore } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createLabels, manifest as labelsM } from "@switchboard/web-labels";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, pult } from "./stand.ts";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Карточка: телефон", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  async function card(callsign: string, roster = homeRoster()) {
    const relay = new FakeRelay(roster);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    // карточка — по адресу: список сессий board в эти эталоны не входит
    const t = await stand(parts(), { relay, url: `/#card?callsign=${encodeURIComponent(callsign)}` });
    return t;
  }

  describe("карточка сессии", () => {
    it("шапка: имя, машина и папка; состояние — лампой без слов; вкладка «Чат» — лента в месте карточки", async () => {
      const t = await card("site@laptop");
      expect(t.$(".sb-bt")!.textContent).toBe("site@laptop · папка switchboard");
      expect(t.$(".sb-pill")).toBeNull();
      expect(t.$(".sb-bar .sb-dot.busy")).not.toBeNull();
      expect(t.$(".card-place .chat-comp")).not.toBeNull();
      expect(t.relay.sent("session.watch")[0]).toMatchObject({ callsign: "site@laptop" });
    });

    it("«Ещё»: поля roster; модель и усилие — session.update; «Остановить» — session.stop, отказ — словом", async () => {
      const r = homeRoster();
      r.machines[0].contract = { ...r.machines[0].contract, "session.update": 1 };
      const t = await card("site@laptop", r);
      t.relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      await t.click(t.button("Ещё"));
      expect(t.relay.sent("session.unwatch")).toHaveLength(1);
      expect(t.$(".card-info")!.textContent).toBe("адресsite@laptopпапка~/Projects/switchboardслотmainаккаунтy0902");
      // слово пользователя 6 нояб.: на телефоне та же таблица участника
      t.relay.handlers["session.update"] = () => ({ ok: true });
      expect(t.$('[data-model][aria-pressed="true"]')!.textContent).toBe("opus");
      await t.click(t.$('[data-effort="low"]'));
      expect(t.relay.sent("session.update")[0]).toMatchObject({ callsign: "site@laptop", effort: "low" });
      await t.click(t.button("Остановить"));
      expect(t.relay.sent("session.stop")[0]).toMatchObject({ v: 1, callsign: "site@laptop" });
      expect(t.text()).toContain("session.stop: stopping");
    });

    it("остановленная — «Запустить»; нет session.start в contract машины — кнопки нет", async () => {
      const t = await card("wiki@pc");
      await t.click(t.button("Ещё"));
      expect(t.button("Запустить")).not.toBeNull();
      const r = homeRoster();
      delete r.machines[1].contract!["session.start"];
      const t2 = await card("wiki@pc", r);
      await t2.click(t2.button("Ещё"));
      expect(t2.button("Запустить")).toBeNull();
    });
  });
});

describe("Карточка: настройки", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  const CARD = ["session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.profiles", "machine.accounts", "machine.journal", "session.stop", "session.start"];

  function roster(without: string[] = [], tweak: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract, ...Object.fromEntries(CARD.map((n) => [n, n === "machine.journal" ? 2 : 1])) };
      for (const n of without) delete m.contract[n];
    }
    tweak(r);
    return r;
  }
  const state = (s: string) => (r: Roster) => void Object.assign(r.sessions.find((x) => x.callsign === "poe-bot@pc")!, { state: s });

  function relayFor(r: Roster) {
    const relay = new FakeRelay(r);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.unwatch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
    relay.handlers["session.spec"] = () => ({ ok: true, result: { title: "старый" } });
    relay.handlers["session.update"] = () => ({ ok: true, result: { now: [] } });
    return relay;
  }

  async function wideCard(r = roster(), relay = relayFor(r), hash = "#card?callsign=poe-bot%40pc") {
    const t = await stand(parts(), { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", `/${hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    const btn = (scope: string, text: string) => [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
    const tab = (k: string) => t.click(t.$(`.cw-tabs [data-tab="${k}"]`));
    return { ...t, relay, btn, tab };
  }

  const narrow = async (r = roster(), relay = relayFor(r)) => {
    const t = await stand(parts(), { relay, url: "/#card?callsign=poe-bot%40pc" });
    await t.click(t.button("Ещё"));
    return t;
  };

  const typeIn = async (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const leave = async (el: HTMLElement) => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush();
  };

  describe("настройки сессии", () => {
    it("6991 · заголовок: значение из session.spec; ушли с поля — session.update один раз, значение перечитано", async () => {
      // источник: чьё: код
      const t = await wideCard();
      await t.tab("set");
      const f = t.$<HTMLInputElement>('[data-f="title"]')!;
      expect(f.value).toBe("старый");
      t.relay.handlers["session.spec"] = () => ({ ok: true, result: { title: "новый" } });
      const read = t.relay.sent("session.spec").length;
      await typeIn(f, "новый");
      await leave(f);
      await leave(f);
      expect(t.relay.sent("session.update").filter((x) => x.title)).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", title: "новый" })]);
      expect(t.relay.sent("session.spec")).toHaveLength(read + 1);
    });

    it("6992 · заголовок отказал: «Не вышло: слово»", async () => {
      // источник: устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      t.relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      const f = t.$<HTMLInputElement>('[data-f="title"]')!;
      await typeIn(f, "x");
      await leave(f);
      expect(t.$('[data-sec="title"]')!.textContent).toContain("Не вышло: bad_spec");
    });

    it("6997 · нажат текущий слот: запроса нет; текущий профиль в списке добавления не стоит", async () => {
      // источник: чьё: код
      const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { profile: [{ id: "team/profiles/ops", state: "ok" }], slot: { name: "main", wait: null } }));
      const relay = relayFor(r);
      relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {} } } });
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "a", order: ["a"] } } } });
      const t = await wideCard(r, relay);
      await t.tab("set");
      expect(t.$('[data-profile="team/profiles/ops"]')).toBeNull();
      await t.click(t.$('[data-side="Ведущий"] [data-slot="main"]'));
      expect(relay.sent("session.profile")).toHaveLength(0);
      expect(relay.sent("session.slot")).toHaveLength(0);
    });

    it("6998 · быстрый режим: session.update с fast; значение — из следующего roster; отказ — тост словом", async () => {
      // источник: факт — итог изменения из следующего roster; устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      const sw = t.$('[data-sec="fast"] [role="switch"]')!;
      await t.click(sw);
      expect(t.relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot@pc", fast: true });
      expect(t.$('[data-sec="fast"] [role="switch"]')!.getAttribute("aria-checked")).toBe("false");
      t.relay.setRoster(roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { fast: true })));
      await flush();
      expect(t.$('[data-sec="fast"] [role="switch"]')!.getAttribute("aria-checked")).toBe("true");
      t.relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      await t.click(t.$('[data-sec="fast"] [role="switch"]'));
      expect(t.$(".sb-toast")!.textContent).toBe("poe-bot@pc: быстрый режим — bad_spec");
    });

    it("6925 · кнопки по состоянию: busy — «Остановить»; stopped и failed — «Запустить», там же в шапке", async () => {
      // источник: чьё: код
      const t = await wideCard();
      await t.tab("set");
      expect(t.btn('[data-sec="ctl"]', "Остановить")).not.toBeNull();
      expect(t.btn('[data-sec="ctl"]', "Запустить")).toBeNull();
      expect(t.btn(".cw-h", "Запустить")).toBeNull();
      for (const s of ["stopped", "failed"]) {
        const r = roster([], state(s));
        const t2 = await wideCard(r, relayFor(r));
        await t2.tab("set");
        expect(t2.btn('[data-sec="ctl"]', "Запустить")).not.toBeNull();
        expect(t2.btn('[data-sec="ctl"]', "Остановить")).toBeNull();
        expect(t2.btn(".cw-h", "Запустить")).not.toBeNull();
      }
    });

    it("6926 · убрать: до подтверждения и после отмены запроса нет; подтвердили — session.remove и возврат", async () => {
      // источник: чьё: код
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.remove"] = () => {
        relay.setRoster({ ...r, sessions: r.sessions.filter((s) => s.callsign !== "poe-bot@pc") });
        return { ok: true };
      };
      const t = await wideCard(r, relay);
      await t.tab("set");
      await t.click(t.btn(".cw-set", "Убрать…"));
      await t.click(t.btn(".sb-confirm", "Отмена"));
      expect(t.$(".sb-confirm")).toBeNull();
      expect(relay.sent("session.remove")).toHaveLength(0);
      await t.click(t.btn(".cw-set", "Убрать…"));
      const before = location.hash;
      await t.click(t.btn(".sb-confirm", "Убрать"));
      await flush(5);
      expect(relay.sent("session.remove")).toHaveLength(1);
      expect(location.hash).not.toBe(before);
    });

    it("6927 · команда отказала: на вкладке «запрос: слово», экран не закрыт; в шапке — тост", async () => {
      // источник: устав — отказ словом
      const t = await wideCard();
      await t.tab("set");
      t.relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      await t.click(t.btn('[data-sec="ctl"]', "Остановить"));
      expect(t.$('[data-sec="ctl"]')!.textContent).toContain("session.stop: stopping");
      expect(t.$('[data-sec="ctl"] [role="alert"]')!.textContent).toBe("session.stop: stopping");
      expect(location.hash).toContain("#card");
      const r = roster([], state("stopped"));
      const relay = relayFor(r);
      relay.handlers["session.start"] = () => ({ ok: false, error: "no_slot" });
      const t2 = await wideCard(r, relay);
      await t2.click(t2.btn(".cw-h", "Запустить"));
      expect(t2.$(".sb-toast")!.textContent).toBe("poe-bot@pc: «Запустить» — no_slot");
    });

    it("6929 · машина не умеет: адрес на журнал ведёт в «Настройки»; разделов и «Журнала» нет; session.spec нет", async () => {
      // источник: факт — нет имени в contract, нет кнопки
      const r = roster(["session.update", "session.slot", "session.profile", "session.spec", "machine.journal"]);
      const t = await wideCard(r, relayFor(r), "#card?callsign=poe-bot%40pc&tab=log");
      expect(t.$('.cw-tabs [data-tab="log"]')).toBeNull();
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
      for (const sec of ["profile", "fast", "title", "slot"]) expect(t.$(`[data-sec="${sec}"]`)).toBeNull();
      expect(t.relay.sent("session.spec")).toHaveLength(0);
    });
  });

  describe("журнал и лимиты", () => {
    const rec = (t: string, ev: string) => ({ t, part: "host", who: "core", callsign: "poe-bot@pc", kind: "stop", ev });

    it("6993 · быстрая смена фильтра: устаревший ответ отброшен", async () => {
      // источник: чьё: код
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [], more: false } });
      const t = await wideCard(roster(), relay);
      await t.tab("log");
      relay.handlers["machine.journal"] = () => undefined;
      await t.click(t.btn(".cw-log", "stop"));
      await t.click(t.btn(".cw-log", "все"));
      const [late, now] = relay.sent("machine.journal").slice(-2);
      relay.reply(now.id!, { ok: true, result: { records: [rec("2026-11-01T06:00:00.000Z", "свежий")], more: false } });
      await flush();
      relay.reply(late.id!, { ok: true, result: { records: [rec("2026-11-01T05:00:00.000Z", "старый")], more: true } });
      await flush();
      expect(t.$(".cw-log")!.textContent).toContain("свежий");
      expect(t.$(".cw-log")!.textContent).not.toContain("старый");
    });

    it("6928 · прошлые дни: подпись «сегодня»; «Раньше» — на день назад, подпись и записи", async () => {
      // источник: чьё: код
      const relay = relayFor(roster());
      let first = true;
      relay.handlers["machine.journal"] = () => {
        const records = first ? [] : [rec("2026-11-01T06:00:00.000Z", "вчера")];
        first = false;
        return { ok: true, result: { records, more: false } };
      };
      const t = await wideCard(roster(), relay);
      await t.tab("log");
      expect(t.$(".cw-log")!.textContent).toContain("сегодня");
      expect(t.$(".cw-log")!.textContent).toContain("Записей нет.");
      expect(t.btn(".cw-log", "дальше →")).toBeNull();
      await t.click(t.btn(".cw-log", "Раньше"));
      expect(t.$(".cw-log")!.textContent).toContain("с 1 дн. назад");
      expect(t.$(".cw-log")!.textContent).toContain("вчера");
    });

  });

  describe("телефон", () => {
    it("6983 · failed и stopped — «Запустить», «Остановить» нет; одно правило с широким видом", async () => {
      // источник: решение главной сессии 4 нояб.: дубликат логики NarrowCard и SetTab сведён, у failed — «Запустить»
      for (const s of ["failed", "stopped"]) {
        const t = await narrow(roster([], state(s)));
        expect(t.button("Запустить")).not.toBeNull();
        expect(t.button("Остановить")).toBeNull();
        expect(t.button("Поднять")).toBeNull();
        await t.click(t.button("Запустить"));
        expect(t.relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
      }
    });

    it("6937 · модель — session.update; на время запроса стопа кнопка неактивна", async () => {
      // источник: чьё: код
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.update"] = () => ({ ok: true });
      relay.handlers["session.stop"] = () => undefined;
      const t = await narrow(r, relay);
      await t.click(t.$('[data-model="sonnet"]'));
      expect(relay.sent("session.update").at(-1)).toHaveProperty("model", "sonnet");
      await t.click(t.button("Остановить"));
      expect(t.button("Останавливаю…")!.disabled).toBe(true);
      relay.reply(relay.sent("session.stop").at(-1)!.id!, { ok: true });
      await flush();
      expect(t.button("Остановить")!.disabled).toBe(false);
    });

    it("6938 · отказ: «Не вышло» и «запрос: слово»; следующее действие снимает прошлое слово", async () => {
      // источник: устав — отказ словом
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
      const t = await narrow(r, relay);
      await t.click(t.button("Остановить"));
      expect(t.text()).toContain("Не вышло");
      expect(t.text()).toContain("session.stop: stopping");
      relay.handlers["session.stop"] = () => ({ ok: true });
      await t.click(t.button("Остановить"));
      expect(t.text()).not.toContain("session.stop: stopping");
    });
  });

  describe("возврат машины и страницы", () => {
    it("7232 · карточка открыта при выключенной машине: машина вернулась — аккаунты и слоты дочитаны сами", async () => {
      // чьё: код — слепой архитектор, 4 нояб.: deps не менялись, данные пусты до ручного действия; ветка устава «соединение оборвалось → переподключаются»
      const r = roster(["machine.accounts"]);
      const relay = relayFor(r);
      const t = await wideCard(r, relay);
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(0);
      relay.setRoster(roster());
      await flush();
      expect(relay.sent("machine.accounts")).toHaveLength(1);
      expect(relay.sent("machine.accounts")[0]).toMatchObject({ machine: "pc" });
      expect(t.$(".cw-h")).not.toBeNull();
    });

    it("7234 · страница вернулась: настройка карточки из другой вкладки прочитана заново", async () => {
      // чьё: код — повторный start модулей при возвращении до 4 нояб.; start теперь один раз
      const store = memoryStore({ key: KEY });
      const r = roster();
      const relay = relayFor(r);
      const t = await stand(parts(), { relay, store, wide: true, url: "/#card?callsign=poe-bot%40pc" });
      await flush();
      expect(t.$(".cw-at")).not.toBeNull();
      // уход с экрана доводит начатые запросы: ответить на те, что без подделки
      for (const f of relay.got) if (typeof f.id === "string") relay.reply(f.id, { ok: true, result: null });
      await flush();
      await t.run.hide();
      store.data["card.head"] = { hat: false };
      await t.run.show();
      await flush();
      expect(t.$(".cw-at")).toBeNull();
    });
  });

  describe("E6 · чтение не ответило", () => {
    afterEach(() => vi.useRealTimers());

    it("E6 · слот, профиль, заголовок и серверы MCP: через 10 с слово на месте данных, а не «без слота» и не пусто", async () => {
      // источник: слово пользователя 4 нояб. — «таймаут операций на запрос метадаты 10 секунд»; дизайн «Что видит человек при отказе»
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { slot: { name: "main", wait: null }, profile: [{ id: "team/profiles/ops", state: "ok" }] }));
      const relay = relayFor(r);
      for (const n of ["machine.accounts", "machine.profiles", "session.spec", "session.call"]) relay.handlers[n] = () => undefined as never;
      const t = await wideCard(r, relay);
      await t.tab("set");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(t.$('[data-refused="slot"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      await flush();
      expect(t.$('[data-refused="slot"]')!.textContent).toBe("main · timeout");
      expect(t.$('[data-refused="profile"]')!.textContent).toBe("ops · timeout");
      expect(t.$('[data-refused="title"]')!.textContent).toBe("timeout");
      await t.tab("info");
      await vi.advanceTimersByTimeAsync(10_500);
      await flush();
      expect(t.$('[data-refused="mcp"]')!.textContent).toBe("timeout");
    });
  });

  it("V-C4 · телефон: «Останавливаю…» и «Запускаю…» на время запроса; журнал: подпись дня и машины, вид записи", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.stop"] = () => undefined;
    const t = await narrow(roster(), relay);
    await t.click(t.button("Остановить"));
    expect(t.button("Останавливаю…")!.disabled).toBe(true);
    const r2 = roster([], state("stopped"));
    const relay2 = relayFor(r2);
    relay2.handlers["session.start"] = () => undefined;
    const t2 = await narrow(r2, relay2);
    await t2.click(t2.button("Запустить"));
    expect(t2.button("Запускаю…")!.disabled).toBe(true);

    const relay3 = relayFor(roster());
    relay3.handlers["machine.journal"] = () => ({ ok: true, result: { records: [{ t: "нет даты", part: "host", kind: "note", ev: "e", word: "w" }], more: false } });
    const t3 = await wideCard(roster(), relay3);
    await t3.tab("log");
    expect(t3.$(".cw-log .cw-note")!.textContent).toBe("pc · сегодня");
    expect(t3.$(".cw-lr")!.textContent).toBe("нет датыnotehoste · w");
    expect(t3.$$(".cw-log .cw-opts button").map((b) => b.textContent)).toEqual(["все", "stop", "refuse", "note"]);
  });
});

describe("Карточка: широкий вид", () => {
  const parts = () => [
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];

  /** Имена Host, которыми пользуется карточка пульта. */
  const CARD = ["session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.profiles", "machine.accounts", "machine.journal"];

  /** Флот home с контрактом машины без names (по умолчанию — со всеми именами карточки). */
  function roster(without: string[] = [], tweak: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract, ...Object.fromEntries(CARD.map((n) => [n, n === "machine.journal" ? 2 : 1])) };
      for (const n of without) delete m.contract[n];
    }
    tweak(r);
    return r;
  }

  function relayFor(r: Roster) {
    const relay = new FakeRelay(r);
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.unwatch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
    return relay;
  }

  /** Широкая карточка: пульт с карточкой справа от списка. */
  async function wideCard(callsign: string, r = roster(), relay = relayFor(r)) {
    const t = await stand(parts(), { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", `/#card?callsign=${encodeURIComponent(callsign)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    const btn = (scope: string, text: string | RegExp) =>
      [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof text === "string" ? b.textContent === text : text.test(b.textContent ?? ""))) ?? null;
    const tab = (k: string) => t.click(t.$(`.cw-tabs [data-tab="${k}"]`));
    return { ...t, relay, btn, tab };
  }

  describe("карточка в узком виде", () => {
    it("4080 · сессии нет в roster — «laptop не на связи», кнопок нет", async () => {
      const r = homeRoster();
      r.machines = r.machines.filter((m) => m.machine !== "laptop");
      r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@laptop"));
      const t = await stand(parts(), { relay: relayFor(r), url: "/#card?callsign=site%40laptop&tab=info" });
      await flush();
      expect(t.$(".sb-bt")!.textContent).toBe("site@laptop не на связи");
      expect(t.$(".card-info")!.textContent).toBe("адресsite@laptop");
      expect(t.button("Остановить")).toBeNull();
      expect(t.button("Запустить")).toBeNull();
    });
  });

  describe("карточка в широком виде", () => {
    // источник шапки и «Сведений»: слова пользователя 6 нояб. — «шапка в одну строку», «меню ⋯ убрать», «Сведения» вкладкой: окон поверх нет. Остальное —
    // прототип «Пульт и телефон», подписан пользователем 2 нояб. («основа дизайна ок»); комментарии к прототипу:
    // «переработай статус в 1 строку», «перенести в право в контекст меню всю панель», «не запустилось — ховер индикатора,
    // опус и высокое конфигурируемый отсюда», «где-то надо сделать лимиты и аккаунт активный», сведения — «опциональные»
    it("5301 · шапка — одна строка: лампа, имя, «модель · усилие», «аккаунт · %» (жёлтая с 70 %), вкладки; меню ⋯ и окон нет; плашки нет", async () => {
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "dev@mail", plan: "Max 20×", limits: { five_hour: { utilization: 0.82, resetsAt: 0 } } } } } });
      const t = await wideCard("site@laptop", r, relay);
      const head = t.$(".cw-h")!;
      expect(head.querySelector(".cw-cs")!.textContent).toBe("site");
      expect(head.querySelector('[data-go="set"]')!.textContent).toBe("opus · высокое");
      expect(head.querySelector('[data-go="info"]')!.textContent).toBe("y0902 · 82 %");
      expect(head.querySelector('[data-go="info"]')!.classList.contains("lim")).toBe(true);
      expect([...head.querySelectorAll(".cw-tabs [data-tab]")].map((b) => b.textContent)).toEqual(["Разговор", "Настройки", "Журнал", "Сведения"]);
      expect(head.querySelector("[data-pop]")).toBeNull();
      expect(t.$(".cw-pop")).toBeNull();
      await t.click(head.querySelector('[data-go="set"]'));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
      await t.click(head.querySelector('[data-go="info"]'));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Сведения");
      // плашки у живой сессии нет; состояние — не текстом
      expect(t.$(".cw-pl")!.hidden).toBe(true);
      expect(head.textContent).not.toContain("работает");
      expect(head.textContent).not.toContain("null");
    });

    it("5302 · состояние — подсказка лампы; не запустилась: «не запустилась: причина», плашка с «Почему» → журнал, «Запустить» в шапке, отказ — тост", async () => {
      const r = roster([], (x) => Object.assign(x.sessions[3], { state: "failed", failed: { host: "resume failed" } }));
      const relay = relayFor(r);
      relay.handlers["session.start"] = () => ({ ok: false, error: "offline" });
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [], more: false } });
      const t = await wideCard("wiki@pc", r, relay);
      const lamp = t.$(".cw-h .cw-lamp")!;
      expect(lamp.getAttribute("title")).toBe("не запустилась: host: resume failed");
      expect(lamp.getAttribute("aria-label")).toBe("не запустилась: host: resume failed");
      expect(t.$(".cw-pl b")!.textContent).toBe("Не запустилась: host: resume failed");
      await t.click(t.btn(".cw-pl", "Почему"));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Журнал");
      await t.click(t.btn(".cw-h", "Запустить"));
      expect(relay.sent("session.start")).toEqual([expect.objectContaining({ v: 1, callsign: "wiki@pc" })]);
      expect(t.$(".sb-toast")!.textContent).toBe("wiki@pc: «Запустить» — offline");
      const t2 = await wideCard("poe-bot@pc");
      expect(t2.$(".cw-h .cw-lamp")!.getAttribute("title")).toBe("свободна");
    });

    it("7310 · supportedModels — один запрос на экран: поле ввода и режим в настройках берут один ответ", async () => {
      // источник: отчёт архитектора, лишняя коммуникация 6: модели на одном экране спрашивают дважды
      const r = roster([], (x) => void (x.sessions.find((v) => v.callsign === "poe-bot@pc")!.mode = "default"));
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? { ok: true, result: [{ value: "opus", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet 5.5" }] } : { ok: true, result: null });
      const t = await wideCard("poe-bot@pc", r, relay);
      const asked = () => relay.sent("session.call").filter((f) => f.method === "supportedModels").length;
      await flush(10);
      expect(t.$(".chat-mode")).not.toBeNull();
      expect(asked()).toBe(1);
      await t.tab("set");
      await flush(10);
      expect(t.$('.cw-set [data-sec="mode"]')).not.toBeNull();
      expect(asked()).toBe(1);
    });

    it("5303 · модель и усилие — в таблице участника: выбор — session.update; полное имя модели отмечает свой псевдоним; отказ — слово в разделе", async () => {
      const relay = relayFor(roster());
      relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? { ok: true, result: [{ value: "opus", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet 5.5" }] } : { ok: true, result: null });
      relay.handlers["session.update"] = () => ({ ok: true, result: { now: ["model"] } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("set");
      await flush(5);
      expect(t.$$('.cw-set [data-model][aria-pressed="true"]').map((b) => b.textContent)).toEqual(["sonnet"]);
      await t.click(t.$('.cw-set [data-model="opus"]'));
      expect(relay.sent("session.update")).toEqual([expect.objectContaining({ v: 1, callsign: "poe-bot@pc", model: "opus" })]);
      relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
      await t.click(t.$('.cw-set [data-effort="low"]'));
      expect(relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot@pc", effort: "low" });
      expect(t.$('[data-sec="pair"] .cw-note')!.textContent).toContain("bad_spec");
    });

    it("режим разрешений в настройках — кнопками, без выпадающего списка: выбор — setPermissionMode, нынешний нажат", async () => {
      // источник: слово пользователя 6 нояб. — «не надо никаких селектов, всё переключателями»
      const r = roster([], (x) => void (x.sessions.find((v) => v.callsign === "poe-bot@pc")!.mode = "default"));
      const relay = relayFor(r);
      relay.handlers["session.call"] = () => ({ ok: true, result: [] });
      const t = await wideCard("poe-bot@pc", r, relay);
      await t.tab("set");
      await flush(5);
      expect(t.$(".cw-set select")).toBeNull();
      expect(t.$$('[data-sec="mode"] [aria-pressed="true"]').map((b) => b.textContent)).toEqual(["Спрашивать"]);
      await t.click(t.$('[data-perm="plan"]'));
      expect(relay.sent("session.call").find((f) => f.method === "setPermissionMode")).toMatchObject({ callsign: "poe-bot@pc", args: ["plan"] });
    });

    it("5304 · аккаунт и лимиты в «Сведениях»: почта и план, слот, окна лимитов, очередь слота; слот ждёт сброса — кнопка шапки своим цветом", async () => {
      const reset = Math.floor(new Date(2026, 10, 2, 16, 40).getTime() / 1000);
      const r = roster([], (x) => Object.assign(x.sessions[0], { slot: { name: "night", wait: reset } }));
      const relay = relayFor(r);
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "night@mail", plan: "Max 5×", limits: { five_hour: { utilization: 0.98, resetsAt: reset } } } }, slots: { night: { order: ["y0902", "spare"] } } } });
      const t = await wideCard("site@laptop", r, relay);
      const b = t.$('[data-go="info"]')!;
      expect(b.textContent).toBe("y0902 · ждёт сброса 16:40");
      expect(b.classList.contains("you")).toBe(true);
      await t.click(b);
      const sec = t.$('[data-sec="account"]')!;
      expect(sec.querySelector(".cw-kv")!.textContent).toBe("аккаунтy0902 · Max 5×слотnight");
      expect(sec.querySelector('[data-win="five_hour"]')!.textContent).toBe("5 ч98 % · до 16:40");
      expect(sec.textContent).toContain("очередь слота: y0902 → spare");
      await t.click(t.btn('[data-sec="account"]', "Сменить слот"));
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
    });

    it("5305 · «Сведения»: кто дал задачу, модель, адрес, машина, инцидент, папка, профиль; claude.ai — ссылкой", async () => {
      const r = roster([], (x) => Object.assign(x.sessions[0], { dir: "~/Projects/site", by: "pult~you@mail", profile: [{ id: "team/profiles/ops", state: "ok" }], incident: { type: "disk-full", key: "/" }, remote: { url: "https://claude.ai/code/s1" } }));
      const t = await wideCard("site@laptop", r);
      await t.tab("info");
      const info = t.$("aside.cw-info")!;
      expect(info.querySelector(".cw-kv")!.textContent).toBe("задачу далpult~you@mailмодельopus · высокоеадресsite@laptopмашина@laptopинцидентdisk-full · /папка~/Projects/siteпрофильops");
      expect(info.querySelector<HTMLAnchorElement>('a[href="https://claude.ai/code/s1"]')!.textContent).toBe("Открыть в claude.ai ↗");
    });

    it("6106 · сведения открыты, сессия ожила позже — список серверов MCP приходит без переоткрытия", async () => {
      const r = roster([], (x) => void (x.sessions[0].state = "stopped"));
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.tab("info");
      await flush();
      const asked = () => relay.sent("session.call").filter((f) => f.method === "mcpServerStatus");
      expect(asked()).toHaveLength(0);
      relay.setRoster(roster([], (x) => void (x.sessions[0].state = "idle")));
      await flush();
      expect(asked()).toHaveLength(1);
      expect(t.$("aside.cw-info")!.textContent).toContain("fleet");
    });

    it("6110 · клик по имени сервера MCP ничего не переключает; «выкл» — переключает", async () => {
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.tab("info");
      await flush();
      const toggled = () => relay.sent("session.call").filter((f) => f.method === "toggleMcpServer");
      await t.click(t.$(".cw-sw span"));
      await flush();
      expect(toggled()).toHaveLength(0);
      await t.click(t.$('[data-mcp="fleet"]'));
      await flush();
      expect(toggled()).toHaveLength(1);
    });

    it("7030 · сервер MCP: состояние словом, «Переподключить» — reconnectMcpServer и список заново; отказ — тост", async () => {
      // источник: устав — все функции claude-fleet: состояние, переподключение и вход сервера MCP
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "failed" }] } : f.method === "reconnectMcpServer" ? { ok: false, error: "sdk_error" } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.tab("info");
      await flush();
      expect(t.$(".cw-sw")!.textContent).toContain("ошибка");
      const asked = () => relay.sent("session.call").filter((f) => f.method === "mcpServerStatus").length;
      const before = asked();
      await t.click(t.$('[data-mcp-re="fleet"]'));
      await flush();
      expect(relay.sent("session.call").find((f) => f.method === "reconnectMcpServer")).toMatchObject({ args: ["fleet"] });
      expect(t.$(".sb-toast")!.textContent).toContain("reconnectMcpServer: sdk_error");
      expect(asked()).toBe(before);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
      await t.click(t.$('[data-mcp-re="fleet"]'));
      await flush();
      expect(asked()).toBe(before + 1);
      expect(t.$(".cw-sw")!.textContent).toContain("подключён");
    });

    it("7031 · нужен вход: «Войти» — mcpAuthenticate, ссылка в новой вкладке; у подключённого кнопки нет; ссылки нет — тост", async () => {
      // источник: устав — все функции claude-fleet; ссылка, а не окно: окно после ответа запроса браузер блокирует
      const r = roster();
      const relay = relayFor(r);
      let url: string | undefined = "https://example.com/login";
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "gh", status: "needs-auth" }, { name: "fleet", status: "connected" }] } : f.method === "mcpAuthenticate" ? { ok: true, result: { authUrl: url } } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.tab("info");
      await flush();
      expect(t.$('[data-mcp-login="fleet"]')).toBeNull();
      await t.click(t.$('[data-mcp-login="gh"]'));
      await flush();
      expect(relay.sent("session.call").find((f) => f.method === "mcpAuthenticate")).toMatchObject({ args: ["gh"] });
      const a = t.$<HTMLAnchorElement>('a[data-mcp-url="gh"]')!;
      expect(a.href).toBe("https://example.com/login");
      expect(a.target).toBe("_blank");
      url = undefined;
      await t.click(t.$('[data-mcp-login="gh"]'));
      await flush();
      expect(t.$(".sb-toast")!.textContent).toContain("mcpAuthenticate: ссылки нет");
    });

    it("4085 · сессии нет в roster — «pc не на связи», плашки нет", async () => {
      const r = roster([], (x) => {
        x.machines = x.machines.filter((m) => m.machine !== "pc");
        x.sessions = x.sessions.filter((s) => !s.callsign.endsWith("@pc"));
      });
      const t = await wideCard("poe-bot@pc", r);
      expect(t.$(".cw-h")!.textContent).toContain("не на связи");
      expect(t.$(".cw-h .cw-cs")!.textContent).toBe("poe-bot");
      expect(t.$(".cw-pl")!.hidden).toBe(true);
    });
  });

  describe("настройки карточки", () => {
    it("8055 · пара из настроек: переключатель — session.open { wing_of }; пара есть — вторая колонка, снятие с вопросом на месте, session.remove ведомого", async () => {
      // источник: слово пользователя 6 нояб.: пара — opt-in, выбрать всё для обеих сессий
      const r = roster();
      const relay = relayFor(r);
      relay.handlers["session.open"] = () => ({ ok: true, result: { callsign: "poe-bot-wing@pc" } });
      const t = await wideCard("poe-bot@pc", r, relay);
      await t.tab("set");
      await flush(5);
      expect(t.$('[data-side="Ведомый"]')).toBeNull();
      await t.click(t.$("button[data-pair]"));
      expect(relay.sent("session.open").at(-1)).toMatchObject({ machine: "pc", wing_of: "poe-bot@pc" });
      expect(relay.sent("session.open").at(-1)).not.toHaveProperty("name");
      const lead = r.sessions.find((s) => s.callsign === "poe-bot@pc")!;
      relay.setRoster({ ...r, sessions: [...r.sessions, { ...lead, callsign: "poe-bot-wing@pc", parent: "poe-bot@pc", wing: true, model: "haiku" } as never] });
      await flush(5);
      expect(t.$('[data-side="Ведомый"] [data-model="haiku"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(t.$('.cw-side[data-callsign="poe-bot-wing@pc"]')).not.toBeNull();
      relay.handlers["session.update"] = () => ({ ok: true });
      await t.click(t.$('[data-side="Ведомый"] [data-model="opus"]'));
      expect(relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot-wing@pc", model: "opus" });
      relay.handlers["session.remove"] = () => ({ ok: true });
      await t.click(t.$("button[data-pair]"));
      expect(relay.sent("session.remove")).toHaveLength(0);
      await t.click(t.btn('[data-sec="pair"] .sb-confirm', "Убрать"));
      expect(relay.sent("session.remove")).toEqual([expect.objectContaining({ callsign: "poe-bot-wing@pc" })]);
    });

    it("5307 · профиль списком и слот (session.profile, session.slot), отказ — «Не вышло: слово»; ключ флота — слот; «Убрать…» — подтверждение, session.remove", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {}, "team/profiles/writer": {} } } });
      relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "y0902", order: ["y0902"] }, bot: { account: "work3", order: ["work3"] } } } });
      relay.handlers["session.profile"] = () => ({ ok: false, error: "no_profile" });
      relay.handlers["session.slot"] = () => ({ ok: true, result: { restart: true } });
      relay.handlers["session.remove"] = () => ({ ok: true });
      relay.handlers["fleetkeys.list"] = () => ({ ok: true, result: { keys: { orca: { env: {}, settings: {} } } } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("set");
      await flush(5);
      expect(t.$$('[data-side="Ведущий"] [data-profile]').map((b) => b.dataset.profile)).toEqual(["team/profiles/ops", "team/profiles/writer"]);
      await t.click(t.$('[data-side="Ведущий"] [data-profile="team/profiles/writer"]'));
      expect(relay.sent("session.profile")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", profile: ["team/profiles/writer"] })]);
      expect(t.$('[data-sec="pair"]')!.textContent).toContain("Не вышло: no_profile");
      await t.click(t.$('[data-side="Ведущий"] [data-slot="bot"]'));
      expect(relay.sent("session.slot")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", slot: "bot" })]);
      expect(t.$('[data-sec="pair"]')!.textContent).toContain("после хода");
      await t.click(t.$('[data-side="Ведущий"] [data-fleet][data-slot="orca"]'));
      expect(relay.sent("session.slot").at(-1)).toMatchObject({ slot: "orca" });
      await t.click(t.btn(".cw-set", "Убрать…"));
      expect(relay.sent("session.remove")).toHaveLength(0);
      await t.click(t.btn(".sb-confirm", "Убрать"));
      expect(relay.sent("session.remove")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
    });

    it("4092 · сессия не живая — сведений процесса не просим; «Запустить» и «Убрать…», без «Остановить» и «Прервать»", async () => {
      const t = await wideCard("wiki@pc");
      await t.tab("set");
      expect(t.relay.sent("session.call")).toEqual([]);
      const ctl = [...t.$('[data-sec="ctl"]')!.querySelectorAll("button")].map((b) => b.textContent);
      expect(ctl).toEqual(["Запустить", "Убрать…"]);
    });
  });

  describe("журнал машины в карточке", () => {
    const rec = (t: string, ev: string) => ({ t, part: "host", who: "core", callsign: "poe-bot@pc", kind: "stop", ev, word: "w", why: "y" });

    it("4191 · сессия убрана, машина на связи: вкладка «Журнал» есть, запрос — с session и без callsign", async () => {
      // источник: факт цикла тестов 2 нояб. — журнал убранной сессии отвечал offline (callsign запроса ядро читает как адрес)
      const r = roster([], (x) => (x.sessions = x.sessions.filter((s) => s.callsign !== "poe-bot@pc")));
      const relay = relayFor(r);
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [rec("2026-11-01T06:00:00.000Z", "gone")], more: false } });
      const t = await wideCard("poe-bot@pc", r, relay);
      expect(t.$('.cw-tabs [data-tab="log"]')).not.toBeNull();
      await t.tab("log");
      const f = relay.sent("machine.journal")[0];
      expect(f).toMatchObject({ v: 2, machine: "pc", session: "poe-bot@pc" });
      expect(f).not.toHaveProperty("callsign");
      expect(t.$(".cw-log")!.textContent).toContain("gone");
    });

    it("4093 · с полуночи, фильтр kind, «дальше →» с t последней, «Раньше» — с прошлого дня", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = (f) => ({ ok: true, result: { records: f.since && String(f.since).startsWith("2026-10-31T23") ? [rec("2026-11-01T05:00:00.000Z", "x2")] : [rec("2026-11-01T06:00:00.000Z", "x1")], more: true } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("log");
      const first = relay.sent("machine.journal")[0];
      expect(first).toMatchObject({ v: 2, machine: "pc", session: "poe-bot@pc", limit: 50 });
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      expect(first.since).toBe(midnight.toISOString());
      expect(t.$(".cw-lr")!.textContent).toContain("x1 · w · y");
      await t.click(t.btn(".cw-log", "stop"));
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ kind: ["stop"] });
      await t.click(t.btn(".cw-log", "дальше →"));
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ since: "2026-11-01T06:00:00.000Z" });
      expect(t.$$(".cw-lr")).toHaveLength(2);
      await t.click(t.btn(".cw-log", "Раньше"));
      const yest = new Date(midnight);
      yest.setDate(yest.getDate() - 1);
      expect(relay.sent("machine.journal").at(-1)).toMatchObject({ since: yest.toISOString() });
    });

    it("время записи — ЧЧ:ММ:СС; не дата — как пришло", async () => {
      // источник: комментарий старого кода, сверка 6 нояб.
      const relay = relayFor(roster());
      const at = new Date(2026, 10, 1, 9, 5, 7).toISOString();
      relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [rec(at, "x")], more: false } });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("log");
      expect(t.$(".cw-lr span")!.textContent).toBe("09:05:07");
    });

    it("4094 · отказ machine.journal — «machine.journal: слово», без «Записей нет»", async () => {
      const relay = relayFor(roster());
      relay.handlers["machine.journal"] = () => ({ ok: false, error: "offline" });
      const t = await wideCard("poe-bot@pc", roster(), relay);
      await t.tab("log");
      expect(t.$(".cw-log")!.textContent).toContain("machine.journal: offline");
      expect(t.$(".cw-log")!.textContent).not.toContain("Записей нет.");
    });

  });

  describe("видимое (чьё: код)", () => {
    it("V-C1 · шапка: название кнопки имён; окон и меню нет", async () => {
      const t = await wideCard("site@laptop");
      expect(t.$('[data-act="names"]')!.getAttribute("aria-label")).toBe("Имена сессии и машины");
      expect(t.$(".cw-h [data-pop]")).toBeNull();
      expect(t.$('.cw-h [role="dialog"], .cw-h [role="menu"]')).toBeNull();
    });

    it("V-C2 · настройки: подписи разделов, заголовок, текст подтверждения удаления", async () => {
      const t = await wideCard("poe-bot@pc");
      await t.tab("set");
      expect(t.$$(".cw-set .pt-k").map((x) => x.textContent).filter(Boolean)).toEqual(["Профиль", "Модель", "Слот", "Усилие"]);
      expect(t.$$(".cw-set .lb").map((x) => x.textContent)).toEqual(["Заголовок", "Сессия"]);
      expect(t.$('[data-sec="fast"]')!.textContent).toContain("Быстрый режим");
      expect(t.$<HTMLInputElement>('[data-f="title"]')!.placeholder).toBe("Заголовок в claude.ai");
      await t.click(t.btn(".cw-set", "Убрать…"));
      expect(t.$(".sb-confirm")!.textContent).toContain("poe-bot@pc остановится и уйдёт из списка. Точки в R2 останутся.");
    });

    it("V-C3 · «Сведения»: дерево — кто открыл и кого ведёт, переход к дочерней; слова состояний MCP; ссылка входа", async () => {
      const r = roster([], (x) => {
        Object.assign(x.sessions[0], { parent: "lead@pc" });
        x.sessions.push({ callsign: "kid@laptop", state: "idle", parent: "site@laptop" } as never);
      });
      const relay = relayFor(r);
      relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "a", status: "pending" }, { name: "b", status: "disabled" }, { name: "c", status: "needs-auth" }, { name: "d", status: "connected" }, { name: "e", status: "странное" }] } : f.method === "mcpAuthenticate" ? { ok: true, result: { authUrl: "https://example.com/l" } } : { ok: true, result: null });
      const t = await wideCard("site@laptop", r, relay);
      await t.tab("info");
      await flush();
      const aside = t.$("aside.cw-info")!;
      expect(aside.getAttribute("aria-label")).toBe("Сведения");
      expect([...aside.querySelectorAll("h4")].map((x) => x.textContent)).toEqual(["Сведения", "Аккаунт", "Дерево", "Серверы MCP"]);
      expect(aside.textContent).toContain("открылаlead@pc");
      expect([...aside.querySelectorAll(".cw-mcp-st")].map((x) => x.textContent)).toEqual(["подключается", "выключен", "нужен вход", "подключён", "странное"]);
      // выключенный: кнопка «вкл», переподключить нельзя
      expect(aside.querySelector('[data-mcp="b"]')!.textContent).toBe("вкл");
      expect(aside.querySelector('[data-mcp-re="b"]')).toBeNull();
      await t.click(aside.querySelector('[data-mcp-login="c"]'));
      await flush();
      expect(t.$('a[data-mcp-url="c"]')!.textContent).toBe("Открыть страницу входа ↗");
      await t.click(t.btn("aside.cw-info", "kid@laptop"));
      expect(location.hash).toBe("#card?callsign=kid%40laptop");
    });
  });
});

describe("Карточка: вкладка места", () => {
  describe("вкладка широкой карточки", () => {
    it("7290 · вставка места пропала, пока открыта — вкладка «Настройки», чужого экрана нет", async () => {
      // источник: чьё: код — без вкладки нет и её экрана; запасная вкладка широкого вида — «Настройки» (6929)
      let shown = true;
      let changed = () => {};
      const tabPart: AppPart = {
        manifest: { name: "t-tab", type: "web", version: "1.0.0", provides: { "t.tab": 1 }, uses: { "card.tab@web-card": 1 } },
        module: (app) => {
          changed = app.changed;
          return { screens: { "t.tab": { label: "Вставка", place: "card.tab", show: () => shown, view: () => createElement("div", { className: "t-tab" }) } } };
        },
      };
      const r = homeRoster();
      r.sessions[0].state = "idle";
      const callsign = r.sessions[0].callsign;
      const relay = new FakeRelay(r);
      for (const n of ["session.watch", "session.unwatch"]) relay.handlers[n] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const parts: AppPart[] = [{ manifest: boardM, module: createBoard }, { manifest: cardM, module: createCard }, { manifest: chatM, module: createChat }, { manifest: askM, module: createAsk }, { manifest: alertsM, module: createAlerts({}) }, tabPart];
      const t = await stand(parts, { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
      history.pushState(null, "", `/#card?callsign=${encodeURIComponent(callsign)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await flush();
      await t.click(t.$('.cw-tabs [data-tab="t.tab"]'));
      await flush();
      expect(t.$(".t-tab")).not.toBeNull();
      shown = false;
      changed();
      await flush();
      expect(t.$('.cw-tabs [data-tab="t.tab"]')).toBeNull();
      expect(t.$(".t-tab")).toBeNull();
      expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
    });
  });
});

describe("Карточка: имена", () => {
  it("V-C5 · окно «Имена» из карточки на пульте и телефоне: открывается и закрывается", async () => {
    const relay = fleetRelay();
    const t = await pult({ relay, url: "/#card?callsign=site%40laptop" });
    await flush(5);
    await t.click(t.$('.cw-h [data-act="names"]'));
    expect(t.$(".lb-dlg")).not.toBeNull();
    await t.click(t.$(".lb-veil"));
    expect(t.$(".lb-dlg")).toBeNull();
    const relay2 = new FakeRelay(homeRoster());
    relay2.handlers["session.watch"] = () => ({ ok: true });
    relay2.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const n = await stand([{ manifest: labelsM, module: createLabels }, { manifest: boardM, module: createBoard }, { manifest: cardM, module: createCard }, { manifest: chatM, module: createChat }, { manifest: askM, module: createAsk }, { manifest: alertsM, module: createAlerts({}) }], { relay: relay2, url: "/#card?callsign=site%40laptop&tab=info" });
    await flush(5);
    await n.click(n.$('.card-act[data-act="names"]'));
    expect(n.$(".lb-dlg")).not.toBeNull();
    await n.click(n.$(".lb-veil"));
    expect(n.$(".lb-dlg")).toBeNull();
  });
});

describe("Найдено сверкой деревьев", () => {
  // источник: чьё: код — разметка и правила, которые снимки и прежние леса не держали; сверка деревьев старого и нового кода 5 нояб.
  const accounts = () => ({ ok: true as const, result: { accounts: { y0902: { login: "ok", limits: { five_hour: { utilization: 0.42 }, seven_day: { utilization: 0.9 } } } }, slots: {} } });
  const cut = (...names: string[]) => {
    const r = fleetRoster();
    for (const m of r.machines) {
      m.contract = { ...m.contract };
      for (const n of names) delete m.contract[n];
    }
    return r;
  };

  it("карточка: процент на кнопке шапки — окно 5 ч; без журнала нет «Почему»; плашка и без причины", async () => {
    const relay = fleetRelay(cut("session.update", "machine.journal"));
    relay.handlers["machine.accounts"] = accounts;
    const t = await pult({ relay, url: "/#card?callsign=api%40pc" });
    await flush(5);
    expect(t.$('[data-go="info"]')!.textContent).toBe("y0902 · 42 %");
    expect(t.btn(t.$(".cw-pl"), "Почему")).toBeNull();
    const r = fleetRoster();
    r.sessions.find((s) => s.callsign === "docs@pc")!.state = "failed";
    const t2 = await pult({ relay: fleetRelay(r), url: "/#card?callsign=docs%40pc" });
    await flush(5);
    expect(t2.$(".cw-pl b")!.textContent).toBe("Не запустилась");
  });

  it("карточка: сессия ушла — вкладка настроек без кнопок, сведения пусты; без человеческого имени адрес в шапке не повторяется; ссылка claude.ai в сведениях", async () => {
    const r = fleetRoster();
    r.sessions.find((s) => s.callsign === "site@laptop")!.state = "idle";
    const relay = fleetRelay(r);
    const t = await pult({ relay, url: "/#card?callsign=site%40laptop&tab=info" });
    await flush(5);
    expect(t.$<HTMLAnchorElement>("aside.cw-info .cw-mi.flat")!.href).toBe("https://claude.ai/code/session_01Pf");
    relay.setRoster({ ...r, sessions: r.sessions.filter((s) => s.callsign !== "site@laptop") });
    await flush(5);
    expect(t.$("aside.cw-info")!.textContent).toBe("");
    await t.click(t.$('.cw-tabs [data-tab="set"]'));
    expect(t.$('[data-sec="ctl"] button')).toBeNull();
  });
});
