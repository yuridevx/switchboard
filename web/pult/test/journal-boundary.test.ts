// Леса границы «журнал и инциденты», сторона страницы: экраны журнала флота и инцидентов на настоящем пульте и телефоне, поддельный relay.
// Вход — адрес экрана, roster и ответы relay; исход — кадры relay, текст, классы и якоря разметки. Классы — контракт экрана: стили снаружи не меняются.
// Источник свойства — номер старого эталона в имени; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { flush, fleetRelay, fleetRoster, HOST, joinedRoster, pult } from "./stand.ts";
import { phoneParts } from "../../phone/stand/parts.ts";
import { FakeRelay, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";

type T = Awaited<ReturnType<typeof pult>>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;

describe("журнал флота", () => {
  const ev = (id: number, x: Record<string, unknown> = {}) => ({ id, t: Date.now(), ev: "session.opened", from: "laptop", text: `запись ${id}`, ...x });
  const evs = () => {
    const now = Date.now();
    return [
      { id: 3, t: now, ev: "session.opened", from: "laptop", by: "panel-desk", callsign: "a@laptop", text: "открыта a@laptop" },
      { id: 2, t: now - DAY, ev: "machine.left", from: ".relay", machine: "pc", text: "pc ушла" },
      { id: 1, t: now - 7 * DAY, ev: "points.deleted", from: ".points", text: "удалены точки old" },
    ];
  };
  async function journal(relay = fleetRelay()) {
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    return t;
  }
  const pick = async (t: T, m: string) => {
    const s = t.$<HTMLSelectElement>('[data-f="machine"]')!;
    s.value = m;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(5);
  };
  const ids = (t: T) => t.$$(".jr-r").map((x) => x.dataset.id);

  it("раздел «Журнал» в группе «Флот», заголовок «Журнал флота», поиск и выбор машин; своих запросов до открытия нет", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [], more: false } });
    const t = await pult({ relay });
    expect(relay.sent("ledger.read")).toHaveLength(0);
    expect(t.$('.sb-navcol button[data-screen="journal"]')!.textContent).toBe("Журнал");
    await t.go("#journal");
    expect(t.$(".sb-ph h2")!.textContent).toBe("Журнал флота");
    expect(t.$<HTMLInputElement>('[data-f="q"]')!.placeholder).toBe("⌕ поиск по записям");
    expect(t.$<HTMLInputElement>('[data-f="q"]')!.type).toBe("search");
    expect(t.$$('[data-f="machine"] option').map((o) => [o.getAttribute("value"), o.textContent])).toEqual([["", "все машины"], ["laptop", "@laptop"], ["pc", "@pc"]]);
    expect(t.$("[data-ledger]")).not.toBeNull();
  });

  it("4159 · записи новые сверху по дням — «Сегодня», «Вчера», дата; время; текст как прислал ledger, «by»; справа — адрес, машина или from", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs(), more: false } });
    const t = await journal(relay);
    expect(relay.sent("ledger.read")[0]).toMatchObject({ to: ".ledger", limit: 50 });
    const old = new Date(Date.now() - 7 * DAY);
    expect(t.$$(".jr-day").map((x) => x.textContent)).toEqual(["Сегодня", "Вчера", old.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })]);
    expect(ids(t)).toEqual(["3", "2", "1"]);
    const r3 = t.$('.jr-r[data-id="3"]')!;
    expect(r3.textContent).toContain("открыта a@laptop · by panel-desk");
    expect(r3.querySelector(".by")!.textContent).toBe(" · by panel-desk");
    expect(r3.querySelector("em")!.textContent).toBe("a@laptop");
    expect(t.$('.jr-r[data-id="2"] em')!.textContent).toBe("@pc");
    expect(t.$('.jr-r[data-id="1"] em')!.textContent).toBe(".points");
    expect(t.$('.jr-r[data-id="1"] .by')).toBeNull();
  });

  it("время записи — часы страницы, ЧЧ:ММ", async () => {
    const d = new Date(2026, 9, 31, 9, 5);
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(1, { t: d.getTime() })], more: false } });
    const t = await journal(relay);
    expect(t.$(".jr-r")!.children[0].textContent).toBe("09:05");
  });

  it("7354 · имя машины вместо адреса: справа в строке и в выборе машин", async () => {
    // источник: дизайн «Сессии, проекты и профили» — имя заменяет адрес в интерфейсе
    const relay = Object.assign(fleetRelay(), { scoped: { global: { "fleet.labels": { sessions: {}, machines: { laptop: "Домашний ПК" } } } } });
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ id: 1, t: Date.now(), ev: "x", from: "@laptop", machine: "laptop", text: "событие" }], more: false } });
    const t = await pult({ relay });
    await t.go("#journal");
    expect(t.$(".jr-r em")!.textContent).toBe("Домашний ПК");
    expect(t.$$('[data-f="machine"] option').map((o) => o.textContent)).toContain("Домашний ПК");
  });

  it("машины выбора: на связи и из записей, по алфавиту, без повторов", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(2, { machine: "old" }), ev(1, { machine: "pc" })], more: false } });
    const t = await journal(relay);
    expect(t.$$('[data-f="machine"] option').map((o) => o.getAttribute("value"))).toEqual(["", "laptop", "old", "pc"]);
  });

  it("6930 · выбор машины: чтение и дочитывание с той же machine; «все машины» — без поля", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(5)], more: false } });
    const t = await journal(relay);
    await pick(t, "pc");
    expect(relay.sent("ledger.read").at(-1)).toMatchObject({ machine: "pc", limit: 50 });
    relay.setRoster(joinedRoster());
    await flush(5);
    expect(relay.sent("ledger.read").at(-1)).toMatchObject({ machine: "pc", after: 5, limit: 50 });
    await pick(t, "");
    expect(relay.sent("ledger.read").at(-1)).not.toHaveProperty("machine");
  });

  it("6931 · дочитывание без повторов: новые сверху, «Раньше» как было", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = (f) => ({ ok: true, result: f.after ? { events: [ev(6), ev(5)], more: false } : { events: [ev(5)], more: true } });
    const t = await journal(relay);
    relay.setRoster(joinedRoster());
    await flush(5);
    expect(ids(t)).toEqual(["6", "5"]);
    expect(t.button("Раньше")).not.toBeNull();
  });

  it("7290 · roster без смены состава журнал не читает; смена состава, новый since машины и возврат связи — дочитывают", async () => {
    // источник: слепой архитектор 4 нояб. — лишний ledger.read на каждый roster; журнал пишется при входе и уходе
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(5)], more: false } });
    await journal(relay);
    const n = relay.sent("ledger.read").length;
    relay.setRoster(fleetRoster());
    await flush(5);
    expect(relay.sent("ledger.read")).toHaveLength(n);
    relay.setRoster(joinedRoster());
    await flush(5);
    expect(relay.sent("ledger.read")).toHaveLength(n + 1);
    const r = joinedRoster();
    r.machines[0].since += 1;
    relay.setRoster(r);
    await flush(5);
    expect(relay.sent("ledger.read")).toHaveLength(n + 2);
  });

  it("6932 · журнал пуст: «Записей нет.», по roster снова чтение без after", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [], more: false } });
    const t = await journal(relay);
    expect(t.text()).toContain("Записей нет.");
    relay.setRoster(joinedRoster());
    await flush(5);
    expect(relay.sent("ledger.read")).toHaveLength(2);
    expect(relay.sent("ledger.read")[1]).not.toHaveProperty("after");
  });

  it("чтение идёт: «…», строк нет", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => undefined;
    const t = await journal(relay);
    expect(t.$("[data-ledger]")!.textContent).toBe("…");
  });

  it("6933 · записи кончились: «Раньше» — before самой старой, дописывает и исчезает; есть ещё — кнопка остаётся", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = (f) => ({ ok: true, result: f.before === 5 ? { events: [ev(4)], more: true } : f.before === 4 ? { events: [ev(3)], more: false } : { events: [ev(5)], more: true } });
    const t = await journal(relay);
    await t.click(t.button("Раньше"));
    expect(relay.sent("ledger.read").at(-1)).toMatchObject({ before: 5, limit: 50 });
    expect(ids(t)).toEqual(["5", "4"]);
    expect(t.button("Раньше")).not.toBeNull();
    await t.click(t.button("Раньше"));
    expect(relay.sent("ledger.read").at(-1)).toMatchObject({ before: 4 });
    expect(ids(t)).toEqual(["5", "4", "3"]);
    expect(t.button("Раньше")).toBeNull();
  });

  it("6934 · поиск: по тексту, виду, машине, адресу, by; без регистра; мимо — «Записей нет.»; новых запросов нет", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(5, { text: "Сборка" }), ev(4, { ev: "slot.swapped" }), ev(3, { machine: "pc" }), ev(2, { callsign: "a@b" }), ev(1, { by: "agent" })], more: false } });
    const t = await journal(relay);
    const n = relay.sent("ledger.read").length;
    for (const [q, id] of [["сборка", "5"], ["slot.swapped", "4"], ["PC", "3"], ["a@b", "2"], ["agent", "1"]]) {
      await t.type(t.$('[data-f="q"]'), q);
      expect(ids(t)).toEqual([id]);
    }
    await t.type(t.$('[data-f="q"]'), "нет такого");
    expect(t.$("[data-ledger]")!.textContent).toBe("Записей нет.");
    await t.type(t.$('[data-f="q"]'), "  ");
    expect(ids(t)).toHaveLength(5);
    expect(relay.sent("ledger.read")).toHaveLength(n);
  });

  it("поиск переживает смену машины", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(5, { text: "сборка" }), ev(4)], more: false } });
    const t = await journal(relay);
    await t.type(t.$('[data-f="q"]'), "сборка");
    await pick(t, "pc");
    expect(t.$<HTMLInputElement>('[data-f="q"]')!.value).toBe("сборка");
    expect(ids(t)).toEqual(["5"]);
  });

  it("6935 · открытие заново: чтение без machine, прежних записей нет", async () => {
    // источник: факт — записи живут только на экране
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = (f) => ({ ok: true, result: { events: f.machine ? [ev(9)] : [ev(1)], more: false } });
    const t = await journal(relay);
    await pick(t, "pc");
    expect(ids(t)).toEqual(["9"]);
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    await flush(5);
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    expect(relay.sent("ledger.read").at(-1)).not.toHaveProperty("machine");
    expect(ids(t)).toEqual(["1"]);
  });

  it("6521 · быстрая смена машины: опоздавший ответ прежней не перекрывает выбранную", async () => {
    // источник: слепой архитектор 4 нояб.: чтение журнала шло без отмены устаревшего ответа
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs(), more: false } });
    const t = await journal(relay);
    relay.handlers["ledger.read"] = () => undefined;
    await pick(t, "pc");
    await pick(t, "laptop");
    const [late, now] = relay.sent("ledger.read").slice(-2) as Array<{ id: string; machine: string }>;
    expect([late.machine, now.machine]).toEqual(["pc", "laptop"]);
    relay.reply(now.id, { ok: true, result: { events: [ev(20, { machine: "laptop" })], more: false } });
    await flush();
    relay.reply(late.id, { ok: true, result: { events: [ev(10, { machine: "pc" })], more: true } });
    await flush();
    expect(ids(t)).toEqual(["20"]);
    expect(t.button("Раньше")).toBeNull();
  });

  it("4160 · отказ ledger.read — «ledger.read: слово» тревогой", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "unknown_request" });
    const t = await journal(relay);
    expect(t.$('[role="alert"]')!.textContent).toBe("ledger.read: unknown_request");
  });

  it("4161 · экран закрыт или чтение идёт — roster не шлёт ledger.read", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => undefined;
    const t = await journal(relay);
    relay.setRoster(fleetRoster());
    await flush();
    expect(relay.sent("ledger.read")).toHaveLength(1);
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    relay.reply(relay.sent("ledger.read")[0].id!, { ok: true, result: { events: [], more: false } });
    relay.setRoster(joinedRoster());
    await flush();
    expect(relay.sent("ledger.read")).toHaveLength(1);
  });

  it("4162 · первое чтение отказало — следующий roster читает всё заново, строка отказа снята", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "disconnected" });
    const t = await journal(relay);
    expect(t.text()).toContain("ledger.read: disconnected");
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs().slice(0, 2), more: false } });
    relay.setRoster(joinedRoster());
    await flush();
    expect(relay.sent("ledger.read").at(-1)).not.toHaveProperty("after");
    expect(t.text()).not.toContain("ledger.read: disconnected");
    expect(ids(t)).toEqual(["3", "2"]);
  });

  it("6936 · обрыв на «Раньше»: записи на месте, слово видно; связь вернулась — дочитано after, слово снято", async () => {
    // источник: устав — соединение оборвалось, клиенты переподключаются
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(5)], more: true } });
    const t = await journal(relay);
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "disconnected" });
    await t.click(t.button("Раньше"));
    expect(ids(t)).toEqual(["5"]);
    expect(t.text()).toContain("ledger.read: disconnected");
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [ev(6)], more: false } });
    relay.setRoster(joinedRoster());
    await flush(5);
    expect(relay.sent("ledger.read").at(-1)).toMatchObject({ after: 5 });
    expect(t.text()).not.toContain("ledger.read: disconnected");
    expect(ids(t)).toEqual(["6", "5"]);
  });
});

