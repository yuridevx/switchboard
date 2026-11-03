// Флоу web-card по плану цикла тестов (web): карточка без сессии в roster, широкая карточка, настройки и журнал машины.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import type { Roster } from "@switchboard/web-core";
import { createCard, manifest as cardM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

/** Имена Host, которыми пользуется карточка пульта. */
const CARD = ["session.update", "session.spec", "session.call", "session.remove", "session.slot", "machine.slots", "session.profile", "machine.profiles", "machine.accounts", "machine.journal"];

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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("карточка в узком виде", () => {
  it("4080 · сессии нет в roster — «laptop не на связи», кнопок нет", async () => {
    const r = homeRoster();
    r.machines = r.machines.filter((m) => m.machine !== "laptop");
    r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@laptop"));
    const t = await stand(parts(), { relay: relayFor(r), url: "/#card?callsign=site%40laptop&tab=info" });
    await flush();
    expect(t.$(".sb-bt")!.textContent).toBe("site@laptop@laptop не на связи");
    expect(t.$(".card-info")!.textContent).toBe("адресsite@laptop");
    expect(t.button("Остановить")).toBeNull();
    expect(t.button("Запустить")).toBeNull();
  });
});

describe("карточка в широком виде", () => {
  // источник: прототип «Пульт и телефон», подписан пользователем 2 нояб. («основа дизайна ок»); комментарии к прототипу:
  // «переработай статус в 1 строку», «перенести в право в контекст меню всю панель», «не запустилось — ховер индикатора,
  // опус и высокое конфигурируемый отсюда», «где-то надо сделать лимиты и аккаунт активный», сведения — «опциональные»
  it("5301 · шапка — одна строка: лампа, позывной, «модель · усилие ▾», «аккаунт · % ▾» (жёлтая с 70 %), вкладки, «⋯»", async () => {
    const r = roster();
    const relay = relayFor(r);
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "dev@mail", plan: "Max 20×", limits: { five_hour: { utilization: 0.82, resetsAt: 1793660000 }, seven_day: { utilization: 0.41 } } } } } });
    const t = await wideCard("site@laptop", r, relay);
    const head = t.$(".cw-h")!;
    expect(head.querySelector(".cw-cs")!.textContent).toBe("site@laptop");
    expect(head.querySelector('[data-pop="model"]')!.textContent).toBe("opus · высокое ▾");
    expect(head.querySelector('[data-pop="acc"]')!.textContent).toBe("y0902 · 82 % ▾");
    expect(head.querySelector('[data-pop="acc"]')!.classList.contains("lim")).toBe(true);
    expect(head.querySelector(".cw-tabs")).not.toBeNull();
    expect([...head.querySelectorAll(".cw-tabs [data-tab]")].map((b) => b.textContent)).toEqual(["Разговор", "Настройки", "Журнал"]);
    expect(head.querySelector('[data-pop="menu"]')).not.toBeNull();
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

  it("5303 · модель и усилие — из шапки: модели — ответ SDK машины (supportedModels), выбор — session.update; отказ — тост", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? { ok: true, result: [{ value: "opus", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet 5.5" }] } : { ok: true, result: null });
    relay.handlers["session.update"] = () => ({ ok: true, result: { now: ["model"] } });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.click(t.$('[data-pop="model"]'));
    expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", method: "supportedModels" })]);
    expect(t.$$(".cw-pop [data-model]").map((b) => b.textContent)).toEqual(["Opus 5.5", "✓ Sonnet 5.5"]);
    await t.click(t.$('.cw-pop [data-model="opus"]'));
    expect(relay.sent("session.update")).toEqual([expect.objectContaining({ v: 1, callsign: "poe-bot@pc", model: "opus" })]);
    expect(t.$(".cw-pop")).toBeNull();
    relay.handlers["session.update"] = () => ({ ok: false, error: "bad_spec" });
    await t.click(t.$('[data-pop="model"]'));
    await t.click(t.$('.cw-pop [data-effort="low"]'));
    expect(relay.sent("session.update").at(-1)).toMatchObject({ callsign: "poe-bot@pc", effort: "low" });
    expect(t.$(".sb-toast")!.textContent).toBe("poe-bot@pc: усилие — bad_spec");
    // в настройках модели и усилия нет — одно место
    await t.tab("set");
    expect(t.$(".cw-set [data-model], .cw-set [data-effort]")).toBeNull();
  });

  it("5304 · аккаунт и лимиты: окно — почта и план, слот, окна лимитов, очередь слота; слот ждёт сброса — «ждёт сброса ЧЧ:ММ»", async () => {
    const reset = Math.floor(new Date(2026, 10, 2, 16, 40).getTime() / 1000);
    const r = roster([], (x) => Object.assign(x.sessions[0], { slot: { name: "night", wait: reset } }));
    const relay = relayFor(r);
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { email: "night@mail", plan: "Max 5×", limits: { five_hour: { utilization: 0.98, resetsAt: reset } } } } } });
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { night: { account: "y0902", order: ["y0902", "spare"], wait: reset, sessions: ["site@laptop"] } } } });
    const t = await wideCard("site@laptop", r, relay);
    const b = t.$('[data-pop="acc"]')!;
    expect(b.textContent).toBe("y0902 · ждёт сброса 16:40 ▾");
    expect(b.classList.contains("you")).toBe(true);
    await t.click(b);
    const pop = t.$(".cw-pop")!;
    expect(pop.querySelector(".cw-kv")!.textContent).toBe("аккаунтnight@mail · Max 5×слотnight @laptop");
    expect(pop.querySelector('[data-win="five_hour"]')!.textContent).toBe("5 ч98 % · до 16:40");
    expect(pop.textContent).toContain("очередь слота: y0902 → spare");
    await t.click(t.btn(".cw-pop", "Сменить слот"));
    expect(t.$('.cw-tabs [aria-selected="true"]')!.textContent).toBe("Настройки");
  });

  it("5305 · меню ⋯: профиль, папка (поле dir), машина, инцидент; пункты места card.menu — экран с from; claude.ai — ссылкой", async () => {
    const r = roster([], (x) => Object.assign(x.sessions[0], { dir: "~/Projects/site", profile: { id: "team/profiles/ops", state: "ok" }, incident: { type: "disk-full", key: "/" }, remote: { url: "https://claude.ai/code/s1" } }));
    const t = await wideCard("site@laptop", r);
    await t.click(t.$('[data-pop="menu"]'));
    expect(t.$(".cw-pop .cw-kv")!.textContent).toBe("профильopsпапка~/Projects/siteмашина@laptopинцидентdisk-full · /");
    expect(t.$<HTMLAnchorElement>('.cw-pop a[href="https://claude.ai/code/s1"]')!.textContent).toBe("Открыть в claude.ai ↗");
    // клик мимо закрывает меню
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(t.$(".cw-pop")).toBeNull();
  });

  it("5306 · сведения сбоку — по желанию: по умолчанию скрыты; «Сведения сбоку» — показаны и запомнены на устройстве", async () => {
    const { memoryStore } = await import("@switchboard/web-core");
    const { KEY } = await import("../../core/stand/app.ts");
    const store = memoryStore({ key: KEY });
    const r = roster([], (x) => Object.assign(x.sessions[0], { dir: "~/Projects/site", by: "pult~you@mail", parent: "pult~you@mail" }));
    const relay = relayFor(r);
    const t = await stand(parts(), { relay, wide: true, store, url: "/#card?callsign=site%40laptop", options: { beside: { card: "board", chat: "board", ask: "board" } } });
    await flush();
    expect(t.$("aside.cw-info")).toBeNull();
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-act="info"]'));
    await flush();
    expect(t.$("aside.cw-info")!.textContent).toContain("задачу далpult~you@mail");
    expect(t.$("aside.cw-info")!.textContent).toContain("папка~/Projects/site");
    const t2 = await stand(parts(), { relay: relayFor(r), wide: true, store, url: "/#card?callsign=site%40laptop", options: { beside: { card: "board", chat: "board", ask: "board" } } });
    await flush();
    expect(t2.$("aside.cw-info")).not.toBeNull();
  });

  it("6106 · сведения открыты, сессия ожила позже — список серверов MCP приходит без переоткрытия", async () => {
    const r = roster([], (x) => void (x.sessions[0].state = "stopped"));
    const relay = relayFor(r);
    relay.handlers["session.call"] = (f) => (f.method === "mcpServerStatus" ? { ok: true, result: [{ name: "fleet", status: "connected" }] } : { ok: true, result: null });
    const t = await wideCard("site@laptop", r, relay);
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-act="info"]'));
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
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-act="info"]'));
    await flush();
    const toggled = () => relay.sent("session.call").filter((f) => f.method === "toggleMcpServer");
    await t.click(t.$(".cw-sw span"));
    await flush();
    expect(toggled()).toHaveLength(0);
    await t.click(t.$('[data-mcp="fleet"]'));
    await flush();
    expect(toggled()).toHaveLength(1);
  });

  it("4085 · сессии нет в roster — «pc не на связи», плашки нет", async () => {
    const r = roster([], (x) => {
      x.machines = x.machines.filter((m) => m.machine !== "pc");
      x.sessions = x.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    });
    const t = await wideCard("poe-bot@pc", r);
    expect(t.$(".cw-h")!.textContent).toContain("poe-bot@pc@pc✎не на связи");
    expect(t.$(".cw-pl")!.hidden).toBe(true);
  });
});

