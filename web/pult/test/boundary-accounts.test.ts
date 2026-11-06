// Леса границы «вход и профиль сессии», сторона страницы: экраны аккаунтов и профилей на поддельном relay, код страницы настоящий.
// Вход — экран и кадры контракта, исход — кадры relay, текст и якоря разметки. Номер — старый эталон; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { memoryStore } from "@switchboard/web-core";
import { phoneParts } from "../../phone/stand/parts.ts";
import { stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";
import { fleetRelay, fleetRoster, flush, HOST, KEY, pult, SLOTS } from "./stand.ts";

const T = (hh: number, mm: number) => Math.floor(Date.UTC(2026, 9, 31, hh, mm) / 1000);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
type Ans = { ok: true; result?: unknown } | { ok: false; error: string };

/** Аккаунты и слоты машин: accounts[m], slots[m] — ответы владельцев. */
function fleetAccounts(accounts: Record<string, unknown>, slots: Record<string, unknown> = {}, r = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers["machine.accounts"] = (f) => (accounts[String(f.machine)] as Ans | undefined) ?? { ok: true, result: { accounts: {} } };
  relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: slots[String(f.machine)] ?? {} } });
  return relay;
}

async function accountsScreen(relay = fleetAccounts({}), url?: string) {
  const t = await pult({ relay, url });
  if (!url) await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
  await flush(10);
  return t;
}

const ok = (accounts: Record<string, unknown>) => ({ ok: true as const, result: { accounts } });

const screen = async (relay: ReturnType<typeof fleetRelay>, url: string) => {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
};
const withoutPc = () => {
  const r = fleetRoster();
  r.machines = r.machines.filter((m) => m.machine !== "pc");
  return r;
};
/** Машина pc вошла гостем: клиент флота открыл соединение с её relay. */
const withPc = () => {
  const r = fleetRoster();
  r.clients = [...r.clients, "@pc"];
  return r;
};
const bumped = (m: string, r = fleetRoster()): Roster => ({ ...r, machines: r.machines.map((x) => (x.machine === m ? { ...x, since: x.since + 60_000 } : x)) });

describe("аккаунты", () => {



  it("4134 · подмена при закрытом экране — machine.slots и machine.accounts не шлются", async () => {
    const relay = fleetAccounts({});
    const t = await accountsScreen(relay, "/#accounts");
    const open = relay.sent("machine.accounts").length;
    expect(open).toBeGreaterThan(0);
    await t.go("#inbox");
    const r = fleetRoster();
    r.sessions[0].account = "yurianrun";
    relay.setRoster(r);
    await flush();
    expect(relay.sent("machine.accounts")).toHaveLength(open);
  });

  it("4135 · сессия впервые в roster или без account — перечитываний нет", async () => {
    const relay = fleetAccounts({});
    await accountsScreen(relay);
    expect(relay.sent("machine.accounts").length).toBeGreaterThan(0);
    const n = relay.got.length;
    const r = fleetRoster();
    r.sessions.push({ callsign: "c@pc", state: "idle", account: "work" });
    relay.setRoster(r);
    await flush();
    const r2 = fleetRoster();
    r2.sessions.push({ callsign: "c@pc", state: "idle" });
    relay.setRoster(r2);
    await flush();
    expect(relay.got.slice(n).filter((f) => f.type === "machine.slots" || f.type === "machine.accounts")).toEqual([]);
  });
});


describe("аккаунты", () => {


  it("6950 · машина без запроса: ей запросов нет и слов отказа о ней нет; другой — есть", async () => {
    // источник: чьё: код
    const r = fleetRoster();
    for (const n of ["machine.accounts", "machine.profiles"]) delete r.machines[1].contract![n];
    const relay = fleetRelay(r);
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const t = await screen(relay, "/#accounts");
    await t.go("#profiles");
    for (const n of ["machine.accounts", "machine.profiles"]) {
      expect(relay.sent(n).map((f) => f.machine)).toEqual(["laptop"]);
    }
    expect(t.text()).not.toContain("pc:");
    expect(t.text()).not.toContain("pc ·");
  });

});

describe("связь вернулась", () => {
  it("6954 · аккаунты: запрос оборвался — слово disconnected; снова hello — спрошено заново, слово снято", async () => {
    // источник: устав — соединение оборвалось, клиенты переподключаются
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = () => undefined;
    const t = await screen(relay, "/#accounts");
    const before = relay.sent("machine.accounts").length;
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
    relay.drop();
    await flush(1);
    expect(t.text()).toContain("machine.accounts: disconnected");
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("machine.accounts").length).toBeGreaterThan(before);
    expect(t.text()).not.toContain("machine.accounts: disconnected");
  });

});

