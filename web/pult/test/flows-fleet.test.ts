// Флоу пульта по плану цикла тестов (web): аккаунты и вход, слоты, удаление аккаунта, машины, приложение GitHub, журнал флота.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { FakeRelay } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, flush, HOST, pult } from "./stand.ts";

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
  relay.handlers["machine.slots"] = (f) => ({ ok: true, result: { slots: slots[String(f.machine)] ?? {} } });
  return relay;
}

async function accountsScreen(relay = fleetAccounts({}), url?: string) {
  const t = await pult({ relay, url });
  if (!url) await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
  await flush(10);
  return t;
}

const ok = (accounts: Record<string, unknown>) => ({ ok: true as const, result: { accounts } });

describe("аккаунты", () => {
  it("4131 · до первого ответа — «Загружаю аккаунты машин…», без аккаунтов — «Аккаунтов нет»", async () => {
    const relay = fleetAccounts({});
    relay.handlers["machine.accounts"] = () => undefined;
    const t = await accountsScreen(relay);
    expect(t.text()).toContain("Загружаю аккаунты машин…");
    for (const f of relay.sent("machine.accounts")) relay.reply(f.id!, { ok: true, result: { accounts: {} } });
    await flush(10);
    expect(t.text()).toContain("Аккаунтов нет — «+ Новый аккаунт».");
  });

  it("4132 · счётчик раздела «Аккаунты» — входы в процессе", async () => {
    const t = await accountsScreen(fleetAccounts({ pc: ok({ corp: { login: "pending" }, main: { login: "ok", email: "a@x.io" } }) }));
    expect(t.$('.sb-navcol button[data-screen="accounts"]')!.textContent).toBe("Аккаунты1");
  });

  it("4133 · отказ machine.accounts машины — слово с её именем, другие машины на месте", async () => {
    const t = await accountsScreen(fleetAccounts({ pc: { ok: false, error: "offline" }, laptop: ok({ work: { login: "ok", email: "a@x.io" } }) }));
    expect(t.$('[data-account="a@x.io"] [data-machine="laptop"]')).not.toBeNull();
    expect(t.text()).toContain("pc · machine.accounts: offline");
    expect(t.text()).not.toContain("Аккаунтов нет");
  });

  it("4134 · подмена при закрытом экране — machine.slots и machine.accounts не шлются", async () => {
    const relay = fleetAccounts({});
    const t = await pult({ relay });
    const r = fleetRoster();
    r.sessions[0].account = "yurianrun";
    relay.setRoster(r);
    await flush();
    expect(relay.sent("machine.slots")).toHaveLength(0);
    expect(relay.sent("machine.accounts")).toHaveLength(0);
    void t;
  });

  it("4135 · сессия впервые в roster или без account — перечитываний нет", async () => {
    const relay = fleetAccounts({});
    await accountsScreen(relay);
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

describe("вход аккаунта", () => {
  /** Форма «Новый аккаунт» на laptop с именем name. */
  async function newAccount(t: P, name: string) {
    await t.click(t.btn(null, "+ Новый аккаунт"));
    await t.click(t.btn(t.$(".sb-sec.dlg"), "laptop"));
    await t.type(t.$('[data-f="account"]'), name);
    await t.click(t.btn(t.$(".sb-sec.dlg"), "Войти"));
  }

  it("4136 · имя аккаунта не по форме — строка, machine.login нет", async () => {
    const relay = fleetAccounts({});
    const t = await accountsScreen(relay);
    await newAccount(t, "my corp");
    expect(t.$(".sb-sec.dlg")!.textContent).toContain("имя — латиница, цифры, - и _");
    expect(relay.sent("machine.login")).toHaveLength(0);
  });

  it("4137 · отказ machine.login — карточка со словом и «Войти заново»", async () => {
    const relay = fleetAccounts({});
    relay.handlers["machine.login"] = () => ({ ok: false, error: "slot_dir_busy" });
    const t = await accountsScreen(relay);
    await newAccount(t, "corp");
    const card = t.$('[data-login="laptop:corp"]')!;
    expect(card.textContent).toContain("На месте слота на машине папка с файлами — разберите её");
    expect(card.textContent).toContain("слово: slot_dir_busy");
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
    await t.click(t.btn(card, "Войти заново"));
    expect(relay.sent("machine.login")).toHaveLength(2);
  });

  it("4138 · пустой код — machine.login_code нет", async () => {
    const relay = fleetAccounts({});
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
    const t = await accountsScreen(relay);
    await newAccount(t, "corp");
    await t.type(t.$('[data-f="code"]'), "  ");
    await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Отправить"));
    expect(relay.sent("machine.login_code")).toHaveLength(0);
    expect(t.$<HTMLInputElement>('[data-f="code"]')!.disabled).toBe(false);
  });

  it("4139 · «Войти» у аккаунта без входа — machine.login, карточка «Вход: old на pc»", async () => {
    const relay = fleetAccounts({ pc: ok({ old: { login: "none" }, corp: { login: "ok", email: "c@x.io" } }) });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
    const t = await accountsScreen(relay);
    const oldRow = t.$('[data-account="name:old"] [data-machine="pc"]')!;
    expect(oldRow.textContent).toContain("нет входа");
    expect(t.btn(t.$('[data-account="c@x.io"]'), "Войти")).toBeNull();
    await t.click(t.btn(oldRow, "Войти"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ machine: "pc", account: "old" })]);
    expect(t.$('[data-login="pc:old"]')!.textContent).toContain("Вход: old на pc");
  });

  it("4140 · Host перезапустился во время входа — слово, код не повторяется, «Войти заново» — новый вход", async () => {
    for (const [answer, text] of [
      [undefined, "слово: disconnected"],
      [{ ok: false, error: "not_started" }, "Вход прервался: Host перезапускался"],
    ] as const) {
      const relay = fleetAccounts({});
      relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/x" } });
      relay.handlers["machine.login_code"] = () => answer;
      const t = await accountsScreen(relay);
      await newAccount(t, "corp");
      await t.type(t.$('[data-f="code"]'), "CODE");
      await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Отправить"));
      if (!answer) {
        relay.drop();
        await flush(10);
      }
      expect(t.$('[data-login="laptop:corp"]')!.textContent).toContain(text);
      expect(relay.sent("machine.login_code")).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 30));
      await flush(10);
      await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Войти заново"));
      expect(relay.sent("machine.login")).toHaveLength(2);
      expect(relay.sent("machine.login_code")).toHaveLength(1);
    }
  });
});

