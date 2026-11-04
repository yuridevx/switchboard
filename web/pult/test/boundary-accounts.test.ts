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

describe("эталоны: аккаунты и слоты", () => {
  async function newLogin(code: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?x" } });
    relay.handlers["machine.login_code"] = () => code;
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await t.click(t.btn(null, "+ Новый аккаунт"));
    await t.click(t.btn(t.$(".sb-sec.dlg"), "laptop"));
    await t.type(t.$('[data-f="account"]'), "corp");
    await t.click(t.btn(t.$(".sb-sec.dlg"), "Войти"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ v: 1, machine: "laptop", account: "corp" })]);
    expect(t.$('[data-login="laptop:corp"] a')!.getAttribute("href")).toBe("https://claude.ai/oauth/authorize?x");
    await t.type(t.$('[data-f="code"]'), "Xk2p…#Qm9w…");
    await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Отправить"));
    return t;
  }

  it("190 · вход: machine.login → ссылка; один machine.login_code с кодом как есть; кода нет в хранилище, поле пустое; «Вошёл: corp@… · max»", async () => {
    const t = await newLogin({ ok: true, result: { email: "corp@x.io", plan: "max" } });
    expect(t.relay.sent("machine.login_code")).toEqual([{ type: "machine.login_code", id: expect.any(String), v: 1, machine: "laptop", account: "corp", code: "Xk2p…#Qm9w…" }]);
    expect(JSON.stringify(t.store.data)).not.toContain("Xk2p");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.$('[data-login="laptop:corp"]')!.textContent).toContain("Вошёл: corp@x.io · max");
  });

  it("191 · bad_code: «Код не принят — вход закрыт», второго machine.login_code нет; «Войти заново» — новый machine.login", async () => {
    const t = await newLogin({ ok: false, error: "bad_code" });
    const card = t.$('[data-login="laptop:corp"]')!;
    expect(card.textContent).toContain("Код не принят — вход закрыт");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
    await t.click(t.btn(card, "Войти заново"));
    expect(t.relay.sent("machine.login")).toHaveLength(2);
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
  });

  it("192 · лимиты по почте: machine.accounts { max_age: 120 } каждой машине; расход между машинами пульт не пересылает — его читает Host у Claude", async () => {
    // источник: дизайн «Пульт и телефон» (подписан 2 нояб.): «пересылки account.usage нет»; Host — эталон slots 3047
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: {
        accounts:
          f.machine === "laptop"
            ? { y0902: { email: "y0902@x.io", plan: "max", login: "ok", links: [], limits: { five_hour: { utilization: 0.04, resetsAt: T(16, 20), at: T(14, 40), src: "poll" } } } }
            : {
                y0902: {
                  email: "y0902@x.io",
                  plan: "max",
                  login: "ok",
                  links: [],
                  limits: { five_hour: { utilization: 0.09, resetsAt: T(16, 20), at: T(14, 55), src: "event" }, seven_day: { utilization: 0.66, resetsAt: T(20, 0), at: T(14, 58), src: "laptop" } },
                },
              },
      },
    });
    relay.handlers["account.usage"] = () => ({ ok: true });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await flush(10);
    expect(relay.sent("machine.accounts").map((f) => [f.machine, f.max_age])).toEqual([
      ["laptop", 120],
      ["pc", 120],
    ]);
    expect(relay.sent("account.usage")).toEqual([]);
    // одна карточка на почту; окна — запись одной машины, как пришла
    expect(t.$$("[data-account]")).toHaveLength(1);
    expect(t.$$('[data-account] [data-window]').map((x) => x.textContent!.split(" · ")[0])).toEqual(["5 ч4 %"]);
  });

  async function slots(swap: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers[SLOTS] = (f) =>
      ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: "y0902", order: ["y0902", "infirex", "work3"], wait: null, sessions: ["site@laptop", "profiles@laptop"] } } : {} } });
    relay.handlers["slot.swap"] = () => swap;
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await t.click(t.$('[data-slot="laptop:main"] [data-act="swap"]'));
    return t;
  }

  it("193 · «Сменить сейчас» → «следующего по порядку»: slot.swap без account, ответ to — в карточке; no_reserve — словами, слот прежний, повтора нет", async () => {
    const t = await slots({ ok: true, result: { from: "y0902", to: "infirex" } });
    expect(t.relay.sent("slot.swap")).toEqual([{ type: "slot.swap", id: expect.any(String), v: 1, machine: "laptop", slot: "main" }]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    const t2 = await slots({ ok: false, error: "no_reserve" });
    expect(t2.$('[data-slot="laptop:main"]')!.textContent).toContain("В запасе нет вошедшего ниже порога — слот прежний");
    expect(t2.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    expect(t2.relay.sent("slot.swap")).toHaveLength(1);
  });

  it("268 · один аккаунт в двух слотах: «в слотах main, bot» и «Сессии main/bot»; в слоте — «сейчас и в слоте bot»; удаление меняет его в обоих слотах по очереди", async () => {
    const relay = fleetRelay();
    const both = { main: ["infirex", "y0902"], bot: ["infirex", "y0902"] };
    const current: Record<string, string> = { main: "infirex", bot: "infirex" };
    relay.handlers[SLOTS] = (f) => ({
      ok: true,
      result: { slots: f.machine === "laptop" ? Object.fromEntries(Object.entries(both).map(([n, o]) => [n, { account: current[n], order: o, wait: null, sessions: [`${n}-s@laptop`] }])) : {} },
    });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: { accounts: f.machine === "laptop" ? { infirex: { login: "ok", limits: {} }, y0902: { login: "ok", limits: {} } } : {} },
    });
    relay.handlers["slot.swap"] = (f) => ((current[f.slot as string] = "y0902"), { ok: true, result: { from: "infirex", to: "y0902" } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "y0902" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await flush(10);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте bot");
    expect(t.$('[data-slot="laptop:bot"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте main");
    await t.go("#accounts?view=accounts");
    await flush(10);
    const row = t.$$('[data-machine="laptop"]').find((x) => x.textContent!.startsWith("@laptop") && x.textContent!.includes("в слотах"))!;
    expect(row.textContent).toContain("в слотах main, bot");
    expect(t.$$("[data-sess]").map((b) => b.textContent)).toEqual(["Сессии main (1)…", "Сессии bot (1)…"]);
    await t.click(t.btn(row, "Удалить…"));
    expect(t.$('[data-dlg="rm"]')!.textContent).toContain("infirex сейчас в слотах main, bot");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    await flush(10);
    // шаги выполняет машина: один запрос (слово пользователя 4 нояб.)
    expect(relay.sent("slot.swap")).toHaveLength(0);
    expect(relay.sent("slot.set")).toHaveLength(0);
    expect(relay.sent("machine.account_remove")).toEqual([expect.objectContaining({ machine: "laptop", account: "infirex" })]);
  });

  it("194 · подмену делает Host: до roster запросов нет; сменился account — один machine.accounts к laptop; «в слоте: y0902»; в чате site — «⇄ аккаунт: infirex → y0902»", async () => {
    const r = fleetRoster();
    for (const s of r.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "infirex", slot: { name: "main", wait: null } });
    const relay = fleetRelay(r);
    let inSlot = "infirex";
    relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: inSlot, order: ["infirex", "y0902"], wait: null, sessions: ["site@laptop", "wiki@laptop", "profiles@laptop"] } } : {} } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.go("#accounts?view=slots");
    await flush(10);
    const before = relay.got.length;
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    inSlot = "y0902";
    const r2 = fleetRoster();
    for (const s of r2.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "y0902", slot: { name: "main", wait: null } });
    relay.setRoster(r2);
    await flush(10);
    const after = relay.got.slice(before);
    expect(after.map((f) => `${f.type} ${f.machine}`)).toEqual(["machine.accounts laptop"]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$(".chat-sys.swap")!.textContent).toBe("аккаунт: infirex → y0902");
  });
});

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
    add.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a", "b", "c"] });
    await t.click(main().querySelector('[aria-label="убрать b"]'));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ order: ["a"] });
    await t.click(t.btn(t.$('[data-slot="laptop:bot"]'), "Удалить слот"));
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "bot", order: [] });
    expect(t.text()).toContain("слот bot удалён");
    await t.type(t.$('[data-f="newslot"]'), "night");
    await t.click(t.btn(null, "Создать"));
    // 6108 · созданный слот: поле имени пустое, повторное «Создать» не шлёт slot.set
    expect(t.$<HTMLInputElement>('[data-f="newslot"]')!.value).toBe("");
    expect(relay.sent("slot.set").at(-1)).toMatchObject({ slot: "night", order: ["a"] });
    expect(relay.sent("machine.accounts").length).toBeGreaterThanOrEqual(6);
  });

  it("4142 · перевод выбранных сессий — session.slot по одной, строка итогов, machine.slots заново", async () => {
    const relay = fleetAccounts(ACC, SLOTS);
    relay.handlers["session.slot"] = (f) => ({ ok: true, result: { restart: f.callsign === "site@laptop" } });
    const t = await accountsScreen(relay);
    await t.click(t.$('[data-account="name:a"] [data-sess="main"]'));
    const dlg = t.$('[data-dlg="sess"]')!;
    for (const c of dlg.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await t.click(c);
    const target = dlg.querySelector<HTMLSelectElement>('[data-f="target"]')!;
    await t.type(target, "bot", "change");
    const slots = relay.sent("machine.accounts").length;
    await t.click(t.btn(dlg, "Перевести"));
    expect(relay.sent("session.slot").map((f) => [f.callsign, f.slot])).toEqual([
      ["site@laptop", "bot"],
      ["profiles@laptop", "bot"],
    ]);
    expect(t.$('[data-dlg="sess"]')!.textContent).toContain("site@laptop: перейдёт между ходами · profiles@laptop: перешла");
    expect(relay.sent("machine.accounts").length).toBe(slots + 1);
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
    for (const c of dlg.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await t.click(c);
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
      delete m.contract["machine.accounts"];
    }
    const relay = fleetAccounts({}, {}, r);
    const t = await accountsScreen(relay, "/#accounts?view=slots");
    expect(t.text()).toContain("Нет машин со слотами на связи.");
    expect(relay.sent("machine.accounts")).toHaveLength(0);
  });
});

