// Покрытие плана roster-inbox-done: «готово» снимается переходом, выборка чистая; карточки по видам.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppModule, Manifest } from "@switchboard/web-core";
import type { Roster } from "@switchboard/relay";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createInbox, manifest as inboxM } from "../contract.ts";
import { createInboxStore } from "../src/store.ts";
import { flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = (extra: Array<{ manifest: Manifest; module: AppModule }> = []) => [
  { manifest: inboxM, module: createInbox() },
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
  ...extra,
];

/** Подделка модуля точек: метка fire — сколько машин не на связи; экран точек нужен только как цель кнопки. */
const points = (fire: number) => ({
  manifest: { name: "pult-points", type: "web", version: "1.0.0", provides: { fire: 1, points: 1 }, uses: {} } as Manifest,
  module: { marks: { fire: () => fire }, screens: { points: { nav: "Точки", label: "Точки", view: () => null } } } as AppModule,
});

/** Я — phone~you@mail. site и mine@pc мои; anna@pc чужая. */
function fleet(over: (r: Roster) => void = () => {}): Roster {
  const r = homeRoster();
  r.sessions = [
    { callsign: "site@laptop", state: "busy", dir: "~/Projects/site", by: "phone~you@mail" },
    { callsign: "mine@pc", state: "idle", dir: "~/p", by: "phone~you@mail" },
    { callsign: "anna@pc", state: "busy", dir: "~/p", by: "laptop~anna@mail" },
  ];
  r.clients = ["phone~you@mail", "laptop~anna@mail"];
  over(r);
  return r;
}
const idle = (r: Roster, i = 0) => void (r.sessions[i] = { ...r.sessions[i], state: "idle" });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type T = Awaited<ReturnType<typeof stand>>;
const kinds = (t: T) => t.$$(".ib-it").map((x) => `${x.dataset.kind}:${x.dataset.callsign ?? x.dataset.machine ?? ""}`);
const withRelay = async (o: Parameters<typeof stand>[1] = {}, list = parts()) => {
  const t = await stand(list, o);
  t.relay.handlers["session.watch"] ??= () => ({ ok: true });
  t.relay.handlers["session.unwatch"] ??= () => ({ ok: true });
  t.relay.handlers["session.history"] ??= () => ({ ok: true, result: { messages: [] } });
  t.relay.handlers["question.list"] ??= () => ({ ok: true, result: [] });
  return t;
};

describe("«готово»", () => {
  it("6960 · открыли карточку сессии — «готово» снято переходом и не возвращается", async () => {
    // источник: устав — части пользуются контрактом; чьё: код
    const t = await withRelay({ roster: fleet(), url: "/#inbox" });
    t.relay.setRoster(fleet((r) => idle(r)));
    await flush();
    expect(kinds(t)).toContain("done:site@laptop");
    await t.go("#card?callsign=site%40laptop");
    await t.go("#inbox");
    expect(kinds(t)).not.toContain("done:site@laptop");
  });

  it("6961 · сессию смотрят, когда она закончила — «готово» не появляется", async () => {
    // источник: чьё: код
    const t = await withRelay({ roster: fleet(), url: "/#card?callsign=site%40laptop" });
    t.relay.setRoster(fleet((r) => idle(r)));
    await flush();
    await t.go("#inbox");
    expect(kinds(t)).not.toContain("done:site@laptop");
  });

  it("6962 · чтение карточек и метки не пишет в снимок: уведомлений нет, «готово» снимается только переходом", () => {
    // источник: устав персоны архитектора — выборка чистая
    const store = createInboxStore();
    let cur: { screen: string; params: Record<string, string> } | null = { screen: "inbox", params: {} };
    let r = fleet();
    const changed = vi.fn();
    const app = { roster: () => r, current: () => cur, changed, mark: (n: string, c: string) => (n === "mine" ? c !== "anna@pc" : undefined), wide: false } as unknown as App;
    store.start(app);
    store.onRoster(r);
    r = fleet((x) => idle(x));
    store.onRoster(r);
    const has = () => store.items().some((x) => x.kind === "done" && x.callsign === "site@laptop");
    expect(has()).toBe(true);
    cur = { screen: "card", params: { callsign: "site@laptop" } };
    changed.mockClear();
    expect(has()).toBe(true);
    store.count();
    store.items();
    expect(changed).not.toHaveBeenCalled();
    store.onCurrent(cur);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(has()).toBe(false);
  });

  it("6963 · «Прочитано»: метка «Вам» меньше на одну; новый roster с той же idle карточку не возвращает", async () => {
    // источник: чьё: код
    const t = await withRelay({ roster: fleet(), wide: true, url: "/#inbox" });
    const nav = () => t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent;
    t.relay.setRoster(fleet((r) => idle(r)));
    await flush();
    expect(nav()).toBe("Вам1");
    await t.click(t.button("Прочитано"));
    expect(nav()).toBe("Вам");
    t.relay.setRoster(fleet((r) => idle(r)));
    await flush();
    expect(kinds(t)).not.toContain("done:site@laptop");
  });

  it("6964 · чужая сессия закончила, упала или ждёт лимит — карточек нет", async () => {
    // источник: чьё: код
    const t = await withRelay({ roster: fleet(), url: "/#inbox" });
    t.relay.setRoster(fleet((r) => idle(r, 2)));
    await flush();
    expect(kinds(t)).toEqual([]);
    t.relay.setRoster(fleet((r) => (r.sessions[2] = { ...r.sessions[2], state: "failed", slot: { name: "main", wait: 1_900_000_000 } })));
    await flush();
    expect(kinds(t)).toEqual([]);
  });
});

describe("вопрос и сообщение", () => {
  it("6965 · вопрос и сообщение — у чужой тоже; у одной сессии и то и другое — только вопрос", async () => {
    // источник: устав — AskUserQuestion получают зрители сессии; чьё: код
    const t = await withRelay({ roster: fleet(), url: "/#inbox" });
    const ask = (from: string, id: string) => ({ type: "question", from, to: ["phone"], question: id, kind: "ask", questions: [{ question: `Вопрос ${from}?`, header: "В", options: [{ label: "да" }] }] });
    t.relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "anna@pc" ? [ask("anna@pc", "q1")] : f.callsign === "site@laptop" ? [ask("site@laptop", "q2")] : [] });
    t.relay.push(ask("anna@pc", "q1"));
    t.relay.push({ type: "message", from: "mine@pc", to: "phone", text: "Готов отчёт" });
    t.relay.push(ask("site@laptop", "q2"));
    t.relay.push({ type: "message", from: "site@laptop", to: "phone", text: "И сообщение" });
    await flush();
    expect(kinds(t).sort()).toEqual(["msg:mine@pc", "q:anna@pc", "q:site@laptop"]);
    expect(t.$('[data-kind="msg"]')!.textContent).toContain("Готов отчёт");
  });
});