describe("слоты", () => {
  const SLOTS = {
    laptop: {
      main: { account: "a", order: ["a", "b"], wait: null, sessions: ["site@laptop", "profiles@laptop"] },
      bot: { account: "x", order: ["x"], wait: null, sessions: [] },
    },
  };
  const ACC = { laptop: ok({ a: { login: "ok" }, b: { login: "ok" }, c: { login: "ok" }, x: { login: "ok" } }) };

  async function slotsView(relay = fleetAccounts(ACC, SLOTS)) {
    const t = await accountsScreen(relay, "/#accounts?view=slots&machine=laptop");
    return t;
  }

  it("4141 · порядок запаса, запас, «убрать», пустой слот, новый слот — slot.set и machine.slots заново", async () => {
    const relay = fleetAccounts(ACC, SLOTS);
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "a" } });
    const t = await slotsView(relay);
    const main = () => t.$('[data-slot="laptop:main"]')!;
    await t.click(main().querySelector('[aria-label="b выше"]'));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ machine: "laptop", slot: "main", order: ["b", "a"] });
    const add = main().querySelector<HTMLSelectElement>('[data-f="add:main"]')!;
    add.value = "c";
    add.dispatchEvent(new Event("change"));
    await flush();
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a", "b", "c"] });
    await t.click(main().querySelector('[aria-label="убрать b"]'));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a"] });
    await t.click(t.btn(t.$('[data-slot="laptop:bot"]'), "Удалить слот"));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "bot", order: [] });
    expect(t.text()).toContain("слот bot удалён");
    await t.type(t.$('[data-f="newslot"]'), "night");
    await t.click(t.btn(null, "Создать"));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "night", order: ["a"] });
    expect(relay.sent("machine.slots").length).toBeGreaterThanOrEqual(6);
  });

  it("4142 · перевод выбранных сессий — session.slot по одной, строка итогов, machine.slots заново", async () => {
    const relay = fleetAccounts(ACC, SLOTS);
    relay.handlers["session.slot"] = (f) => ({ ok: true, result: { restart: f.callsign === "site@laptop" } });
    const t = await accountsScreen(relay);
    await t.click(t.$('[data-account="name:a"] [data-sess="main"]'));
    const dlg = t.$('[data-dlg="sess"]')!;
    for (const c of dlg.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) c.checked = true;
    const target = dlg.querySelector<HTMLSelectElement>('[data-f="target"]')!;
    target.value = "bot";
    const slots = relay.sent("machine.slots").length;
    await t.click(t.btn(dlg, "Перевести"));
    expect(relay.sent("session.slot").map((f) => [f.callsign, f.slot])).toEqual([
      ["site@laptop", "bot"],
      ["profiles@laptop", "bot"],
    ]);
    expect(t.$('[data-dlg="sess"]')!.textContent).toContain("site@laptop: перейдёт между ходами · profiles@laptop: перешла");
    expect(relay.sent("machine.slots").length).toBe(slots + 1);
  });

  it("4143 · отказы slots словами: has_sessions; перевод — у отказавшей сессии слово, вторая переведена", async () => {
    const relay = fleetAccounts(ACC, { laptop: { main: { ...SLOTS.laptop.main }, bot: { account: "x", order: ["x"], wait: null, sessions: [] } } });
    relay.handlers["slot.set"] = () => ({ ok: false, error: "has_sessions" });
    relay.handlers["session.slot"] = (f) => (f.callsign === "site@laptop" ? { ok: false, error: "no_slot" } : { ok: true, result: { restart: false } });
    const t = await slotsView(relay);
    await t.click(t.btn(t.$('[data-slot="laptop:bot"]'), "Удалить слот"));
    expect(t.$('[data-slot="laptop:bot"]')!.textContent).toContain("В слоте есть сессии — сначала переведите их");
    await t.click(t.$('[data-account="name:a"] [data-sess="main"]'));
    const dlg = t.$('[data-dlg="sess"]')!;
    for (const c of dlg.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) c.checked = true;
    await t.click(t.btn(dlg, "Перевести"));
    expect(relay.sent("session.slot")).toHaveLength(2);
    expect(t.$('[data-dlg="sess"]')!.textContent).toContain("site@laptop: Такого слота нет · profiles@laptop: перешла");
  });

  it("4144 · вид «Слоты» из адреса; слот ждёт сброса — время и пояснение; «Удалить слот» нет", async () => {
    const wait = Math.floor(Date.UTC(2026, 10, 2, 5, 0) / 1000);
    const relay = fleetAccounts(ACC, { pc: { main: { account: "a", order: ["a", "b"], wait, sessions: ["api@pc"] } } });
    const t = await accountsScreen(relay, "/#accounts?view=slots&machine=pc");
    expect(t.$('[data-col="slots"] h2')!.textContent).toBe("Слоты");
    const main = t.$('[data-slot="pc:main"]')!;
    expect(main.textContent).toMatch(/Слот main ждёт сброса · \d\d:\d\d/);
    expect(t.btn(main, "Удалить слот")).toBeNull();
  });

  it("4145 · нет машин со слотами — «Нет машин со слотами на связи.», machine.slots нет", async () => {
    const r = fleetRoster();
    for (const m of r.machines) {
      m.contract = { ...HOST };
      delete m.contract["machine.slots"];
    }
    const relay = fleetAccounts({}, {}, r);
    const t = await accountsScreen(relay, "/#accounts?view=slots");
    expect(t.text()).toContain("Нет машин со слотами на связи.");
    expect(relay.sent("machine.slots")).toHaveLength(0);
  });
});

