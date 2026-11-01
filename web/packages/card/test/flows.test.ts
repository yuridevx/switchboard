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
    m.contract = { ...m.contract, ...Object.fromEntries(CARD.map((n) => [n, 1])) };
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
    expect(t.$(".sb-bt")!.textContent).toBe("site@laptoplaptop не на связи");
    expect(t.$(".card-info")!.textContent).toBe("состояниеlaptop не на связи");
    expect(t.button("Остановить")).toBeNull();
    expect(t.button("Поднять")).toBeNull();
  });
});

describe("карточка в широком виде", () => {
  it("4081 · шапка из roster: состояние, чипы машины, слота и аккаунта, модели, профиля; лимит аккаунта с 70 %", async () => {
    const r = roster([], (x) => Object.assign(x.sessions[2], { state: "idle", profile: { id: "org/profiles/tester" }, remote: { url: "https://claude.ai/code/s1" } }));
    const relay = relayFor(r);
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { limits: { five_hour: { utilization: 0.82 }, seven_day: { utilization: 0.3 } } } } } });
    const t = await wideCard("poe-bot@pc", r, relay);
    expect(relay.sent("machine.accounts")).toEqual([expect.objectContaining({ machine: "pc" })]);
    expect(t.$(".cw-ht .sb-pill")!.textContent).toBe("свободна");
    expect(t.$$(".cw-chip").map((x) => x.textContent)).toEqual(["pc", "main", "sonnet", "tester"]);
    const r2 = roster([], (x) => Object.assign(x.sessions[0], { state: "idle", profile: { id: "org/profiles/tester" }, remote: { url: "https://claude.ai/code/s1" } }));
    const relay2 = relayFor(r2);
    relay2.handlers["machine.accounts"] = relay.handlers["machine.accounts"];
    const t2 = await wideCard("site@laptop", r2, relay2);
    expect(t2.$$(".cw-chip").map((x) => x.textContent)).toEqual(["laptop", "main · y0902", "opus · high", "tester", "5 ч 82 %"]);
    expect(t2.$<HTMLAnchorElement>(".cw-acts a")!.textContent).toBe("В claude.ai ↗");
  });

  it("4082 · остановлена — «Остановлена», «Разговор цел»; «Поднять» — session.start", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.start"] = () => ({ ok: true });
    const t = await wideCard("wiki@pc", roster(), relay);
    expect(t.$(".cw-pl")!.hidden).toBe(false);
    expect(t.$(".cw-pl")!.textContent).toContain("Остановлена");
    expect(t.$(".cw-pl")!.textContent).toContain("Разговор цел: «Поднять» продолжит его по resume.");
    await t.click(t.btn(".cw-pl", "Поднять"));
    expect(relay.sent("session.start")).toEqual([expect.objectContaining({ v: 1, callsign: "wiki@pc" })]);
  });

  it("4083 · «■ Прервать» у отвечающей — session.call interrupt; отказ — «Прервать: слово» в шапке", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.call"] = () => ({ ok: false, error: "not_running" });
    const t = await wideCard("site@laptop", roster(), relay);
    await t.click(t.btn(".cw-h", "■ Прервать"));
    expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: "site@laptop", method: "interrupt", args: [] })]);
    expect(t.$(".cw-h")!.textContent).toContain("Прервать: not_running");
    relay.handlers["session.call"] = () => ({ ok: true, result: null });
    await t.click(t.btn(".cw-h", "■ Прервать"));
    expect(t.$(".cw-h")!.textContent).not.toContain("Прервать: ");
  });

  it("4084 · не поднялась: «Поднять» отказан — тост «callsign: «Поднять» — слово»", async () => {
    const r = roster([], (x) => Object.assign(x.sessions[3], { state: "failed", failed: { host: "resume failed" } }));
    const relay = relayFor(r);
    relay.handlers["session.start"] = () => ({ ok: false, error: "offline" });
    const t = await wideCard("wiki@pc", r, relay);
    expect(t.$(".cw-pl b")!.textContent).toBe("Не поднялась: host: resume failed");
    await t.click(t.btn(".cw-pl", "Поднять"));
    expect(t.$(".sb-toast")!.textContent).toBe("wiki@pc: «Поднять» — offline");
  });

  it("4085 · сессии нет в roster — «не на связи», «pc не в roster», плашки и «Прервать» нет", async () => {
    const r = roster([], (x) => {
      x.machines = x.machines.filter((m) => m.machine !== "pc");
      x.sessions = x.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    });
    const t = await wideCard("poe-bot@pc", r);
    expect(t.$(".cw-ht")!.textContent).toBe("poe-bot@pcне на связиpc не в roster");
    expect(t.$(".cw-pl")!.hidden).toBe(true);
    expect(t.btn(".cw", "■ Прервать")).toBeNull();
  });
});