describe("сбой", () => {
  it("6966 · «Запустить снова» отказал — карточка на месте", async () => {
    // источник: устав — отказ словом; тост закреплён 5231
    const t = await withRelay({ roster: fleet((r) => (r.sessions[1] = { ...r.sessions[1], state: "failed", failed: { host: "причина" } })), url: "/#inbox" });
    t.relay.handlers["session.start"] = () => ({ ok: false, error: "no_slot" });
    await t.click(t.button("Запустить снова"));
    expect(kinds(t)).toEqual(["fail:mine@pc"]);
  });
});

describe("машины", () => {
  const without = (r: Roster, m: string) => {
    r.machines = r.machines.filter((x) => x.machine !== m);
    r.sessions = r.sessions.filter((s) => !s.callsign.endsWith(`@${m}`));
  };

  it("6967 · ушла машина с моими сессиями: «не на связи с ЧЧ:ММ», только мои, «Поднять из точки»", async () => {
    // источник: устав — соединение с объектом машины оборвалось
    const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(1)]));
    t.relay.setRoster(fleet((r) => without(r, "pc")));
    await flush();
    const card = t.$('[data-kind="away"]')!;
    expect(card.textContent).toMatch(/не на связи с \d\d:\d\d/);
    expect(card.querySelector(".ib-tx")!.textContent).toBe("mine@pc");
    expect(card.textContent).toContain("Поднять из точки");
  });

  it("6968 · ушла машина только с чужими сессиями — карточки нет", async () => {
    // источник: чьё: код
    const t = await withRelay({ roster: fleet((r) => (r.sessions = r.sessions.filter((s) => s.callsign !== "mine@pc"))), url: "/#inbox" });
    t.relay.setRoster(fleet((r) => without(r, "pc")));
    await flush();
    expect(kinds(t)).toEqual([]);
  });

  it("6969 · машины ушли до открытия: метка fire 3, при открытом ушла одна — «машин не на связи: 2» и «Поднять из точки»", async () => {
    // источник: факт — ушли раньше, чем открыто приложение, знает модуль точек
    const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(3)]));
    t.relay.setRoster(fleet((r) => without(r, "pc")));
    await flush();
    const fire = t.$('[data-kind="fire"]')!;
    expect(fire.textContent).toContain("машин не на связи: 2");
    expect(fire.textContent).toContain("Поднять из точки");
  });

  it("6970 · всё разобрано: «Всё разобрано», метка «Вам» без числа", async () => {
    // источник: чьё: код
    const t = await withRelay({ roster: fleet(), wide: true, url: "/#inbox" });
    expect(t.text()).toContain("Всё разобрано");
    expect(t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent).toBe("Вам");
  });
});