describe("удаление аккаунта", () => {
  const SL = { laptop: { main: { account: "a", order: ["a", "b", "c"], wait: null, sessions: ["site@laptop"] } } };
  const AC = { laptop: ok({ a: { login: "ok", email: "a@x.io" }, b: { login: "ok" }, c: { login: "ok" }, old: { login: "ok", email: "o@x.io" } }) };
  const rm = async (t: P, acc: string, email: string) => {
    await t.click(t.btn(t.$(`[data-account="${email}"] [data-machine="laptop"]`), "Удалить…"));
  };

  it("4146 · аккаунт не в слотах — сразу machine.account_remove, «удалён с laptop»", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await accountsScreen(relay);
    await rm(t, "old", "o@x.io");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Удалить"));
    expect(relay.got.filter((f) => ["slot.swap", "slot.set", "machine.account_remove"].includes(f.type)).map((f) => f.type)).toEqual(["machine.account_remove"]);
    expect(relay.sent("machine.account_remove")[0]).toMatchObject({ machine: "laptop", account: "old" });
    expect(t.text()).toContain("old удалён с laptop");
  });

  it("4147 · шаг отказал — дальше не идёт: slot.swap no_reserve, slot.set и удаления нет", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["slot.swap"] = () => ({ ok: false, error: "no_reserve" });
    const t = await accountsScreen(relay);
    await rm(t, "a", "a@x.io");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    expect(t.text()).toContain("слот main: В запасе нет вошедшего ниже порога — слот прежний");
    expect(relay.sent("slot.set")).toHaveLength(0);
    expect(relay.sent("machine.account_remove")).toHaveLength(0);
  });

  it("4148 · выбран, кого положить в слот, — slot.swap с account", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["slot.swap"] = () => ({ ok: true, result: { from: "a", to: "c" } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "c" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await accountsScreen(relay);
    await rm(t, "a", "a@x.io");
    const next = t.$<HTMLSelectElement>('[data-dlg="rm"] [data-f="next"]')!;
    next.value = "c";
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    expect(relay.sent("slot.swap")[0]).toMatchObject({ machine: "laptop", slot: "main", account: "c" });
    expect(relay.sent("slot.set")[0]).toMatchObject({ slot: "main", order: ["b", "c"] });
    expect(relay.sent("machine.account_remove")[0]).toMatchObject({ account: "a" });
  });

  it("4149 · удаление отказало — слово, диалог открыт; отказ slot.set — удаления нет", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["machine.account_remove"] = () => ({ ok: false, error: "in_slot" });
    const t = await accountsScreen(relay);
    await rm(t, "old", "o@x.io");
    const accs = relay.sent("machine.accounts").length;
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Удалить"));
    expect(t.text()).toContain("Аккаунт в слоте — сначала смените его в слоте");
    expect(t.$('[data-dlg="rm"]')).not.toBeNull();
    expect(relay.sent("machine.accounts")).toHaveLength(accs);

    const relay2 = fleetAccounts(AC, { laptop: { main: { account: "a", order: ["a"], wait: null, sessions: [] }, bot: { account: "x", order: ["x", "old"], wait: null, sessions: [] } } });
    relay2.handlers["slot.set"] = () => ({ ok: false, error: "no_slot" });
    const t2 = await accountsScreen(relay2);
    await rm(t2, "old", "o@x.io");
    await t2.click(t2.btn(t2.$('[data-dlg="rm"]'), "Удалить"));
    expect(t2.text()).toContain("slot.set bot: Такого слота нет");
    expect(relay2.sent("machine.account_remove")).toHaveLength(0);
  });
});