describe("E6 · слоты, когда машина молчит", () => {
  it("ответа ещё нет — «…», а не экран «слотов нет»; отказ — слово; прежние слоты остаются рядом со словом", async () => {
    const SL = { laptop: { main: { account: "a", order: ["a"], wait: null, sessions: [] } } };
    const relay = fleetAccounts({ laptop: ok({ a: { login: "ok" } }) }, SL);
    const answer = relay.handlers["machine.accounts"];
    let silent = true;
    relay.handlers["machine.accounts"] = (f) => (silent ? undefined : answer(f));
    const t = await accountsScreen(relay, "/#accounts?view=slots");
    expect(t.$("[data-slots-wait]")!.textContent).toBe("…");
    expect(t.text()).not.toContain("Новый слот на laptop");
    for (const q of relay.sent("machine.accounts")) relay.reply(String(q.id), { ok: true, result: { accounts: { a: { login: "ok" } }, slots: SL.laptop } });
    await flush(10);
    expect(t.$("[data-slots-wait]")).toBeNull();
    expect(t.$('[data-slot="laptop:main"]')).not.toBeNull();
    silent = false;
    relay.handlers["machine.accounts"] = () => ({ ok: false, error: "timeout" });
    relay.setRoster(fleetRoster({ sessions: fleetRoster().sessions.map((x) => (x.callsign === "site@laptop" ? { ...x, account: "b" } : x)) }));
    await flush(10);
    expect(t.text()).toContain("laptop · machine.accounts: timeout");
    expect(t.$('[data-slot="laptop:main"]')).not.toBeNull();
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

  it("4147 · нет запаса: отказ машины со словом и слотом, шагов со страницы нет", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["machine.account_remove"] = () => ({ ok: false, error: "no_reserve", why: "слот main" });
    const t = await accountsScreen(relay);
    await rm(t, "a", "a@x.io");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    expect(t.text()).toContain("В запасе нет вошедшего ниже порога — слот прежний — слот main");
    expect(relay.sent("slot.swap")).toHaveLength(0);
    expect(relay.sent("slot.set")).toHaveLength(0);
  });

  it("4148 · выбран, кого положить в слот, — next в запросе удаления", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await accountsScreen(relay);
    await rm(t, "a", "a@x.io");
    const next = t.$<HTMLSelectElement>('[data-dlg="rm"] [data-f="next"]')!;
    await t.type(next, "c", "change");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    expect(relay.sent("machine.account_remove")[0]).toMatchObject({ machine: "laptop", account: "a", next: "c" });
  });

  it("4149 · удаление отказало — слово, диалог открыт", async () => {
    const relay = fleetAccounts(AC, SL);
    relay.handlers["machine.account_remove"] = () => ({ ok: false, error: "refresh_locked" });
    const t = await accountsScreen(relay);
    await rm(t, "old", "o@x.io");
    const accs = relay.sent("machine.accounts").length;
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Удалить"));
    expect(t.text()).toContain("Claude сейчас обновляет вход этого аккаунта");
    expect(t.$('[data-dlg="rm"]')).not.toBeNull();
    expect(relay.sent("machine.accounts")).toHaveLength(accs);
  });
});