describe("настройки карточки", () => {
  it("4086 · «Применить» без изменений — «Нечего применять», session.update нет", async () => {
    const t = await wideCard("poe-bot@pc");
    await t.tab("set");
    await t.click(t.$('[data-sec="update"] [data-v="sonnet"]'));
    await t.click(t.btn('[data-sec="update"]', "Применить"));
    expect(t.$('[data-sec="update"]')!.textContent).toContain("Нечего применять — всё как сейчас.");
    expect(t.relay.sent("session.update")).toHaveLength(0);
  });

  it("4087 · отказ session.update — «Не применено: слово», выбор в форме остаётся", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.update"] = () => ({ ok: false, error: "bad_model" });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("set");
    await t.click(t.$('[data-sec="update"] [data-v="opus"]'));
    await t.click(t.btn('[data-sec="update"]', "Применить"));
    expect(t.$('[data-sec="update"]')!.textContent).toContain("Не применено: bad_model");
    expect(t.$('[data-sec="update"] [data-v="opus"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("4088 · слот — session.slot с выбранным; отказ профиля — «Не вышло: слово»", async () => {
    const relay = relayFor(roster());
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { main: {}, bot: {} } } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: { "org/p/tester": {} }, repos: {} } });
    relay.handlers["session.slot"] = () => ({ ok: true, result: { restart: false } });
    relay.handlers["session.profile"] = () => ({ ok: false, error: "not_found" });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("set");
    const pick = async (f: string, v: string) => {
      const sel = t.$<HTMLSelectElement>(`[data-f="${f}"]`)!;
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
      await flush();
    };
    await pick("slot", "bot");
    await t.click(t.btn('[data-sec="where"]', "Перевести"));
    expect(relay.sent("session.slot")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", slot: "bot" })]);
    expect(t.$('[data-sec="where"]')!.textContent).toContain("сразу");
    await pick("profile", "org/p/tester");
    await t.click(t.btn('[data-sec="where"]', "Сменить"));
    expect(t.$('[data-sec="where"]')!.textContent).toContain("Не вышло: not_found");
  });

  it("4089 · MCP: «выкл» — toggleMcpServer и статус заново; отказ — строка «метод: слово»", async () => {
    const relay = relayFor(roster());
    let status = [{ name: "fs", status: "connected" }];
    relay.handlers["session.call"] = (f) =>
      f.method === "mcpServerStatus" ? { ok: true, result: status } : f.method === "toggleMcpServer" ? ((status = [{ name: "fs", status: "disabled" }]), { ok: true, result: null }) : f.method === "reconnectMcpServer" ? { ok: false, error: "offline" } : { ok: true, result: null };
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("set");
    await t.click(t.btn('[data-sec="call"]', "выкл"));
    expect(relay.sent("session.call").find((f) => f.method === "toggleMcpServer")).toMatchObject({ args: ["fs", false] });
    expect(relay.sent("session.call").filter((f) => f.method === "mcpServerStatus")).toHaveLength(2);
    expect(t.btn('[data-sec="call"]', "вкл")).not.toBeNull();
    status = [{ name: "fs", status: "failed" }];
    relay.handlers["session.call"] = (f) => (f.method === "reconnectMcpServer" ? { ok: false, error: "offline" } : { ok: true, result: status });
    await t.click(t.btn('[data-sec="call"]', "вкл"));
    await t.click(t.btn('[data-sec="call"]', "переподключить"));
    expect(t.$('[data-sec="call"]')!.textContent).toContain("reconnectMcpServer: offline");
  });

  it("4090 · «Стоп» — session.stop, «Поднять» — session.start; отказ — строка «имя: слово»", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.stop"] = () => ({ ok: false, error: "stopping" });
    relay.handlers["session.start"] = () => ({ ok: true });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("set");
    await t.click(t.btn('[data-sec="ctl"]', "Стоп"));
    expect(relay.sent("session.stop")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc" })]);
    expect(t.$('[data-sec="ctl"]')!.textContent).toContain("session.stop: stopping");
    const t2 = await wideCard("wiki@pc", roster(), relay);
    await t2.tab("set");
    await t2.click(t2.btn('[data-sec="ctl"]', "Поднять"));
    expect(relay.sent("session.start")).toEqual([expect.objectContaining({ callsign: "wiki@pc" })]);
  });

  it("4091 · нет имени в contract — нет раздела «модель и ответ», строки «слот», раздела «сведения»; кадров нет", async () => {
    const r = roster(["session.update", "session.slot", "session.call"]);
    const t = await wideCard("poe-bot@pc", r);
    await t.tab("set");
    expect(t.$('[data-sec="update"]')).toBeNull();
    expect(t.$('[data-f="slot"]')).toBeNull();
    expect(t.$('[data-sec="call"]')).toBeNull();
    expect(t.relay.got.filter((f) => f.type === "session.call" || f.type === "session.update")).toEqual([]);
  });

  it("4092 · сессия не живая — сведений процесса не просим; «Поднять» и «Забыть…», без «Стоп» и «Прервать»", async () => {
    const t = await wideCard("wiki@pc");
    await t.tab("set");
    expect(t.relay.sent("session.call")).toEqual([]);
    expect(t.$('[data-sec="call"]')).toBeNull();
    const ctl = [...t.$('[data-sec="ctl"]')!.querySelectorAll("button")].map((b) => b.textContent);
    expect(ctl).toEqual(["Поднять", "Забыть…"]);
  });
});

