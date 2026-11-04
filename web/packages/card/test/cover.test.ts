// Покрытие плана action-card-settings: заголовок, журнал, лимиты, пуск и стоп, быстрый режим, кнопки по contract и состоянию, телефон.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore, type Roster } from "@switchboard/web-core";
import { createCard, manifest as cardM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";

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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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

  it("6995 · пуск и стоп: «Остановить» — session.stop; остановленная — «Запустить», session.start", async () => {
    // источник: чьё: код
    const t = await wideCard();
    await t.tab("set");
    await t.click(t.btn('[data-sec="ctl"]', "Остановить"));
    expect(t.relay.sent("session.stop")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
    const r = roster([], state("stopped"));
    const t2 = await wideCard(r, relayFor(r));
    await t2.tab("set");
    await t2.click(t2.btn('[data-sec="ctl"]', "Запустить"));
    expect(t2.relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
  });

  it("6997 · нажат текущий профиль и текущий слот: запроса нет", async () => {
    // источник: чьё: код
    const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { profile: { id: "team/profiles/ops", state: "ok" }, slot: { name: "main", wait: null } }));
    const relay = relayFor(r);
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {} } } });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "a", order: ["a"] } } } });
    const t = await wideCard(r, relay);
    await t.tab("set");
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    await t.click(t.$('[data-sec="slot"] [data-slot="main"]'));
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
    relay.handlers["session.remove"] = () => ({ ok: true });
    const t = await wideCard(r, relay);
    await t.tab("set");
    await t.click(t.btn(".cw-set", "Убрать…"));
    await t.click(t.btn(".cw-confirm", "Отмена"));
    expect(t.$(".cw-confirm")).toBeNull();
    expect(relay.sent("session.remove")).toHaveLength(0);
    await t.click(t.btn(".cw-set", "Убрать…"));
    const before = location.hash;
    await t.click(t.btn(".cw-confirm", "Убрать"));
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
    await t.click(t.btn(".cw-log", "Раньше"));
    expect(t.$(".cw-log")!.textContent).toContain("с 1 дн. назад");
    expect(t.$(".cw-log")!.textContent).toContain("вчера");
  });

  it("6994 · окна лимитов: жёлтая с 70, красная с 90", async () => {
    // источник: устав персоны — дубликат логики сведён: пороги — одно правило набора
    const rr = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { account: "y0902" }));
    const relay = relayFor(rr);
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "a@x", limits: { five_hour: { utilization: 0.75 }, seven_day: { utilization: 0.92 }, seven_day_opus: { utilization: 0.1 } } } } } });
    const t = await wideCard(rr, relay);
    await t.click(t.$('[data-pop="acc"]'));
    await flush();
    const bar = (w: string) => t.$(`.cw-pop [data-win="${w}"] .sb-barw`)!.className;
    expect(bar("five_hour")).toContain("warn");
    expect(bar("seven_day")).toContain("bad");
    expect(bar("seven_day_opus")).not.toMatch(/warn|bad/);
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

  it("6937 · на время запроса кнопки неактивны; модель — session.update, стоп — session.stop", async () => {
    // источник: чьё: код
    const r = roster();
    const relay = relayFor(r);
    relay.handlers["session.update"] = () => undefined;
    const t = await narrow(r, relay);
    await t.click(t.$('[data-pick="model"] button'));
    const sent = relay.sent("session.update").at(-1)!;
    expect(sent).toHaveProperty("model");
    expect(t.button("Остановить")!.disabled).toBe(true);
    relay.reply(sent.id!, { ok: true });
    await flush();
    expect(t.button("Остановить")!.disabled).toBe(false);
    relay.handlers["session.stop"] = () => ({ ok: true });
    await t.click(t.button("Остановить"));
    expect(relay.sent("session.stop")).toHaveLength(1);
  });

  it("6938 · отказ: «Не вышло» и «запрос: слово»; следующее действие снимает прошлое слово", async () => {
    // источник: устав — отказ словом
    const r = roster();
    const relay = relayFor(r);
    relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
    relay.handlers["session.update"] = () => undefined;
    const t = await narrow(r, relay);
    await t.click(t.button("Остановить"));
    expect(t.text()).toContain("Не вышло");
    expect(t.text()).toContain("session.stop: stopping");
    await t.click(t.$('[data-pick="model"] button'));
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

  it("7233 · машина перезапустилась (новый since) — ответ перечитан, прежний показан до нового", async () => {
    // чьё: код — web/packages/ui/src/hooks.ts useMachineLoad
    const r = roster();
    const relay = relayFor(r);
    await wideCard(r, relay);
    await flush();
    expect(relay.sent("machine.accounts")).toHaveLength(1);
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: 2 } : m)) });
    await flush();
    expect(relay.sent("machine.accounts")).toHaveLength(2);
  });

  it("7234 · страница вернулась: настройка карточки из другой вкладки прочитана заново", async () => {
    // чьё: код — повторный start модулей при возвращении до 4 нояб.; start теперь один раз
    const store = memoryStore({ key: KEY });
    const r = roster();
    const relay = relayFor(r);
    const t = await stand(parts(), { relay, store, wide: true, url: "/#card?callsign=poe-bot%40pc" });
    await flush();
    expect(t.$("aside.cw-info")).toBeNull();
    // уход с экрана доводит начатые запросы: ответить на те, что без подделки
    for (const f of relay.got) if (typeof f.id === "string") relay.reply(f.id, { ok: true, result: null });
    await flush();
    await t.run.hide();
    store.data["card.info"] = true;
    await t.run.show();
    await flush();
    expect(t.$("aside.cw-info")).not.toBeNull();
  });
});

describe("E6 · чтение не ответило", () => {
  afterEach(() => vi.useRealTimers());

  it("E6 · слот, профиль, заголовок и серверы MCP: через 10 с слово на месте данных, а не «без слота» и не пусто", async () => {
    // источник: слово пользователя 4 нояб. — «таймаут операций на запрос метадаты 10 секунд»; дизайн «Что видит человек при отказе»
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const r = roster([], (x) => void Object.assign(x.sessions.find((s) => s.callsign === "poe-bot@pc")!, { slot: { name: "main", wait: null }, profile: { id: "team/profiles/ops", state: "ok" } }));
    const relay = relayFor(r);
    for (const n of ["machine.accounts", "machine.profiles", "session.spec", "session.call"]) relay.handlers[n] = () => undefined as never;
    const t = await wideCard(r, relay);
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-act="info"]'));
    await t.tab("set");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(t.$('[data-refused="slot"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(t.$('[data-refused="slot"]')!.textContent).toBe("main · timeout");
    expect(t.$('[data-sec="slot"] [data-slot=""]')).toBeNull();
    expect(t.$('[data-refused="profile"]')!.textContent).toBe("ops · timeout");
    expect(t.$('[data-refused="title"]')!.textContent).toBe("timeout");
    expect(t.$('[data-refused="mcp"]')!.textContent).toBe("timeout");
  });
});