function profilesRelay() {
  const r = fleetRoster();
  r.sessions.find((s) => s.callsign === "site@laptop")!.profile = { id: "team/profiles/ops", state: "ok" };
  const x = fleetRelay(r);
  x.handlers["machine.profiles"] = (f) => ({
    ok: true,
    result:
      f.machine === "laptop"
        ? { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" }, "team/profiles/writer": { model: "haiku", effort: "low" } }, repos: { "team/profiles": { state: "ok" } } }
        : { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" } }, repos: { "team/profiles": { state: "conflict", files: ["ops/memory/testing.md"] } } },
  });
  return x;
}

async function profilesScreen(x = profilesRelay()) {
  const t = await pult({ relay: x, url: "/#profiles" });
  await flush(10);
  return t;
}

describe("страница «Аккаунты»: эталоны дизайна", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const win = (utilization: number, resetsIn: number, age = 30) => ({ utilization, resetsAt: now() + resetsIn, at: now() - age });
  const entry = (m: string, e: string) => `[data-entry="${m}:${e}"]`;
  const row = (t: P, m: string) => t.$(`[data-machine="${m}"]`)!;
  /** Запросы опроса: кто и о ком. */
  const polls = (relay: ReturnType<typeof fleetRelay>) => relay.sent("machine.accounts").filter((x) => Array.isArray(x.poll)).map((x) => [x.machine, x.poll]);
  const FRESH = { seven_day: win(0.5, 86400) };
  const MAIN = (account: string, order = [account]) => ({ main: { account, order, wait: null } });

  it("11 · один опрос на почту: устаревшие спрошены по разу, свежая и без входа — нет", async () => {
    // источник: факт — 14 процессов при 5 аккаунтах на открытие страницы
    const STALE = { seven_day: win(0.5, 86400, 600) };
    const relay = fleetAccounts({
      laptop: ok({ "a@x": { login: "ok", limits: STALE }, "b@x": { login: "ok", limits: STALE }, "c@x": { login: "ok", limits: FRESH }, "off@x": { login: "none", limits: STALE } }),
      pc: ok({ "a@x": { login: "ok", limits: STALE }, "b@x": { login: "ok", limits: STALE }, "c@x": { login: "ok", limits: FRESH }, "off@x": { login: "ok", limits: STALE } }),
    });
    await accountsScreen(relay, "/#accounts");
    await flush(10);
    const asked = polls(relay).flatMap(([, list]) => list as string[]).sort();
    expect(asked).toEqual(["a@x", "b@x", "off@x"]);
    expect(polls(relay).find(([, list]) => (list as string[]).includes("off@x"))![0]).toBe("pc");
  });

  it("11 · в статусе самое свежее значение окна среди машин; окно 0 % без сброса не показано; только процент и час сброса", async () => {
    // источник: факт — страница показывала 3 % при настоящих 78 %
    const reset = now() + 86400;
    const relay = fleetAccounts({
      laptop: ok({ "a@x": { login: "ok", plan: "max", limits: { seven_day: { utilization: 0.1, resetsAt: reset, at: now() - 60 }, iguana_necktie: { utilization: 0, resetsAt: now() - 60, at: now() - 60 } } } }),
      pc: ok({ "a@x": { login: "ok", plan: "max", limits: { seven_day: { utilization: 0.4, resetsAt: reset, at: now() - 5 } } } }),
    });
    const t = await accountsScreen(relay, "/#accounts");
    const line = t.$('[data-account="a@x"]')!;
    expect(line.querySelector('[data-window="seven_day"] b')!.textContent).toBe("40 %");
    expect(line.querySelector('[data-window="iguana_necktie"]')).toBeNull();
    expect(line.textContent).not.toContain("max");
    expect(line.textContent).not.toContain("сесси");
    expect(line.querySelector(".ac-name")!.textContent).toBe("a");
    expect(line.querySelector(".ac-name")!.getAttribute("title")).toBe("a@x");
  });

  it("11 · значение старше часа подписано, свежее — нет", async () => {
    // источник: дизайн, правила страницы; чьё: код
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", limits: { seven_day: win(0.5, 86400, 7300) } }, "b@x": { login: "ok", limits: { seven_day: win(0.5, 86400, 60) } } }), pc: ok({}) });
    const t = await accountsScreen(relay, "/#accounts");
    expect(t.$('[data-account="a@x"] [data-age]')!.textContent).toContain("назад");
    expect(t.$('[data-account="b@x"] [data-age]')).toBeNull();
  });

  it("11 · сменился аккаунт сессии: опрошен только новый на её машине", async () => {
    // источник: находка слепого архитектора
    const r = fleetRoster();
    Object.assign(r.sessions.find((s) => s.callsign === "site@laptop")!, { account: "a@x" });
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", limits: FRESH }, "b@x": { login: "ok", limits: FRESH } }), pc: ok({}) }, { laptop: MAIN("a@x", ["a@x", "b@x"]) }, r);
    await accountsScreen(relay, "/#accounts");
    expect(polls(relay)).toEqual([]);
    const next = fleetRoster();
    Object.assign(next.sessions.find((s) => s.callsign === "site@laptop")!, { account: "b@x" });
    relay.setRoster(next);
    await flush(10);
    expect(polls(relay)).toEqual([["laptop", ["b@x"]]]);
  });

  it("15 · данные расходятся: час сброса одной почты отличается на день — значок и что говорит каждая машина", async () => {
    // источник: слово пользователя 5 нояб.; факт — hz-ex44-win-1
    const relay = fleetAccounts({
      laptop: ok({ "a@x": { login: "ok", limits: { seven_day: win(0.03, 6 * 86400) } } }),
      pc: ok({ "a@x": { login: "ok", limits: { seven_day: win(0.78, 5 * 86400) } } }),
    });
    const t = await accountsScreen(relay, "/#accounts");
    const warn = t.$('[data-account="a@x"] .ac-warn')!;
    expect(warn.getAttribute("aria-label")).toBe("Данные a на машинах расходятся");
    expect(t.$('[data-diff="a@x"]')).toBeNull();
    await t.click(warn);
    const diff = t.$('[data-diff="a@x"]')!;
    expect(diff.textContent).toContain("laptop");
    expect(diff.textContent).toContain("3 %");
    expect(diff.textContent).toContain("pc");
    expect(diff.textContent).toContain("78 %");
  });

  it.each([
    ["разница в секунду", win(0.5, 3600), { utilization: 0.5, resetsAt: now() + 3601, at: now() - 30 }],
    ["разные проценты при одном часе", win(0.2, 3600), { utilization: 0.7, resetsAt: now() + 3600, at: now() - 30 }],
    ["сброс на одной машине уже прошёл", win(0.2, 3600), { utilization: 0.9, resetsAt: now() - 3600, at: now() - 9000 }],
  ])("15 · значка нет: %s", async (_n, a, b) => {
    // источник: факт — один аккаунт на двух машинах: 17:59:59 и 18:00:00; машины спрашивают Claude в разное время
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", limits: { seven_day: a } } }), pc: ok({ "a@x": { login: "ok", limits: { seven_day: b } } }) });
    const t = await accountsScreen(relay, "/#accounts");
    expect(t.$('[data-account="a@x"] .ac-warn')).toBeNull();
  });

  it("15 · разный тариф одной почты — значок", async () => {
    // источник: слово пользователя 5 нояб.: не совпала информация на нескольких компьютерах
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", plan: "max", limits: FRESH } }), pc: ok({ "a@x": { login: "ok", plan: "pro", limits: FRESH } }) });
    const t = await accountsScreen(relay, "/#accounts");
    expect(t.$('[data-account="a@x"] .ac-warn')).not.toBeNull();
  });

  it("14 · вход в строке машины: ссылка и код под её строкой, остальные строки без них; итог там же; поле не запоминает браузер", async () => {
    // источник: слово пользователя 5 нояб.: войти на машине инлайн, а не сверху
    const relay = fleetAccounts({ laptop: ok({}), pc: ok({}) });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
    relay.handlers["machine.login_code"] = () => ({ ok: true, result: { email: "new@x", plan: "max" } });
    const t = await accountsScreen(relay, "/#accounts");
    await t.click(row(t, "pc").querySelector("[data-login-start]"));
    await flush(5);
    expect(relay.sent("machine.login").at(-1)).toMatchObject({ machine: "pc" });
    expect(relay.sent("machine.login").at(-1)!.account).toBeUndefined();
    const panel = row(t, "pc").querySelector('[data-login="pc"]')!;
    expect(panel.querySelector("a")!.getAttribute("href")).toBe("https://claude.ai/oauth/x");
    expect(row(t, "laptop").querySelector("[data-login]")).toBeNull();
    const code = panel.querySelector<HTMLInputElement>('[data-f="code"]')!;
    expect(code.getAttribute("autocomplete")).toBe("off");
    await t.click(t.btn(panel as HTMLElement, "Отправить"));
    expect(relay.sent("machine.login_code")).toHaveLength(0);
    await t.type(code, "Xk2pL#Qm");
    await t.click(t.btn(row(t, "pc").querySelector('[data-login="pc"]') as HTMLElement, "Отправить"));
    await flush(5);
    expect(relay.sent("machine.login_code")[0]).toMatchObject({ machine: "pc", code: "Xk2pL#Qm" });
    expect(row(t, "pc").querySelector("[data-login]")).toBeNull();
    expect(row(t, "pc").textContent).toContain("Вошёл: new@x");
    expect(t.text()).not.toContain("Xk2pL");
  });

  it("14 · «Войти заново» другой почтой: аккаунт, откуда начали, не изменился — так и сказано; отказ кода — словом в строке", async () => {
    // источник: факт — hz-ex44-win-1
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "none" } }), pc: ok({}) }, { laptop: MAIN("a@x") });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
    relay.handlers["machine.login_code"] = () => ({ ok: true, result: { email: "b@x" } });
    const t = await accountsScreen(relay, "/#accounts");
    await t.click(t.$(entry("laptop", "a@x")));
    await t.click(t.btn(row(t, "laptop"), "Войти заново"));
    await flush(5);
    await t.type(row(t, "laptop").querySelector('[data-f="code"]'), "c");
    await t.click(t.btn(row(t, "laptop"), "Отправить"));
    await flush(5);
    expect(row(t, "laptop").textContent).toContain("Вошёл: b@x — это другой аккаунт, a не изменился");
    relay.handlers["machine.login_code"] = () => ({ ok: false, error: "bad_code" });
    await t.click(row(t, "laptop").querySelector("[data-login-start]"));
    await flush(5);
    await t.type(row(t, "laptop").querySelector('[data-f="code"]'), "c");
    await t.click(t.btn(row(t, "laptop"), "Отправить"));
    await flush(5);
    expect(row(t, "laptop").textContent).toContain("Код не принят — вход закрыт");
  });

  it("очередь: состояния записи; нажатие — действия под строкой: поставить, выше, ниже, убрать, в очередь, удалить; отказ — словом в строке", async () => {
    // источник: чьё: код; слово пользователя 5 нояб.: работаем в строках
    const accounts = { "a@x": { login: "ok", limits: FRESH }, "b@x": { login: "ok", limits: FRESH }, "c@x": { login: "ok", limits: FRESH }, "free@x": { login: "ok", limits: FRESH }, "off@x": { login: "none" } };
    const relay = fleetAccounts({ laptop: ok(accounts), pc: ok({}) }, { laptop: MAIN("a@x", ["a@x", "b@x", "c@x", "off@x"]) });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "a@x" } });
    relay.handlers["slot.swap"] = () => ({ ok: true, result: { from: "a@x", to: "b@x" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await accountsScreen(relay, "/#accounts");
    expect(t.$(entry("laptop", "a@x"))!.classList.contains("cur")).toBe(true);
    expect(t.$(entry("laptop", "b@x"))!.classList.contains("res")).toBe(true);
    expect(t.$(entry("laptop", "free@x"))!.classList.contains("free")).toBe(true);
    expect(t.$(entry("laptop", "off@x"))!.textContent).toContain("нет входа");
    expect(row(t, "laptop").querySelector(".ac-slotname")).toBeNull();

    const press = async (e: string, what: string) => {
      await t.click(t.$(entry("laptop", e)));
      await t.click(t.btn(row(t, "laptop"), what));
      await flush(5);
    };
    await press("a@x", "Сменить на следующего");
    expect(relay.sent("slot.swap").at(-1)).toMatchObject({ machine: "laptop", slot: "main" });
    expect(relay.sent("slot.swap").at(-1)!.account).toBeUndefined();
    expect(row(t, "laptop").textContent).toContain("a → b");
    await press("b@x", "Поставить сейчас");
    expect(relay.sent("slot.swap").at(-1)).toMatchObject({ account: "b@x" });
    await press("b@x", "Ниже");
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "main", order: ["a@x", "c@x", "b@x", "off@x"] });
    await press("c@x", "Выше");
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a@x", "c@x", "b@x", "off@x"] });
    await press("c@x", "Убрать из очереди");
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a@x", "b@x", "off@x"] });
    await press("free@x", "В очередь");
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a@x", "b@x", "c@x", "off@x", "free@x"] });
    await press("free@x", "Поставить сейчас");
    expect(relay.sent("slot.swap").at(-1)).toMatchObject({ account: "free@x" });
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a@x", "b@x", "c@x", "off@x", "free@x"] });
    await press("c@x", "Удалить с машины");
    expect(relay.sent("machine.account_remove").at(-1)).toEqual(expect.objectContaining({ machine: "laptop", account: "c@x" }));
    expect(relay.sent("machine.account_remove").at(-1)!.next).toBeUndefined();

    relay.handlers["machine.account_remove"] = () => ({ ok: false, error: "no_reserve", why: "main: поставьте другой аккаунт" });
    await press("a@x", "Удалить с машины");
    expect(row(t, "laptop").textContent).toContain("В запасе нет вошедшего ниже порога — main: поставьте другой аккаунт");
  });

  it("записи: срок входа за 7 дней виден, позже — нет; слот ждёт сброса; имя слота — при двух слотах; подсветка аккаунта на всех машинах", async () => {
    // источник: чьё: код; дизайн — срок входа у каждой машины свой
    const soon = now() + 3 * 86400;
    const accounts = { "a@x": { login: "ok", expires: soon, limits: FRESH }, "b@x": { login: "ok", expires: now() + 30 * 86400, limits: FRESH } };
    const relay = fleetAccounts(
      { laptop: ok(accounts), pc: ok({ "a@x": { login: "ok", limits: FRESH } }) },
      { laptop: { main: { account: "a@x", order: ["a@x"], wait: now() + 3600 }, night: { account: "b@x", order: ["b@x"], wait: null } }, pc: MAIN("a@x") },
    );
    const t = await accountsScreen(relay, "/#accounts");
    expect(t.$(entry("laptop", "a@x"))!.textContent).toContain("вход до");
    expect(t.$('[data-slot="laptop:night"] [data-entry="laptop:b@x"]')!.textContent).not.toContain("вход до");
    expect(row(t, "laptop").querySelectorAll(".ac-slotname")).toHaveLength(2);
    expect(row(t, "pc").querySelector(".ac-slotname")).toBeNull();
    expect(row(t, "laptop").textContent).toContain("ждёт сброса");
    await t.click(t.$('[data-account="a@x"] .ac-name'));
    expect(t.$$(".ac-entry.marked").map((x) => x.getAttribute("data-entry"))).toEqual(expect.arrayContaining(["laptop:a@x", "pc:a@x"]));
  });

  it("машина: нажатие открывает части, новый слот и удаление пустого; слот с сессиями не удаляется", async () => {
    // источник: чьё: код
    const r = fleetRoster();
    Object.assign(r.sessions.find((s) => s.callsign === "site@laptop")!, { slot: { name: "main", wait: null } });
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", limits: FRESH } }), pc: ok({}) }, { laptop: { main: { account: "a@x", order: ["a@x"], wait: null }, empty: { account: "a@x", order: ["a@x"], wait: null } } }, r);
    relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.2.0", rev: 3, os: "linux", parts: [] } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "a@x" } });
    const t = await accountsScreen(relay, "/#accounts");
    await t.click(row(t, "laptop").querySelector(".ac-mname"));
    await flush(5);
    expect(row(t, "laptop").querySelector('[data-machine-parts="laptop"] [data-keeper]')!.textContent).toBe("1.2.0 · план rev 3");
    expect(row(t, "laptop").querySelector('[data-delete-slot="main"]')).toBeNull();
    await t.click(row(t, "laptop").querySelector('[data-delete-slot="empty"]'));
    await flush(5);
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "empty", order: [] });
    await t.type(row(t, "laptop").querySelector('[data-f="newslot"]'), "night");
    await t.click(t.btn(row(t, "laptop"), "＋ слот"));
    await flush(5);
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "night", order: ["a@x"] });
  });

  it("отказ machine.accounts одной машины — слово в её строке, другие на месте; машин отдельным разделом нет", async () => {
    // источник: устав — ошибки словами
    const relay = fleetAccounts({ laptop: ok({ "a@x": { login: "ok", limits: FRESH } }), pc: { ok: false, error: "offline" } }, { laptop: MAIN("a@x") });
    const t = await accountsScreen(relay, "/#accounts");
    expect(row(t, "pc").textContent).toContain("machine.accounts: offline");
    expect(t.$(entry("laptop", "a@x"))).not.toBeNull();
    expect(t.$('.sb-navcol button[data-screen="machines"]')).toBeNull();
    expect(t.text()).not.toContain("сесси");
  });
});