describe("настройки карточки", () => {
  it("5307 · профиль и слот — чипами (session.profile, session.slot), отказ — «Не вышло: слово»; «Убрать…» — подтверждение, session.remove", async () => {
    const relay = relayFor(roster());
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "team/profiles/ops": {}, "team/profiles/writer": {} } } });
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"] }, bot: { account: "work3", order: ["work3"] } } } });
    relay.handlers["session.profile"] = () => ({ ok: false, error: "no_profile" });
    relay.handlers["session.slot"] = () => ({ ok: true, result: { restart: true } });
    relay.handlers["session.remove"] = () => ({ ok: true });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("set");
    expect(t.$$('[data-sec="profile"] [data-profile]').map((b) => b.textContent)).toEqual(["ops", "writer", "без профиля"]);
    await t.click(t.$('[data-profile="team/profiles/writer"]'));
    expect(relay.sent("session.profile")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", profile: "team/profiles/writer" })]);
    expect(t.$('[data-sec="profile"]')!.textContent).toContain("Не вышло: no_profile");
    await t.click(t.$('[data-slot="bot"]'));
    expect(relay.sent("session.slot")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", slot: "bot" })]);
    expect(t.$('[data-sec="slot"]')!.textContent).toContain("после хода");
    await t.click(t.btn(".cw-set", "Убрать…"));
    expect(relay.sent("session.remove")).toHaveLength(0);
    await t.click(t.btn(".cw-confirm", "Убрать"));
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

  it("4094 · отказ machine.journal — «machine.journal: слово», без «Записей нет»", async () => {
    const relay = relayFor(roster());
    relay.handlers["machine.journal"] = () => ({ ok: false, error: "offline" });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("log");
    expect(t.$(".cw-log")!.textContent).toContain("machine.journal: offline");
    expect(t.$(".cw-log")!.textContent).not.toContain("Записей нет.");
  });

  it("4095 · записей нет — «Записей нет.», «дальше →» нет", async () => {
    const relay = relayFor(roster());
    relay.handlers["machine.journal"] = () => ({ ok: true, result: { records: [], more: false } });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("log");
    expect(t.$(".cw-log")!.textContent).toContain("Записей нет.");
    expect(t.btn(".cw-log", "дальше →")).toBeNull();
  });
});