describe("аккаунты", () => {
  it("7291 · подмена аккаунта при открытом экране: окна свежие, max_age 0", async () => {
    // источник: факт — host/modules/accounts: без max_age чтение кэша без опроса; комментарий стора обещает свежие окна
    const r = fleetRoster();
    const relay = fleetRelay(r);
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    await screen(relay, "/#accounts");
    relay.setRoster({ ...r, sessions: r.sessions.map((s) => (s.callsign === "site@laptop" ? { ...s, account: "work3" } : s)) });
    await flush(10);
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "laptop", max_age: 0 });
  });

  it("6940 · машина пришла при открытом экране: ей machine.accounts max_age 120, в нём и слоты", async () => {
    // источник: чьё: код
    const relay = fleetRelay(withoutPc());
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    await screen(relay, "/#accounts");
    expect(relay.sent("machine.accounts").map((f) => f.machine)).toEqual(["laptop"]);
    relay.setRoster(withPc());
    await flush(10);
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "pc", max_age: 120 });
    expect(relay.sent("machine.accounts").at(-1)).toMatchObject({ machine: "pc" });
  });

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

  it("6951 · отказ снят ответом: связь с машиной вернулась с новым since — слова нет, её аккаунты на экране", async () => {
    // источник: факт — ответ снимает его; устав — клиенты переподключаются
    const relay = fleetRelay();
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = (f) => (f.machine === "pc" ? { ok: false, error: "offline" } : { ok: true, result: { accounts: {} } });
    const t = await screen(relay, "/#accounts");
    expect(t.text()).toContain("pc · machine.accounts: offline");
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "pc" ? { work: { login: "ok", email: "a@x.io" } } : {} } });
    relay.setRoster(bumped("pc"));
    await flush(10);
    expect(t.text()).not.toContain("machine.accounts: offline");
    expect(t.$('[data-account="a@x.io"] [data-machine="pc"]')).not.toBeNull();
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

