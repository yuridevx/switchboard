// Покрытие плана route-board-project: проект открытой сессии, первый показ, настройки ещё не ответили, строка с вопросом, сброс вида.
import type { AppModule, AppPart } from "@switchboard/web-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/relay";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore } from "@switchboard/web-core";
import { createBoard, manifest as boardM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";

function fleet(): Roster {
  const r = homeRoster();
  r.sessions = [
    { callsign: "migrate@laptop", state: "waiting", dir: "~/Projects/switchboard", by: "phone~you@mail" },
    { callsign: "api@pc", state: "idle", dir: "~/projects/pfarm", by: "phone~you@mail" },
    { callsign: "note@pc", state: "idle", dir: "~/notes", by: "phone~you@mail" },
  ];
  r.clients = ["phone~you@mail"];
  return r;
}
const PROJECTS = () => [
  { id: "switchboard", name: "switchboard", sessions: ["migrate@laptop"] },
  { id: "pfarm", name: "pfarm", sessions: ["api@pc"] },
];
function relayWith(r = fleet()) {
  const relay = new FakeRelay(r);
  relay.scoped = { global: { "fleet.projects": PROJECTS() } };
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  return relay;
}

/** Приложение и модуль «Работы»: метка project.current видна снаружи. */
async function start(o: Parameters<typeof stand>[1] = {}) {
  let board!: AppModule;
  const list: AppPart[] = [
    { manifest: boardM, module: (app) => (board = createBoard(app)) },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
  ];
  const t = await stand(list, { relay: relayWith(), ...o });
  await flush(5);
  return { ...t, current: () => board.marks!["project.current"]() };
}
const expanded = (t: { $: (s: string) => Element | null }, id: string) => t.$(`.pj-t[data-proj="${id}"]`)?.getAttribute("aria-expanded");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("проект открытой сессии", () => {
  it("6971 · открыта сессия свёрнутого проекта: проект развёрнут и последний, строка видна", async () => {
    // источник: чьё: код
    const store = memoryStore({ key: KEY });
    const t = await start({ store, wide: true, options: { beside: { card: "board" } } });
    expect(expanded(t, "pfarm")).toBe("false");
    await t.go("#card?callsign=api%40pc");
    expect(expanded(t, "pfarm")).toBe("true");
    expect(t.current()).toBe("pfarm");
    expect(t.$('.bd-row[data-callsign="api@pc"]')).not.toBeNull();
    expect((await store.get<Record<string, boolean>>("collapsed"))!.pfarm).toBe(false);
  });

  it("6972 · ответа настроек ещё нет: сессия ждёт и находит проект после ответа", async () => {
    // источник: чьё: код
    const relay = relayWith();
    const replies: Array<{ id: string; scope?: unknown }> = [];
    relay.handlers["prefs.get"] = () => undefined;
    const t = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
    expect(t.current()).toBeNull();
    for (const f of relay.sent("prefs.get")) replies.push(f as never);
    for (const f of replies) relay.reply(f.id, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
    await flush(10);
    expect(t.current()).toBe("pfarm");
    expect(expanded(t, "pfarm")).toBe("true");
  });

  it("6973 · проект уже развёрнут: последний в метке, раздел collapsed не пишется", async () => {
    // источник: чьё: код
    const store = memoryStore({ key: KEY });
    const t = await start({ store, wide: true, options: { beside: { card: "board" } } });
    await t.click(t.$('.pj-t[data-proj="pfarm"]'));
    const before = JSON.stringify(await store.get("collapsed"));
    const set = vi.spyOn(store, "set");
    await t.go("#card?callsign=api%40pc");
    expect(t.current()).toBe("pfarm");
    expect(set.mock.calls.filter(([k]) => k === "collapsed")).toEqual([]);
    expect(JSON.stringify(await store.get("collapsed"))).toBe(before);
  });

  it("6974 · сессия без проекта: «Без проекта» развёрнут, project.current пусто", async () => {
    // источник: факт — «Без проекта» не проект: «последний проект» его не называет
    const t = await start({ wide: true, options: { beside: { card: "board" } } });
    await t.go("#card?callsign=api%40pc");
    expect(t.current()).toBe("pfarm");
    await t.go("#card?callsign=note%40pc");
    expect(t.current()).toBeNull();
    expect(t.$('.bd-row[data-callsign="note@pc"]')).not.toBeNull();
  });

  it("6975 · переход не на сессию: project.current прежний; ждавшая сессия проект не разворачивает", async () => {
    // источник: чьё: код
    const t = await start({ wide: true, options: { beside: { card: "board" } } });
    await t.go("#card?callsign=api%40pc");
    await t.go("#sessions");
    expect(t.current()).toBe("pfarm");

    const relay = relayWith();
    relay.handlers["prefs.get"] = () => undefined;
    const t2 = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
    await t2.go("#sessions");
    for (const f of relay.sent("prefs.get")) relay.reply(f.id!, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
    await flush(10);
    expect(t2.current()).toBeNull();
    expect(expanded(t2, "pfarm")).toBe("false");
  });

  it("6976 · настройки отказали: список рисуется, проект сессии развёрнут, ожидания нет", async () => {
    // источник: факт — отказ тоже ответ; устав — у всех операций лимит
    const relay = relayWith();
    relay.handlers["prefs.get"] = () => ({ ok: false, error: "not_user" });
    const t = await start({ relay, wide: true, options: { beside: { card: "board" } }, url: "/#card?callsign=api%40pc" });
    expect(t.$('.bd-row[data-callsign="api@pc"]')).not.toBeNull();
  });

  it("6977 · связи нет: список рисуется без ожидания; связь открылась — prefs.get обеих областей", async () => {
    // источник: факт — связи нет вовсе, рисуем встроенное; устав — клиенты переподключаются
    const relay = relayWith();
    relay.handlers["prefs.get"] = () => undefined;
    const t = await start({ relay });
    expect(t.$$(".bd-row")).toHaveLength(0);
    relay.handlers["prefs.get"] = (f) => ({ ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
    const before = relay.sent("prefs.get").length;
    relay.drop();
    await flush(2);
    expect(t.$$(".bd-row").length + t.$$(".pjs").length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    await flush(10);
    const after = relay.sent("prefs.get").slice(before);
    expect(after.map((f) => f.scope ?? "user").sort()).toEqual(["global", "user"]);
  });
});

describe("окна доски", () => {
  const press = (el: Element | null, key: string) => el!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("7260 · новый фильтр: фокус на имени; правка своего — фокус не трогает", async () => {
    // источник: чьё: код — у нового имя вводится первым, у своего обычно меняют условия
    const t = await start();
    await t.click(t.$(".fc.add"));
    expect(document.activeElement).toBe(t.$('[data-editor] [data-f="name"]'));
    const name = t.$<HTMLInputElement>('[data-editor] [data-f="name"]')!;
    name.value = "Ф";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await t.click(t.$('[data-act="fsave"]'));
    await flush(5);
    (document.activeElement as HTMLElement).blur();
    await t.click(t.$('[data-fid="mine"]'));
    await t.click(t.$('[data-fid^="f"]'));
    await t.click(t.$('[data-fid^="f"]'));
    expect(t.$("[data-editor]")).not.toBeNull();
    expect(document.activeElement).not.toBe(t.$('[data-editor] [data-f="name"]'));
  });

  it("7261 · меню проекта: фокус на имени", async () => {
    // источник: чьё: код — переименование с клавиатуры
    const t = await start();
    press(t.$('.grip[data-proj="pfarm"]'), "Enter");
    await flush(3);
    expect(document.activeElement).toBe(t.$('[data-f="project-name"]'));
  });

  it("7262 · окно фильтра открыто, сессия сменила состояние: «подходит» считает заново", async () => {
    // источник: факт — строка показывает, сколько сессий подойдёт сейчас; чипы при этом не меняются
    const relay = relayWith();
    const t = await start({ relay });
    await t.click(t.$(".fc.add"));
    await t.click(t.$('[data-field="states"] [data-v="waiting"]'));
    expect(t.$(".fe-n")!.textContent).toBe("подходит 1 сессия · 1 проект");
    const r = fleet();
    r.sessions[1].state = "waiting";
    relay.setRoster(r);
    await flush(5);
    expect(t.$(".fe-n")!.textContent).toBe("подходит 2 сессии · 2 проекта");
  });
});

describe("первый показ", () => {
  it("6978 · настройки не ответили: collapsed не пишется; после ответа — решение по проектам из ответа", async () => {
    // источник: факт — первый рисунок ждёт ответа prefs
    const store = memoryStore({ key: KEY });
    const relay = relayWith();
    relay.handlers["prefs.get"] = () => undefined;
    const t = await start({ relay, store });
    relay.setRoster(fleet());
    await flush(5);
    expect(await store.get("collapsed")).toBeUndefined();
    for (const f of relay.sent("prefs.get")) relay.reply(f.id!, { ok: true, result: { values: f.scope === "global" ? { "fleet.projects": PROJECTS() } : {} } });
    await flush(10);
    expect(await store.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });
    expect(expanded(t, "switchboard")).toBe("true");
  });

  it("6979 · список не на экране или вид без проектов: collapsed не пишется", async () => {
    // источник: факт — первый показ проекта запоминается, только пока его видно
    const store = memoryStore({ key: KEY });
    const relay = relayWith();
    await start({ relay, store, url: "/#card?callsign=note%40pc" });
    relay.setRoster(fleet());
    await flush(5);
    expect(await store.get<Record<string, boolean>>("collapsed")).not.toHaveProperty("switchboard");

    const store2 = memoryStore({ key: KEY, view: { projects: false } });
    await start({ store: store2 });
    expect(await store2.get("collapsed")).toBeUndefined();
  });

  it("7263 · широкий вид: карточка рядом со списком — первый показ запомнен, у телефона — только при возврате к списку", async () => {
    // источник: факт — первый показ проекта запоминается, только пока его видно
    const wide = memoryStore({ key: KEY });
    await start({ store: wide, wide: true, options: { beside: { card: ["board"] } }, url: "/#card?callsign=note%40pc" });
    expect(await wide.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });

    const phone = memoryStore({ key: KEY });
    const t = await start({ store: phone, url: "/#card?callsign=note%40pc" });
    expect(await phone.get<Record<string, boolean>>("collapsed")).not.toHaveProperty("switchboard");
    await t.go("#sessions");
    await flush(5);
    expect(await phone.get("collapsed")).toMatchObject({ switchboard: false, pfarm: true });
  });

  it("6980 · новый проект в roster: развёрнут, если в нём ждут; прежние как оставил человек", async () => {
    // источник: факт — дальше как оставил человек
    const relay = relayWith();
    const t = await start({ relay });
    await t.click(t.$('.pj-t[data-proj="switchboard"]'));
    await t.click(t.$('.pj-t[data-proj="pfarm"]'));
    relay.scoped.global["fleet.projects"] = [...PROJECTS(), { id: "fresh", name: "fresh", sessions: ["fresh@pc"] }];
    relay.drop();
    // запись проектов пришла раньше roster: пока сессий проекта нет, решение о первом показе не принимается (упало в CI 4 нояб.)
    await vi.waitFor(() => expect(expanded(t, "fresh")).not.toBeUndefined());
    const r = fleet();
    r.sessions.push({ callsign: "fresh@pc", state: "waiting", dir: "~/fresh", by: "phone~you@mail" });
    relay.setRoster(r);
    await vi.waitFor(() => expect(expanded(t, "fresh")).toBe("true"));
    expect(expanded(t, "switchboard")).toBe("false");
    expect(expanded(t, "pfarm")).toBe("true");
  });
});

describe("строка и вид", () => {
  const question = { type: "question", from: "migrate@laptop", to: ["phone"], question: "q1", kind: "ask", questions: [{ question: "База?", header: "Б", options: [{ label: "да" }] }] };

  it("6981 · строка сессии с вопросом: телефон — экран вопроса; пульт — карточка", async () => {
    // источник: факт — телефон: сессия с вопросом сразу вопрос; пульт — карточка
    const t = await start();
    t.relay.push(question);
    await flush(3);
    await t.click(t.$('.bd-row[data-callsign="migrate@laptop"]'));
    expect(location.hash).toBe("#ask?callsign=migrate%40laptop");

    const t2 = await start({ wide: true, options: { beside: { card: "board", ask: "board" } } });
    t2.relay.push(question);
    await flush(3);
    await t2.click(t2.$('.bd-row[data-callsign="migrate@laptop"]'));
    expect(location.hash).toBe("#card?callsign=migrate%40laptop");
  });

  it("6982 · сброс вида: вид по умолчанию записан; широкий вид — ещё и шапка карточки по умолчанию", async () => {
    // источник: факт — настройки шапки у карточки, её команда возвращает свои; вне широкого вида группы нет
    const store = memoryStore({ key: KEY, view: { at: false } });
    const t = await start({ store });
    await t.click(t.$(".fc.vw"));
    await t.click(t.$('[data-act="view-reset"]'));
    expect(await store.get("view")).toMatchObject({ at: true });
    expect(t.$("[data-v-head]")).toBeNull();

    const store2 = memoryStore({ key: KEY, "card.head": { haddr: true, howner: false, hprof: true, hmodel: true } });
    const t2 = await start({ store: store2, wide: true, options: { beside: { card: "board" } } });
    await t2.click(t2.$(".fc.vw"));
    await t2.click(t2.$('[data-act="view-reset"]'));
    await flush(3);
    expect(await store2.get("card.head")).toMatchObject({ haddr: false, howner: true });
  });
});
