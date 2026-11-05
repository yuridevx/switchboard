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
    await t.go("#sessions");
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

describe("профили", () => {
  const answer = (conflict: string[] | null) => ({ ok: true as const, result: { profiles: { "team/profiles/ops": { model: "opus" }, "team/profiles/writer": { model: "haiku" } }, repos: { "team/profiles": conflict ? { state: "conflict", files: conflict } : { state: "ok" } } } });
  const shown = (t: P) => t.$$("[data-profile]").map((x) => x.dataset.profile);

  it("6941 · фильтр «конфликты» вычисляется: конфликты ушли — снят; появились — вернулся", async () => {
    // источник: чьё: код
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    const t = await screen(relay, "/#profiles");
    await t.click(t.$('[data-act="conflicts"]'));
    expect(shown(t)).toEqual(["team/profiles/ops"]);
    relay.handlers["machine.profiles"] = () => answer(null);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$('[data-act="conflicts"]')).toBeNull();
    expect(shown(t)).toHaveLength(2);
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$('[data-act="conflicts"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(shown(t)).toEqual(["team/profiles/ops"]);
  });

  it("6952 · одна машина отказала: строка со словом; профили второй на месте", async () => {
    // источник: устав — отказ словом
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = (f) => (f.machine === "pc" ? { ok: false, error: "no_app" } : answer(null));
    const t = await screen(relay, "/#profiles");
    expect(t.$(".pf-e")!.textContent).toBe("@pc: machine.profiles: no_app");
    expect(shown(t)).toHaveLength(2);
  });

  it("6953 · чей конфликт: файлы под папкой профиля — только у него; ни под чьей — у всех профилей репозитория", async () => {
    // источник: факт — правило в profiles/store.ts
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(["ops/memory/a.md"]);
    const t = await screen(relay, "/#profiles");
    expect(t.$('[data-act="conflicts"]')!.textContent).toBe("конфликты 1");
    relay.handlers["machine.profiles"] = () => answer(["README.md"]);
    const t2 = await screen(relay, "/#profiles");
    expect(t2.$('[data-act="conflicts"]')!.textContent).toBe("конфликты 2");
  });

  it("6958 · синхронизация: на время «Свожу…»; без конфликта — «Сведено»", async () => {
    // источник: чьё: код
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => answer(null);
    const t = await screen(relay, "/#profiles");
    relay.handlers["machine.profiles"] = () => undefined;
    await t.click(t.$('[data-act="sync"]'));
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Свожу…");
    for (const f of relay.sent("machine.profiles").filter((x) => x.sync === true)) relay.reply(f.id!, answer(null));
    await flush(5);
    expect(t.$(".sb-toast")!.textContent).toBe("Сведено");
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Синхронизировать");
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

  it("6955 6870 · профили: запрос оборвался — слово; снова hello — спрошено заново, слово снято, ответ на экране", async () => {
    // источник: устав — соединение оборвалось, клиенты переподключаются
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => undefined;
    const t = await screen(relay, "/#profiles");
    const before = relay.sent("machine.profiles").length;
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" } }, repos: {} } });
    relay.drop();
    await flush(1);
    expect(t.text()).toContain("machine.profiles: disconnected");
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("machine.profiles").length).toBeGreaterThan(before);
    expect(t.text()).not.toContain("machine.profiles: disconnected");
    expect(t.$('[data-profile="team/profiles/ops"]')).not.toBeNull();
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

describe("профили", () => {
  it("5600 · профиль — одна строка по всем машинам: описание, модель, число машин и сессий; с конфликтом — сверху; repos в шапке", async () => {
    const t = await profilesScreen();
    expect(t.relay.sent("machine.profiles").map((f) => f.machine).sort()).toEqual(["laptop", "pc"]);
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/ops", "team/profiles/writer"]);
    const ops = t.$('[data-profile="team/profiles/ops"]')!;
    expect(ops.textContent).toContain("дежурство");
    expect(ops.textContent).toContain("opus · высокое");
    expect(ops.textContent).toContain("2/2 машин · 1 сессия");
    expect(ops.textContent).toContain("конфликт @pc");
    expect(t.$(".pf-repo")!.textContent).toBe("team/profiles");
  });

  it("5601 · строка раскрывается: машины, сессии, файлы конфликта; нажатие сессии — карточка", async () => {
    const t = await profilesScreen();
    await t.click(t.$('[data-profile="team/profiles/ops"] .pf-r'));
    const ops = t.$('[data-profile="team/profiles/ops"]')!;
    expect(ops.querySelector(".pf-cf")!.textContent).toContain("ops/memory/testing.md");
    await t.click(ops.querySelector('[data-callsign="site@laptop"]'));
    expect(location.hash).toBe("#card?callsign=site%40laptop");
  });

  it("5602 · поиск по имени и описанию; «конфликты N» отбирает; фокус поля остаётся", async () => {
    const t = await profilesScreen();
    const q = t.$<HTMLInputElement>('[data-f="q"]')!;
    q.focus();
    q.value = "writ";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/writer"]);
    expect(document.activeElement).toBe(t.$('[data-f="q"]'));
    q.value = "";
    t.$<HTMLInputElement>('[data-f="q"]')!.value = "";
    t.$('[data-f="q"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await t.click(t.$('[data-act="conflicts"]'));
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/ops"]);
  });

  it("5603 · «Синхронизировать» — machine.profiles { sync } по всем машинам, одна кнопка; итог — тост с конфликтом; отказ машины — словом", async () => {
    const x = profilesRelay();
    const t = await profilesScreen(x);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(x.sent("machine.profiles").filter((f) => f.sync === true).map((f) => f.machine).sort()).toEqual(["laptop", "pc"]);
    expect(t.$(".sb-toast")!.textContent).toBe("Сведено. Конфликт: ops @pc");
    x.handlers["machine.profiles"] = () => ({ ok: false, error: "no_app" });
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$(".pf-e")!.textContent).toBe("@laptop: machine.profiles: no_app");
  });

  it("E19 · синхронизация профилей: git отвечает 30 с — ответ приходит, timeout нет; обычное чтение профилей отказывает на 10 с", async () => {
    // источник: чьё: код — синхронизация это git pull и push; предел чтения её не касается
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const x = profilesRelay();
      const plain = x.handlers["machine.profiles"];
      const t = await profilesScreen(x);
      x.handlers["machine.profiles"] = (f) => (f.sync === true ? (undefined as never) : plain(f));
      await t.click(t.$('[data-act="sync"]'));
      await flush(5);
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(t.$(".pf-e")?.textContent ?? "").not.toContain("timeout");
      for (const f of x.sent("machine.profiles").filter((q) => q.sync === true)) x.reply(f.id as string, { ok: true, result: { profiles: {}, repos: {} } });
      await flush(10);
      expect(t.$(".sb-toast")!.textContent).toBe("Сведено");
      expect(t.$(".pf-e")?.textContent ?? "").not.toContain("timeout");
      // то же имя без синхронизации — чтение: экран открылся заново, машина молчит
      x.handlers["machine.profiles"] = () => undefined as never;
      const t2 = await profilesScreen(x);
      await vi.advanceTimersByTimeAsync(10_500);
      await flush();
      expect(t2.$(".pf-e")!.textContent).toContain("machine.profiles: timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("5604 · профилей нет на «Машинах» и в «Настройках»: synchronizing — только здесь", async () => {
    const t = await pult({ relay: profilesRelay(), url: "/#accounts" });
    await flush(10);
    expect(t.btn(null, "Синхронизировать профили")).toBeNull();
    expect(t.relay.sent("machine.profiles")).toHaveLength(0);
    await t.go("#profiles");
    await flush(10);
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Синхронизировать");
  });
});

describe("видимое: профили", () => {
  const twoRepos = () => {
    const x = profilesRelay();
    x.handlers["machine.profiles"] = (f) => ({
      ok: true,
      result: { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" } }, repos: { "team/profiles": f.machine === "pc" ? { state: "error", op: "git push", error: "rejected" } : { state: "ok" } } },
    });
    return x;
  };

  it("шапка, поиск, строка и раскрытие: машины, сессии, ошибка репозитория; раздел зовётся «Профили»", async () => {
    const t = await profilesScreen(twoRepos());
    expect(t.$(".pf-h b")!.textContent).toBe("Профили");
    expect(t.$(".pf-b .pf-t")).not.toBeNull();
    const q = t.$<HTMLInputElement>('.pf-t [data-f="q"]')!;
    expect(q.placeholder).toBe("Найти профиль · 1");
    expect(q.getAttribute("aria-label")).toBe("Найти профиль");
    expect(t.$(".pf-l .pf-w.cf .pf-n b")!.textContent).toBe("ops");
    expect(t.$(".pf-n span")!.textContent).toBe("дежурство");
    expect(t.$(".pf-m .c")!.textContent).toBe("2/2 машин · 1 сессия");
    expect(t.$(".pf-m .pf-p.bad")!.textContent).toBe("конфликт @pc");
    await t.click(t.$(".pf-r"));
    expect(t.$(".pf-d .pf-ms")!.textContent).toBe("@laptop@pc конфликт");
    expect(t.$(".pf-ms .pf-p.ok")!.textContent).toBe("@laptop");
    const s = t.$('.pf-ss [data-callsign="site@laptop"]')!;
    expect(s.querySelector(".nm")!.textContent).toBe("site");
    expect(s.querySelector(".k")!.textContent).toBe("@laptop · switchboard");
    const cf = t.$(".pf-cf")!;
    expect(cf.querySelector("b")!.textContent).toBe("@pc: ошибка");
    expect(cf.textContent).toContain("rejected");
    expect(t.$('.sb-navcol button[data-screen="profiles"]')!.textContent).toBe("Профили");
  });

  it("профилей нет — строка; поиск без совпадений — та же строка", async () => {
    const x = fleetRelay();
    x.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const t = await profilesScreen(x);
    expect(t.$(".pf-none")!.textContent).toBe("профилей нет");
    const t2 = await profilesScreen();
    await t2.type(t2.$('[data-f="q"]'), "нет такого");
    expect(t2.$(".pf-none")!.textContent).toBe("профилей нет");
  });
});

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