describe("вход аккаунта", () => {
  it("5403 · «＋ войти на машине…» — машины на связи без этой почты; выбор — machine.login с тем же именем; ссылка входа — активная, «Копировать» кладёт её в буфер", async () => {
    const relay = fleetRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "poe", name: "poe", sessions: ["poe-bot@pc"] }] };
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "laptop" ? { night: { login: "ok", email: "night@x.io", plan: "max" } } : {} } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?code=true&x=1" } });
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } });
    const t = await pult({ relay, url: "/#accounts" });
    await flush(10);
    const card = t.$('[data-account="night@x.io"]')!;
    expect(card.querySelectorAll(".ac-m")).toHaveLength(1);
    await t.click(card.querySelector("[data-any]"));
    const pick = t.$('[data-any-pick="night@x.io"]')!;
    expect([...pick.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pc", "Отмена"]);
    await t.click(t.btn(pick, "pc"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ machine: "pc", account: "night" })]);
    const login = t.$('[data-login="pc:night"]')!;
    const a = login.querySelector<HTMLAnchorElement>("a")!;
    expect([a.getAttribute("href"), a.getAttribute("target"), a.textContent]).toEqual(["https://claude.ai/oauth/authorize?code=true&x=1", "_blank", "Открыть ссылку входа ↗"]);
    await t.click(t.btn(login, "Копировать"));
    expect(writes).toEqual(["https://claude.ai/oauth/authorize?code=true&x=1"]);
  });
});