/** Ответы keeper и профилей для экрана «Машины». */
function machinesRelay(r: Roster = fleetRoster()) {
  const relay = fleetRelay(r);
  relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "1.0.1", rev: 7, os: "linux", parts: [{ part: "host", version: "1.1.58", state: "running", pid: 1 }] } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "org/p": { state: "ok" } } } });
  return relay;
}

async function machines(relay = machinesRelay(), url?: string) {
  const t = await pult({ relay, url });
  if (!url) await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
  await flush(10);
  return t;
}

/** Раскрыть строку машины в карточку. */
async function expand(t: Awaited<ReturnType<typeof pult>>, m: string) {
  await t.click(t.$(`[data-row="${m}"] .mc-head`));
  await flush(5);
}

describe("машины", () => {
  it("4150 · keeper не ответил — «keeper.state: слово» в карточке машины", async () => {
    const relay = machinesRelay();
    relay.handlers["keeper.state"] = (f) => (f.to === ".keeper@pc" ? { ok: false, error: "offline" } : { ok: true, result: { keeper: "1.0.1", parts: [] } });
    const t = await machines(relay);
    await expand(t, "pc");
    expect(t.$('[data-machine="pc"]')!.textContent).toContain("keeper.state: offline");
    await expand(t, "laptop");
    expect(t.$('[data-machine="laptop"]')!.textContent).not.toContain("keeper.state:");
  });

  it("4152 · машина ушла из roster — строка «ушла ЧЧ:ММ», в фильтре «ушли 1»; кадров к ней нет", async () => {
    // источник: прототип «Пульт и телефон» (подписан пользователем 2 нояб.): ушедшая машина остаётся строкой «ушла»
    const relay = machinesRelay();
    const t = await machines(relay);
    const n = relay.got.length;
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    relay.setRoster(r);
    await flush(10);
    expect(t.$('[data-row="pc"]')!.getAttribute("data-state")).toBe("gone");
    expect(t.$('[data-row="pc"]')!.textContent).toMatch(/ушла \d\d:\d\d/);
    expect(t.$('[data-filter="gone"]')!.textContent).toBe("ушли 1");
    expect(relay.got.slice(n).filter((f) => f.to === ".keeper@pc" || f.machine === "pc")).toEqual([]);
  });

  it("4192 · машина вернулась при закрытом экране «Машины» — keeper.state не шлётся", async () => {
    // источник: факт цикла тестов 2 нояб. — пульт опрашивал вернувшуюся машину и при закрытом экране; при открытии экран спрашивает все машины сам
    const relay = machinesRelay();
    await pult({ relay });
    await flush(10);
    const r = fleetRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
    await flush(10);
    expect(relay.sent("keeper.state")).toHaveLength(0);
  });

  it("4193 · экран «Машины» закрыли, машина вернулась, экран открыли снова — keeper.state на открытии, а не при закрытом", async () => {
    // источник: чьё: код (экран при открытии спрашивает все машины; закрытый — не спрашивает)
    const relay = machinesRelay();
    const t = await machines(relay);
    const before = relay.sent("keeper.state").length;
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    const r = fleetRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
    await flush(10);
    expect(relay.sent("keeper.state")).toHaveLength(before);
    await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
    await flush(10);
    expect(relay.sent("keeper.state").slice(before).map((f) => f.to)).toContain(".keeper@pc");
  });

  it("4153 · машина впервые в roster при открытом экране — keeper.state, а не «…»", async () => {
    const r = fleetRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    const relay = machinesRelay(r);
    const t = await machines(relay);
    // машина pc вошла гостем на laptop — клиент флота открыл соединение с её relay
    const full = fleetRoster();
    full.clients = [...full.clients, "@pc"];
    relay.setRoster(full);
    await flush(10);
    expect(relay.sent("keeper.state").map((f) => f.to)).toContain(".keeper@pc");
    await expand(t, "pc");
    expect(t.$('[data-machine="pc"] [data-keeper]')!.textContent).toBe("1.0.1 · план rev 7");
  });
});