describe("журнал машины в карточке", () => {
  const rec = (t: string, ev: string) => ({ t, part: "host", who: "core", callsign: "poe-bot@pc", kind: "stop", ev, word: "w", why: "y" });

  it("4093 · с полуночи, фильтр kind, «дальше →» с t последней, «ещё раньше» — с прошлого дня", async () => {
    const relay = relayFor(roster());
    relay.handlers["machine.journal"] = (f) => ({ ok: true, result: { records: f.since && String(f.since).startsWith("2026-10-31T23") ? [rec("2026-11-01T05:00:00.000Z", "x2")] : [rec("2026-11-01T06:00:00.000Z", "x1")], more: true } });
    const t = await wideCard("poe-bot@pc", roster(), relay);
    await t.tab("log");
    const first = relay.sent("machine.journal")[0];
    expect(first).toMatchObject({ v: 1, machine: "pc", callsign: "poe-bot@pc", limit: 50 });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(first.since).toBe(midnight.toISOString());
    expect(t.$(".cw-lr")!.textContent).toContain("x1 · w · y");
    await t.click(t.btn(".cw-log", "stop"));
    expect(relay.sent("machine.journal").at(-1)).toMatchObject({ kind: ["stop"] });
    await t.click(t.btn(".cw-log", "дальше →"));
    expect(relay.sent("machine.journal").at(-1)).toMatchObject({ since: "2026-11-01T06:00:00.000Z" });
    expect(t.$$(".cw-lr")).toHaveLength(2);
    await t.click(t.btn(".cw-log", "ещё раньше — с прошлого дня"));
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