describe("вход аккаунта · проект", () => {
  it("5404 · открыт проект: машины проекта в «＋ войти на машине…» — со ★", async () => {
    // источник: подпись экрана p17 прототипа «Пульт и телефон» (подписан 2 нояб.): ★ только с проектом
    const relay = fleetRelay();
    relay.scoped.global = { "fleet.projects": [{ id: "poe", name: "poe", sessions: ["poe-bot@pc"] }] };
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "laptop" ? { night: { login: "ok", email: "night@x.io", plan: "max" } } : {} } });
    relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    const t = await pult({ relay, url: "/#card?callsign=poe-bot%40pc" });
    await flush(10);
    location.hash = "#accounts";
    await flush(10);
    await t.click(t.$('[data-account="night@x.io"] [data-any]'));
    expect([...t.$('[data-any-pick="night@x.io"]')!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pc ★", "Отмена"]);
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
    const t = await pult({ relay: profilesRelay(), url: "/#machines" });
    await flush(10);
    expect(t.btn(null, "Синхронизировать профили")).toBeNull();
    expect(t.relay.sent("machine.profiles")).toHaveLength(0);
    await t.go("#profiles");
    await flush(10);
    expect(t.$('[data-act="sync"]')!.textContent).toBe("Синхронизировать");
  });
});

