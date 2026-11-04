// Покрытие плана: форма новой сессии (action-open-form). Сценарии, которых не было в прежних тестах.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

type T = Awaited<ReturnType<typeof pult>>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function openRelay(r: Roster = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", wait: null, sessions: [] }, night: { account: "b", wait: null, sessions: [] } } } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high" } }, repos: {} } });
  relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["api", "site"] } });
  relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
  relay.handlers["session.r2"] = () => ({ ok: true, result: { point: 1 } });
  relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u1" } });
  return relay;
}

async function openScreen(relay = openRelay(), url = "/#open?machine=laptop&dir=~%2Fsite") {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
}
const named = (t: T, v: string) => t.type(t.$('[data-f="name"]'), v);
const chipModel = (t: T) => t.$('[data-pop="model"]')!;
const chipProf = (t: T) => t.$('[data-pop="prof"] b')!.textContent;
const start = (t: T) => t.click(t.$('[data-act="open"]'));

describe("новая сессия: выбор", () => {
  it("7254 · машина научилась точкам при открытом окне модели — переключатель появляется", async () => {
    // источник: чьё: код — переключатель виден, когда машина умеет session.r2; roster меняется и при открытом окне
    const relay = openRelay();
    const without = fleetRoster();
    without.machines = without.machines.map((m) => {
      const contract = { ...m.contract };
      delete contract["session.r2"];
      return { ...m, contract };
    });
    relay.setRoster(without);
    const t = await openScreen(relay);
    await t.click(chipModel(t));
    expect(t.$("[data-r2]")).toBeNull();
    relay.setRoster(fleetRoster());
    await flush(5);
    expect(t.$("[data-r2]")).not.toBeNull();
  });

  it("6910 · другая машина: профиль и слот снова по умолчанию", async () => {
    // источник: чьё: код — выбранных там может не быть
    const t = await openScreen();
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    await t.click(chipModel(t));
    await t.click(t.$('[data-slot="night"]'));
    expect(chipModel(t).textContent).toContain("night");
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    expect(chipProf(t)).toBe("без профиля");
    expect(chipModel(t).textContent).toContain("main");
    expect(chipModel(t).textContent).not.toContain("night");
  });

  it("6911 · модель выбрана человеком: не следует за профилем; не выбрана — следует", async () => {
    // источник: чьё: код
    const t = await openScreen();
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    expect(chipModel(t).querySelector("b")!.textContent).toBe("opus");
    await t.click(chipModel(t));
    await t.click(t.$('[data-model="sonnet"]'));
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile=""]'));
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    expect(chipModel(t).querySelector("b")!.textContent).toBe("sonnet");
  });

  it("6912 · slots и profiles отказали: слово в окне своего чипа; форма работает, запуск доступен", async () => {
    // источник: устав — отказ словом
    const relay = openRelay();
    relay.handlers[SLOTS] = () => ({ ok: false, error: "offline" });
    relay.handlers["machine.profiles"] = () => ({ ok: false, error: "no_repo" });
    const t = await openScreen(relay);
    await t.click(t.$('[data-pop="prof"]'));
    expect(t.$(".op-pop")!.textContent).toContain("machine.profiles: no_repo");
    await t.click(chipModel(t));
    expect(t.$(".op-pop")!.textContent).toContain("machine.accounts: offline");
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")).toEqual([expect.objectContaining({ machine: "laptop", name: "a" })]);
  });

  it("6915 · модель уходит в session.open, только если выбрана", async () => {
    // источник: факт — модель значит, когда выбрана человеком
    const first = openRelay();
    const t = await openScreen(first);
    await t.click(t.$('[data-pop="prof"]'));
    await t.click(t.$('[data-profile="team/profiles/ops"]'));
    await named(t, "a");
    await start(t);
    expect(first.sent("session.open")[0]).toMatchObject({ profile: "team/profiles/ops" });
    expect(first.sent("session.open")[0]).not.toHaveProperty("model");
    expect(first.sent("session.open")[0]).not.toHaveProperty("effort");
    const second = openRelay();
    const t2 = await openScreen(second);
    await t2.click(chipModel(t2));
    await t2.click(t2.$('[data-model="sonnet"]'));
    await named(t2, "b");
    await start(t2);
    expect(second.sent("session.open")[0]).toMatchObject({ model: "sonnet" });
  });

  it("6918 · машина не умеет slots, profiles и r2: запросов нет, слов отказа нет, переключателя нет", async () => {
    // источник: факт — машина такого запроса не умеет: не спрашиваем, данных нет
    const r = fleetRoster();
    for (const n of ["machine.accounts", "machine.profiles", "session.r2"]) delete r.machines[0].contract![n];
    const relay = openRelay(r);
    const t = await openScreen(relay);
    await t.click(t.$('[data-pop="prof"]'));
    expect(t.$(".op-pop .op-err")).toBeNull();
    await t.click(chipModel(t));
    expect(t.$(".op-pop .op-err")).toBeNull();
    expect(t.$("[data-r2]")).toBeNull();
    await named(t, "a");
    await start(t);
    expect(relay.sent("machine.accounts")).toHaveLength(0);
    expect(relay.sent("machine.profiles")).toHaveLength(0);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
    expect(relay.sent("session.open")[0]).not.toHaveProperty("profile");
  });

  it("6922 · другая машина отказала: слоты и профиль прежней не показаны и не уходят в её session.open", async () => {
    // источник: факт — другая машина снова по умолчанию: выбранных там может не быть
    const relay = openRelay();
    const of = relay.handlers[SLOTS];
    relay.handlers[SLOTS] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : of(f));
    const op = relay.handlers["machine.profiles"];
    relay.handlers["machine.profiles"] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : op(f));
    const t = await openScreen(relay);
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    await t.click(chipModel(t));
    expect(t.$('[data-slot="main"]')).toBeNull();
    await t.click(t.$('[data-pop="prof"]'));
    expect(t.$('[data-profile="team/profiles/ops"]')).toBeNull();
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).toMatchObject({ machine: "pc" });
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
  });

  it("6924 · ответ другой машины ещё идёт: слот прежней в её session.open не уходит", async () => {
    // источник: то же; окно между выбором машины и ответом
    const relay = openRelay();
    const t = await openScreen(relay);
    relay.handlers[SLOTS] = () => undefined;
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).toMatchObject({ machine: "pc" });
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
  });
});