describe("инциденты", () => {
  /** Флот с двумя сессиями инцидентов (одна закрыта) и обращением с отказом доставки на диске pc. */
  function incRelay(delivered = false) {
    const r: Roster = fleetRoster();
    r.sessions = [
      ...r.sessions,
      { callsign: "build-red@laptop", state: "busy", incident: { type: "build-red", key: "switchboard#main" } },
      { callsign: "disk-old@pc", state: "stopped", incident: { type: "disk-full", key: "/" } },
    ];
    const relay = fleetRelay(r);
    // обращение a1 на диске pc: сессия не открылась; delivered — ход его уже взял, на диске его нет
    relay.handlers["incident.pending"] = (f) => ({
      ok: true,
      result: {
        appeals:
          f.machine === "pc" && !delivered
            ? [{ id: "a1", type: "gpu-temp", key: "gpu-b", callsign: null, word: "no_profile", why: "профиль you/profiles/gpu-temp не найден; обращение ждёт на диске до старта Host или следующего обращения", t: new Date(2026, 9, 31, 8, 7).toISOString() }]
            : [],
      },
    });
    return relay;
  }
  const incidents = async (relay = incRelay()) => {
    const t = await pult({ relay, url: "/#incidents" });
    await flush(10);
    return t;
  };
  const list = (t: T) => t.$$("[data-incident]").map((x) => x.getAttribute("data-incident"));

  it("6907 · «В сессиях» — сессии с полем roster incident: тип, ключ, состояние; закрытая — только во «все»; нажатие — карточка сессии; метка раздела — открытые и недоставленные", async () => {
    const t = await incidents();
    expect(list(t)).toEqual(["build-red@laptop"]);
    const row = t.$('[data-incident="build-red@laptop"]')!;
    expect(row.querySelector(".t1 b")!.textContent).toBe("build-red");
    expect(row.querySelector(".k")!.textContent).toBe("switchboard#main");
    expect(row.querySelector(".s")!.textContent).toBe("работает");
    expect(row.querySelector(".t2")!.textContent).toBe("build-red · @laptop");
    expect(row.querySelector(".t2 .m")!.textContent).toBe("build-red");
    expect(row.querySelector(".d")).not.toBeNull();
    expect(t.$('[data-f="open"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-f="all"]')!.getAttribute("aria-pressed")).toBe("false");
    await t.click(t.$('[data-f="all"]'));
    expect(t.$('[data-f="all"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('[data-f="open"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(list(t)).toEqual(["build-red@laptop", "disk-old@pc"]);
    expect(t.$('[data-incident="disk-old@pc"] .s')!.textContent).toBe("закрыт");
    expect(t.$('.sb-navcol [data-screen="incidents"]')!.textContent).toBe("Инциденты2");
    await t.click(row);
    expect(location.hash).toBe("#card?callsign=build-red%40laptop");
  });

  it("надписи разделов и кнопок; сессия без ключа — без поля ключа; широкий пульт — заголовок", async () => {
    const r = fleetRoster();
    r.sessions = [...r.sessions, { callsign: "x@pc", state: "idle", incident: { type: "t" } }];
    const relay = fleetRelay(r);
    relay.handlers["incident.pending"] = () => ({ ok: true, result: { appeals: [] } });
    const t = await incidents(relay);
    expect(t.$$(".in-cap").map((x) => x.textContent)).toEqual(["В сессиях"]);
    expect([t.$('[data-f="open"]')!.textContent, t.$('[data-f="all"]')!.textContent]).toEqual(["открытые", "все"]);
    expect(t.$('[data-incident="x@pc"] .k')).toBeNull();
    expect(t.$(".sb-ph h2")!.textContent).toBe("Инциденты");
    expect(t.$('.sb-navcol [data-screen="incidents"]')!.textContent).toBe("Инциденты1");
  });

  it("у строки — имя сессии и машины вместо адреса", async () => {
    const relay = Object.assign(incRelay(), { scoped: { global: { "fleet.labels": { sessions: { "build-red@laptop": "Сборка" }, machines: { laptop: "Домашний ПК", pc: "Сервер" } } } } });
    const t = await incidents(relay);
    expect(t.$('[data-incident="build-red@laptop"] .t2')!.textContent).toBe("Сборка · Домашний ПК");
    expect(t.$('[data-lost="pc:a1"] .t1 b')!.textContent).toBe("Сервер");
  });

  it("5405 · «Не доставлены» — обращения без сессии с последним отказом доставки; нажатие — причина словами, ещё раз — свёрнуто", async () => {
    const relay = incRelay();
    const t = await incidents(relay);
    expect(relay.sent("incident.pending").map((f) => f.machine)).toEqual(expect.arrayContaining(["pc", "laptop"]));
    expect(t.$$(".in-cap").map((x) => x.textContent)).toEqual(["Не доставлены", "В сессиях"]);
    const lost = t.$$("[data-lost]");
    expect(lost.map((x) => x.getAttribute("data-lost"))).toEqual(["pc:a1"]);
    expect(lost[0].classList.contains("in-row")).toBe(true);
    expect(lost[0].classList.contains("in-lost")).toBe(true);
    expect(lost[0].querySelector(".t1 b")!.textContent).toBe("@pc");
    expect(lost[0].querySelector(".s.bad")!.textContent).toBe("no_profile");
    expect(lost[0].querySelector(".t2")!.textContent).toBe("с 08:07");
    expect(lost[0].getAttribute("aria-expanded")).toBe("false");
    expect(t.$('[data-why="pc:a1"]')).toBeNull();
    await t.click(lost[0]);
    expect(t.$('[data-lost="pc:a1"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(t.$('[data-why="pc:a1"]')!.textContent).toBe("профиль you/profiles/gpu-temp не найден; обращение ждёт на диске до старта Host или следующего обращения");
    expect(t.$('[data-why="pc:a1"]')!.classList.contains("in-why")).toBe(true);
    await t.click(t.$('[data-lost="pc:a1"]'));
    expect(t.$('[data-why="pc:a1"]')).toBeNull();
  });

  it("новые обращения сверху; без причины — слово; обращение с сессией не показывается", async () => {
    const r: Roster = fleetRoster();
    const relay = fleetRelay(r);
    relay.handlers["incident.pending"] = (f) => ({ ok: true, result: { appeals: f.machine === "pc" ? [{ id: "a1", callsign: null, word: "no_profile", why: "новая причина", t: "2026-10-31T08:20:00.000Z" }, { id: "a2", callsign: null, word: "bad_dir", t: "2026-10-31T08:10:00.000Z" }, { id: "a3", callsign: "x@pc", word: "stopped", why: "ушло в сессию", t: "2026-10-31T08:30:00.000Z" }] : [] } });
    const t = await incidents(relay);
    expect(t.$$("[data-lost]").map((x) => x.getAttribute("data-lost"))).toEqual(["pc:a2", "pc:a1"]);
    expect(t.$('[data-lost="pc:a1"] .s')!.textContent).toBe("no_profile");
    await t.click(t.$('[data-lost="pc:a2"]'));
    expect(t.$('[data-why="pc:a2"]')!.textContent).toBe("bad_dir");
    await t.click(t.$('[data-lost="pc:a1"]'));
    expect(t.$('[data-why="pc:a2"]')).toBeNull();
    expect(t.$('[data-why="pc:a1"]')!.textContent).toBe("новая причина");
  });

  it("5406 · обращение доставлено (его нет в incident.pending) — в «Не доставлены» его нет; метка считает только открытые", async () => {
    // источник: отложенная половина делай 3 нояб.: «недоставленное, потом доставленное — висит до полуночи»
    const relay = incRelay(true);
    const t = await incidents(relay);
    expect(relay.sent("incident.pending").map((f) => f.machine)).toContain("pc");
    expect(t.$$("[data-lost]")).toHaveLength(0);
    expect(t.$$(".in-cap").map((x) => x.textContent)).toEqual(["В сессиях"]);
    expect(t.$('.sb-navcol [data-screen="incidents"]')!.textContent).toBe("Инциденты1");
  });

  it("обращение ждёт на диске без отказа: строка есть, в метке считается, тип и ключ вместо времени", async () => {
    // источник: опыт 5 нояб. — обращение лежало на диске, экран говорил «Открытых инцидентов нет»
    const relay = fleetRelay();
    relay.handlers["incident.pending"] = (f) => ({ ok: true, result: { appeals: f.machine === "pc" ? [{ id: "a1", type: "gpu-temp", key: "gpu-b", callsign: null }, { id: "a2", type: "disk", key: null, callsign: null }, { id: "a3", type: "x", key: null, callsign: "x@pc" }] : [] } });
    const t = await incidents(relay);
    expect(t.$$("[data-lost]").map((x) => x.getAttribute("data-lost"))).toEqual(["pc:a2", "pc:a1"]);
    expect(t.$('[data-lost="pc:a1"] .s.bad')!.textContent).toBe("ждёт");
    expect(t.$('[data-lost="pc:a1"] .t2')!.textContent).toBe("gpu-temp · gpu-b");
    expect(t.$('[data-lost="pc:a2"] .t2')!.textContent).toBe("disk");
    expect(t.$('.sb-navcol [data-screen="incidents"]')!.textContent).toBe("Инциденты2");
    await t.click(t.$('[data-lost="pc:a1"]'));
    expect(t.$('[data-why="pc:a1"]')!.textContent).toBe("Отказа не записано: причина — в журнале машины.");
  });

  it("пусто: «Открытых инцидентов нет», во «все» — «Инцидентов нет»", async () => {
    const relay = fleetRelay();
    relay.handlers["incident.pending"] = () => ({ ok: true, result: { appeals: [] } });
    const t = await incidents(relay);
    expect(t.text()).toContain("Открытых инцидентов нет");
    await t.click(t.$('[data-f="all"]'));
    expect(t.text()).toContain("Инцидентов нет");
    expect(t.text()).not.toContain("Открытых инцидентов нет");
    expect(t.$('.sb-navcol [data-screen="incidents"]')!.textContent).toBe("Инциденты");
  });

  it("отказ списка — «машина · incident.pending: слово» тревогой, другая машина показана; успешное чтение снимает", async () => {
    const relay = incRelay();
    relay.handlers["incident.pending"] = (f) => ({ ok: false, error: f.machine === "pc" ? "unknown_request" : "offline" });
    const t = await incidents(relay);
    const alerts = () => t.$$('[role="alert"]').map((x) => x.textContent).filter(Boolean);
    expect(alerts()).toEqual(expect.arrayContaining(["laptop · incident.pending: offline", "pc · incident.pending: unknown_request"]));
    relay.handlers["incident.pending"] = () => ({ ok: true, result: { appeals: [] } });
    await t.go("#board");
    await t.go("#incidents");
    expect(alerts()).toEqual([]);
  });

  it("список читается на первом roster для метки и при открытии экрана; новый roster спрашивает только новую машину; машина без incident не спрашивается", async () => {
    const r = fleetRoster();
    r.machines = [r.machines[0], { ...r.machines[1], contract: Object.fromEntries(Object.entries(HOST).filter(([k]) => k !== "incident")) }];
    const relay = fleetRelay(r);
    relay.handlers["incident.pending"] = () => ({ ok: true, result: { appeals: [] } });
    const t = await pult({ relay });
    await flush(10);
    expect(relay.sent("incident.pending").map((f) => f.machine)).toEqual(["laptop"]);
    relay.setRoster(fleetRoster());
    await flush(10);
    expect(relay.sent("incident.pending").map((f) => f.machine)).toEqual(["laptop", "pc"]);
    relay.setRoster(fleetRoster());
    await flush(10);
    expect(relay.sent("incident.pending")).toHaveLength(2);
    await t.go("#incidents");
    expect(relay.sent("incident.pending").map((f) => f.machine).sort()).toEqual(["laptop", "laptop", "pc", "pc"]);
  });

  it("поиск Ctrl K: строка «тип · адрес» с подсказкой «инцидент» ведёт на экран; ищет по типу, ключу, адресу", async () => {
    const t = await pult({ relay: incRelay(), url: "/#board" });
    await flush(10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
    const found = async (q: string) => {
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      return [...document.querySelectorAll(".sb-palit")].filter((x) => x.querySelector(".k")?.textContent === "инцидент");
    };
    const labels = (xs: Element[]) => xs.map((x) => x.querySelector(".l")!.textContent);
    expect(labels(await found("build-red"))).toEqual(["build-red · build-red@laptop"]);
    expect(labels(await found("SWITCHBOARD#"))).toEqual(["build-red · build-red@laptop"]);
    const old = await found("disk-old");
    expect(labels(old)).toEqual(["disk-full · disk-old@pc"]);
    expect(old[0].querySelector(".sb-dot, [class*='dot']")).not.toBeNull();
    await t.click(old[0]);
    expect(location.hash).toBe("#incidents");
  });

  it("5175 · телефон: раздел «Инциденты» во «Флоте», экран тот же; запрос тот же", async () => {
    const r: Roster = fleetRoster();
    r.sessions = [...r.sessions, { callsign: "build-red@laptop", state: "busy", incident: { type: "build-red", key: "k" } }];
    const relay = new FakeRelay(r);
    relay.handlers["incident.pending"] = () => ({ ok: true, result: { appeals: [] } });
    const t = await stand(phoneParts(fakeBrowser("granted")), { relay, url: "/#incidents", wide: false, options: { sections: ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"] } });
    await flush(10);
    expect(t.$('[data-incident="build-red@laptop"]')).not.toBeNull();
    // узкий вид: заголовок даёт оболочка
    expect(t.$(".sb-ph h2")).toBeNull();
    expect(relay.sent("incident.pending").length).toBeGreaterThan(0);
    expect(t.$$(".sb-navrow .sb-nv").map((x) => x.textContent)).toContain("Инциденты1");
  });
});