describe("видимое: аккаунты", () => {
  const W = T(16, 20);
  const accounts = (): Record<string, unknown> => ({
    a: { login: "ok", email: "a@x.io", plan: "max", limits: { five_hour: { utilization: 0.96, resetsAt: W, at: T(14, 40), src: "event" }, seven_day: { utilization: 0.5, resetsAt: W, at: T(14, 40), src: "event" } } },
    b: { login: "ok", email: "b@x.io", limits: { five_hour: { utilization: 0.2, resetsAt: W, at: T(14, 40), src: "poll" } } },
    c: { login: "pending" },
    d: { login: "ok", email: "d@x.io", limits: { five_hour: { utilization: 0.1, resetsAt: W, at: T(14, 40), src: "pc" } } },
  });
  const SL = { laptop: { main: { account: "a", order: ["a", "b"], wait: null, sessions: ["site@laptop"] }, bot: { account: "a", order: ["a"], wait: null, sessions: ["poe@laptop", "wiki@laptop"] } } };
  const fleet = (over: (r: ReturnType<typeof fleetAccounts>) => void = () => {}) => {
    const relay = fleetAccounts({ laptop: ok(accounts()) }, SL);
    over(relay);
    return relay;
  };

  it("карточка: почта, тариф, число сессий, источник окна, строка машины", async () => {
    const t = await accountsScreen(fleet());
    const a = t.$('[data-account="a@x.io"]')!;
    expect(t.$(".ac-cards")).not.toBeNull();
    expect(a.querySelector(".ac-hd")!.textContent).toBe("a@x.iomax0 сессий");
    expect(a.querySelectorAll(".ac-w")).toHaveLength(2);
    expect(a.textContent).toContain("по ответу сессии · @laptop");
    expect(t.$('[data-account="b@x.io"]')!.textContent).toContain("спросили claude · @laptop");
    expect(t.$('[data-account="d@x.io"]')!.textContent).toContain("от pc · @laptop");
    const row = a.querySelector('.ac-m[data-machine="laptop"]')!;
    expect(row.querySelector("b")!.textContent).toBe("@laptop");
    expect(row.textContent).toContain("вошёл");
    expect(row.textContent).toContain("в слотах main, bot");
    expect(t.$('[data-account="b@x.io"] [data-machine="laptop"]')!.textContent).toContain("запас main");
    const pending = t.$('[data-account="name:c"]')!;
    expect(pending.querySelector(".ac-hd")!.textContent).toBe("c0 сессий");
    expect(pending.textContent).toContain("вход идёт");
  });

  it("колонки широкого вида и заголовки; раздел зовётся «Аккаунты»", async () => {
    const t = await accountsScreen(fleet());
    expect(t.$(".ac-cols")).not.toBeNull();
    expect(t.$$(".ac-col").map((x) => x.dataset.col)).toEqual(["accounts", "slots"]);
    expect(t.$('[data-col="accounts"] h2')!.textContent).toBe("Аккаунты");
    expect(t.$('.sb-navcol button[data-screen="accounts"]')!.textContent).toBe("Аккаунты1");
  });

  it("новый аккаунт: заголовок, поля, «Отмена» закрывает", async () => {
    const t = await accountsScreen(fleet());
    await t.click(t.btn(null, "+ Новый аккаунт"));
    const d = t.$(".sb-sec.dlg")!;
    expect(d.querySelector("h4")!.textContent).toBe("Новый аккаунт");
    expect(d.textContent).toContain("Машина");
    expect(d.textContent).toContain("Имя на машине");
    expect(d.querySelector<HTMLInputElement>('[data-f="account"]')!.placeholder).toBe("corp");
    await t.click(t.btn(d, "Отмена"));
    expect(t.$(".sb-sec.dlg")).toBeNull();
  });

  it("карточка входа: Host запускает вход; ссылка и поле кода; ждём ответа машины; «Скрыть» убирает", async () => {
    const relay = fleet();
    relay.handlers["machine.login"] = () => undefined;
    relay.handlers["machine.login_code"] = () => undefined;
    const t = await accountsScreen(relay);
    await t.click(t.btn(null, "+ Новый аккаунт"));
    await t.click(t.btn(t.$(".sb-sec.dlg"), "laptop"));
    await t.type(t.$('[data-f="account"]'), "corp");
    await t.click(t.btn(t.$(".sb-sec.dlg"), "Войти"));
    const card = () => t.$('[data-login="laptop:corp"]')!;
    expect(card().textContent).toContain("Вход: corp на laptop");
    expect(card().textContent).toContain("Host laptop запускает вход…");
    relay.reply(relay.sent("machine.login")[0].id!, { ok: true, result: { url: "https://claude.ai/oauth/x" } });
    await flush(5);
    expect(card().querySelector(".ac-link a")!.textContent).toBe("Открыть ссылку входа ↗");
    expect(card().querySelector<HTMLInputElement>('[data-f="code"]')!.placeholder).toBe("Код со страницы");
    await t.type(t.$('[data-f="code"]'), "CODE");
    await t.click(t.btn(card(), "Отправить"));
    expect(card().textContent).toContain("ждём ответа laptop…");
    expect(t.$<HTMLInputElement>('[data-f="code"]')!.disabled).toBe(true);
    await t.click(t.btn(card(), "Скрыть"));
    expect(t.$('[data-login="laptop:corp"]')).toBeNull();
  });

  it("сессии слота: заголовок, смена, перевод, варианты списков, «Меняю…» и итог, «Закрыть»", async () => {
    const relay = fleet();
    relay.handlers["slot.swap"] = () => undefined;
    const t = await accountsScreen(relay);
    await t.click(t.$('[data-account="a@x.io"] [data-sess="main"]'));
    const d = () => t.$('[data-dlg="sess"]')!;
    expect(d().querySelector("h4")!.textContent).toBe("Сессии слота main на laptop · сейчас a");
    expect(d().textContent).toContain("Сменить аккаунт всему слоту");
    expect(d().textContent).toContain("Перевести выбранные в другой слот");
    expect([...d().querySelectorAll<HTMLOptionElement>('[data-f="swap"] option')].map((o) => o.textContent)).toEqual(["следующего по порядку — выберет Host", "b"]);
    expect([...d().querySelectorAll<HTMLOptionElement>('[data-f="target"] option')].map((o) => o.textContent)).toEqual(["bot", "без слота — вход машины"]);
    await t.click(t.btn(d(), "Сменить сейчас"));
    expect(d().querySelector('[data-note="swap:laptop:main"]')!.textContent).toBe("Меняю…");
    relay.reply(relay.sent("slot.swap")[0].id!, { ok: true, result: { from: "a", to: "b" } });
    await flush(5);
    expect(d().querySelector('[data-note="swap:laptop:main"]')!.textContent).toBe("a → b");
    await t.click(t.btn(d(), "Закрыть"));
    expect(t.$('[data-dlg="sess"]')).toBeNull();
  });

  it("удаление: что будет со слотом и сессиями, кого положить, что стирается, «Удаляю…»", async () => {
    const relay = fleet();
    relay.handlers["machine.account_remove"] = () => undefined;
    const t = await accountsScreen(relay);
    await t.click(t.btn(t.$('[data-account="a@x.io"] [data-machine="laptop"]'), "Удалить…"));
    const d = () => t.$('[data-dlg="rm"]')!;
    expect(d().querySelector("h4")!.textContent).toBe("Удалить a с laptop");
    expect(d().textContent).toContain("a сейчас в слотах main, bot");
    expect(d().textContent).toContain("Сначала каждый слот сменит аккаунт — site, poe, wiki продолжат на новом, — потом a уйдёт из порядка слотов и удалится.");
    expect(d().textContent).toContain("Кого положить в слоты");
    expect(d().textContent).toContain("Стирается только папка a на laptop. Вход машины и другие аккаунты не трогаются.");
    expect([...d().querySelectorAll<HTMLOptionElement>('[data-f="next"] option')].map((o) => o.textContent)).toEqual(["следующего по порядку — выберет Host", "b"]);
    await t.click(t.btn(d(), "Сменить и удалить"));
    expect(t.$('[data-note="rm:laptop:a"]')!.textContent).toBe("Удаляю…");
    relay.reply(relay.sent("machine.account_remove")[0].id!, { ok: true, result: { wiped: true } });
    await flush(5);
    expect(t.$('[data-dlg="rm"]')).toBeNull();
    expect(t.$('[data-note="rm:laptop:a"]')!.textContent).toBe("a удалён с laptop");
  });

  it("удаление из одного слота: «слот сменит», «Кого положить в слот main»; аккаунт вне слотов — без этих строк", async () => {
    const relay = fleetAccounts({ laptop: ok({ a: { login: "ok", email: "a@x.io" }, b: { login: "ok", email: "b@x.io" }, z: { login: "ok", email: "z@x.io" } }) }, { laptop: { main: { account: "a", order: ["a", "b"], wait: null, sessions: [] } } });
    const t = await accountsScreen(relay);
    await t.click(t.btn(t.$('[data-account="a@x.io"] [data-machine="laptop"]'), "Удалить…"));
    const d = t.$('[data-dlg="rm"]')!;
    expect(d.textContent).toContain("a сейчас в слоте main");
    expect(d.textContent).toContain("Сначала слот сменит аккаунт — сессии слота продолжат на новом, — потом a уйдёт из порядка слотов и удалится.");
    expect(d.textContent).toContain("Кого положить в слот main");
    await t.click(t.btn(d, "Отмена"));
    await t.click(t.btn(t.$('[data-account="z@x.io"] [data-machine="laptop"]'), "Удалить…"));
    expect(t.$('[data-dlg="rm"]')!.textContent).not.toContain("Сначала");
    expect(t.$('[data-dlg="rm"] [data-f="next"]')).toBeNull();
  });

  it("слот: сессии, текущий, окна, запас с расходом, общий аккаунт, «Сохраняю…» и итог, новый слот", async () => {
    const relay = fleet();
    relay.handlers["slot.set"] = () => undefined;
    const t = await accountsScreen(relay, "/#accounts?view=slots&machine=laptop");
    const s = () => t.$('[data-slot="laptop:bot"]')!;
    expect(s().querySelector(".ac-hd")!.textContent).toBe("Слот bot2 сессии: poe, wiki");
    expect(t.$('[data-slot="laptop:main"] .ac-hd')!.textContent).toBe("Слот main1 сессия: site");
    expect(s().querySelector("[data-current]")!.textContent).toBe("в слоте: a · сейчас и в слоте main");
    expect(s().querySelector("[data-shared]")!.getAttribute("data-shared")).toBe("main");
    expect(s().querySelectorAll(".ac-w")).toHaveLength(2);
    expect(s().textContent).toContain("Запас — по порядку");
    const ord = t.$('[data-slot="laptop:main"]')!.querySelectorAll(".ac-ord");
    expect(ord).toHaveLength(2);
    expect(ord[0].textContent).toContain("5 ч 96 %");
    expect(ord[1].querySelector("b")!.textContent).toBe("b");
    expect(ord[1].textContent).toContain("5 ч 20 %");
    expect([...t.$('[data-slot="laptop:main"]')!.querySelectorAll<HTMLOptionElement>('[data-f="add:main"] option')].map((o) => o.textContent)).toEqual(["+ аккаунт в запас", "d"]);
    expect([...t.$('[data-slot="laptop:main"]')!.querySelectorAll<HTMLOptionElement>('[data-f="now:main"] option')].map((o) => o.textContent)).toEqual(["следующего по порядку — выберет Host", "b"]);
    expect(t.$("[data-slot-machines]")).not.toBeNull();
    expect(t.text()).toContain("+ Новый слот на laptop");
    expect(t.$<HTMLInputElement>('[data-f="newslot"]')!.placeholder).toBe("имя слота");
    await t.click(t.$('[data-slot="laptop:main"] [aria-label="b выше"]'));
    expect(t.$('[data-note="set:laptop:main"]')!.textContent).toBe("Сохраняю…");
    relay.reply(relay.sent("slot.set")[0].id!, { ok: true, result: { account: "a" } });
    await flush(5);
    expect(t.$('[data-note="set:laptop:main"]')!.textContent).toBe("порядок сохранён");
  });

  it.each([
    ["no_account", "Такого аккаунта нет на машине"],
    ["no_slot", "Такого слота нет"],
    ["not_logged_in", "У аккаунта нет входа"],
    ["refresh_locked", "Claude сейчас обновляет вход этого аккаунта — повторите через минуту"],
    ["slot_dir_busy", "На месте слота на машине папка с файлами — разберите её"],
    ["account_dir_busy", "Папка аккаунта занята — повторите через минуту"],
  ])("слово %s — строка на экране и причина машины рядом", async (word, text) => {
    const relay = fleet();
    relay.handlers["slot.swap"] = () => ({ ok: false, error: word, why: "причина машины" });
    const t = await accountsScreen(relay, "/#accounts?view=slots&machine=laptop");
    await t.click(t.$('[data-slot="laptop:main"] [data-act="swap"]'));
    await flush(5);
    expect(t.$('[data-note="swap:laptop:main"]')!.textContent).toBe(`${text} — причина машины`);
  });

  it("отказ чтения: строка «машина · запрос» со своим якорем; нет отказа — строки нет", async () => {
    const t = await accountsScreen(fleetAccounts({ pc: { ok: false, error: "offline" }, laptop: ok(accounts()) }, SL));
    expect(t.$('[data-refused="pc · machine.accounts"]')!.textContent).toBe("pc · machine.accounts: offline");
    expect(t.$('[data-refused="laptop · machine.accounts"]')).toBeNull();
  });

  it("узкий вид телефона: переключатель «Аккаунты» и «Слоты», кнопка нового аккаунта только на аккаунтах", async () => {
    const relay = fleetAccounts({ laptop: ok(accounts()) }, SL);
    const t = await stand(phoneParts(fakeBrowser("granted")), { relay, store: memoryStore({ key: KEY }), url: "/#accounts", options: { sections: ["inbox", "board", "accounts"] } });
    await flush(10);
    const find = (x: string) => [...t.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === x) ?? null;
    expect(t.$(".ac-cols")).toBeNull();
    expect(find("Аккаунты")!.getAttribute("aria-pressed")).toBe("true");
    expect(find("+ Новый аккаунт")).not.toBeNull();
    expect(t.$("[data-account]")).not.toBeNull();
    await t.click(find("Слоты"));
    expect(find("Слоты")!.getAttribute("aria-pressed")).toBe("true");
    expect(find("+ Новый аккаунт")).toBeNull();
    expect(t.$("[data-slot]")).not.toBeNull();
    expect(t.$("[data-account]")).toBeNull();
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