describe("журнал флота", () => {
  const day = 86_400_000;
  const evs = () => {
    const now = Date.now();
    return [
      { id: 3, t: now, ev: "session.opened", from: "laptop", by: "panel-desk", callsign: "a@laptop", text: "открыта a@laptop" },
      { id: 2, t: now - day, ev: "machine.left", from: ".relay", machine: "pc", text: "pc ушла" },
      { id: 1, t: now - 7 * day, ev: "points.deleted", from: ".points", text: "удалены точки old" },
    ];
  };

  async function journal(relay = fleetRelay()) {
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    await flush(10);
    return t;
  }

  it("4159 · записи новые сверху по дням — «Сегодня», «Вчера», дата; текст как прислал ledger, «by»", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs(), more: false } });
    const t = await journal(relay);
    expect(relay.sent("ledger.read")[0]).toMatchObject({ to: ".ledger", limit: 50 });
    const days = t.$$(".jr-day").map((x) => x.textContent);
    expect(days.slice(0, 2)).toEqual(["Сегодня", "Вчера"]);
    expect(days).toHaveLength(3);
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["3", "2", "1"]);
    expect(t.$('.jr-r[data-id="3"]')!.textContent).toContain("открыта a@laptop · by panel-desk");
    expect(t.$('.jr-r[data-id="3"] em')!.textContent).toBe("a@laptop");
  });

  it("4160 · отказ ledger.read — «ledger.read: слово»", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "unknown_request" });
    const t = await journal(relay);
    expect(t.text()).toContain("ledger.read: unknown_request");
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
    relay.setRoster(fleetRoster());
    await flush();
    expect(relay.sent("ledger.read")).toHaveLength(1);
  });

  it("4162 · первое чтение отказало — следующий roster читает всё заново, строка отказа снята", async () => {
    const relay = fleetRelay();
    relay.handlers["ledger.read"] = () => ({ ok: false, error: "disconnected" });
    const t = await journal(relay);
    expect(t.text()).toContain("ledger.read: disconnected");
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: evs().slice(0, 2), more: false } });
    relay.setRoster(fleetRoster());
    await flush();
    expect(relay.sent("ledger.read").at(-1)).not.toHaveProperty("after");
    expect(t.text()).not.toContain("ledger.read: disconnected");
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["3", "2"]);
  });
});