describe("новая сессия: старт формы", () => {
  it("6916 · адрес страницы: машины ещё нет — запуск неактивен; пришла — машина и папка из адреса", async () => {
    // источник: факт — машина может прийти своим соединением позже первого roster
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    const relay = openRelay(r);
    const t = await openScreen(relay, "/#open?machine=pc&dir=~%2Fx");
    expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(true);
    // машина pc вошла гостем: клиент флота открыл соединение с её relay
    const full = fleetRoster();
    full.clients = [...full.clients, "@pc"];
    relay.setRoster(full);
    await flush(10);
    expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(false);
    expect(t.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
    expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~/x");
  });

  it("6917 · без адреса: последнее своё место; мест нет — машина с большим числом сессий и домашняя папка; новый roster выбор не меняет", async () => {
    // источник: факт — правило старта, выбирается один раз
    const relay = openRelay();
    relay.values["pult-open.recent"] = [{ m: "pc", dir: "~/p" }];
    const t = await openScreen(relay, "/#open");
    expect(t.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
    expect(t.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~/p");

    const r = fleetRoster();
    r.sessions = r.sessions.filter((s) => s.callsign !== "site@laptop" && s.callsign !== "wiki@laptop");
    const relay2 = openRelay(r);
    const t2 = await openScreen(relay2, "/#open");
    expect(t2.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
    expect(t2.$<HTMLInputElement>('[data-f="addr"]')!.value).toBe("~");
    relay2.setRoster(fleetRoster({ sessions: r.sessions.filter((s) => s.callsign.endsWith("@laptop")) }));
    await flush(10);
    expect(t2.$('.op-bl [data-machine="pc"]')!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("новая сессия: запуск", () => {
  it("6913 · без задачи: session.prompt нет, место в последних, открыта карточка", async () => {
    // источник: факт — задача необязательна; запрос один, исхода два
    const relay = openRelay();
    const t = await openScreen(relay);
    await named(t, "a");
    await start(t);
    await flush(5);
    expect(relay.sent("session.open")).toHaveLength(1);
    expect(relay.sent("session.prompt")).toHaveLength(0);
    expect(relay.values["pult-open.recent"]).toEqual([{ m: "laptop", dir: "~/site" }]);
    expect(location.hash).toBe("#card?callsign=a%40laptop");
  });

  it("6914 · с задачей и R2: session.open, затем session.r2 и session.prompt с текстом; открыта карточка", async () => {
    // источник: чьё: код
    const relay = openRelay();
    const t = await openScreen(relay);
    await t.click(chipModel(t));
    await t.click(t.$("[data-r2]"));
    await named(t, "a");
    await t.type(t.$('[data-f="text"]'), "  почини сборку ");
    expect(t.$('[data-act="open"]')!.textContent).toBe("Начать");
    await start(t);
    await flush(5);
    const types = relay.got.map((f) => f.type).filter((x) => ["session.open", "session.r2", "session.prompt"].includes(x));
    expect(types).toEqual(["session.open", "session.r2", "session.prompt"]);
    expect(relay.sent("session.prompt")[0]).toMatchObject({ callsign: "a@laptop", text: "почини сборку" });
    expect(location.hash).toBe("#card?callsign=a%40laptop");
  });

  it("6919 · машина отказала в открытии: слово над кнопкой; карточки нет, место не запомнено, набранное на месте", async () => {
    // источник: устав — прямой запрос не прошёл, отказ словом
    const relay = openRelay();
    relay.handlers["session.open"] = () => ({ ok: false, error: "offline" });
    const t = await openScreen(relay);
    await named(t, "a");
    await t.type(t.$('[data-f="text"]'), "задача");
    await start(t);
    await flush(5);
    expect(t.$(".op-foot")!.previousElementSibling!.textContent).toBe("session.open: offline");
    expect(location.hash).toContain("#open");
    expect(relay.values["pult-open.recent"]).toBeUndefined();
    expect(t.$<HTMLTextAreaElement>('[data-f="text"]')!.value).toBe("задача");
    expect(t.$<HTMLButtonElement>('[data-act="open"]')!.disabled).toBe(false);
  });

  it("6920 · задача не ушла: тост со словом, карточка новой сессии открыта", async () => {
    // источник: факт — без неё сессия открыта и ждёт ввода; устав — отказ словом
    const relay = openRelay();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "offline" });
    const t = await openScreen(relay);
    await named(t, "a");
    await t.type(t.$('[data-f="text"]'), "задача");
    await start(t);
    await flush(5);
    expect(t.$(".sb-toast")!.textContent).toBe("a@laptop: задача не ушла — offline");
    expect(location.hash).toBe("#card?callsign=a%40laptop");
  });

  it("6921 · список папок отказал: слово на экране; session.open уходит — решает машина", async () => {
    // источник: устав — отказ словом; факт — запрос один, решает машина
    const relay = openRelay();
    relay.handlers["machine.dirs"] = () => ({ ok: false, error: "no_access" });
    const t = await openScreen(relay);
    expect(t.$(".op-bf")!.textContent).toContain("нет доступа к этой папке");
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")).toHaveLength(1);
    const relay2 = openRelay();
    relay2.handlers["machine.dirs"] = () => ({ ok: false, error: "offline" });
    const t2 = await openScreen(relay2);
    expect(t2.$(".op-bf")!.textContent).toContain("machine.dirs: offline");
  });

  it("6923 · запись места отказала: сессия открыта, тост словом", async () => {
    // источник: факт — отказ записи словом на экране
    const relay = openRelay();
    relay.handlers["prefs.set"] = () => ({ ok: false, error: "denied" });
    const t = await openScreen(relay);
    await named(t, "a");
    await start(t);
    await flush(10);
    expect(relay.sent("session.open")).toHaveLength(1);
    expect(location.hash).toBe("#card?callsign=a%40laptop");
    expect(t.$(".sb-toast")!.textContent).toBe("Настройка не сохранилась: denied");
  });
});
