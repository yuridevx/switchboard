// Флоу web-ask по плану цикла тестов (web): вопрос из уведомления, ответы других устройств, ждущие у Host, экран вопроса.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { memoryStore } from "@switchboard/web-core";
import { createAsk, manifest as askM } from "../contract.ts";
import { PULT, pultParts } from "@switchboard/pult";
import { fakeBrowser } from "../../alerts/stand/fakes.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard },
  { manifest: cardM, module: createCard },
  { manifest: chatM, module: createChat },
  { manifest: askM, module: createAsk },
  { manifest: alertsM, module: createAlerts({}) },
];

const Q1 = { question: "База?", header: "База", multiSelect: false, options: [{ label: "прод" }, { label: "стенд" }] };
const pending = (id = "q1", q = Q1) => ({ question: id, kind: "ask", questions: [q] });
const question = (from: string, id = "q1", q = Q1) => ({ type: "question", from, to: ["phone", "panel-desk"], ...pending(id, q) });

/** relay: question.list по позывному — из списка list. */
function relayWith(list: Record<string, unknown[]> = {}, roster = homeRoster()) {
  const relay = new FakeRelay(roster);
  relay.handlers["question.list"] = (f) => ({ ok: true, result: list[String(f.callsign)] ?? [] });
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  return relay;
}

const row = (t: Awaited<ReturnType<typeof stand>>, cs: string) => t.$(`[data-callsign="${cs}"]`)!;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("кадр question", () => {
  it("4050 · вопрос из уведомления без тела — question.list после hello, вопрос в строке", async () => {
    const relay = relayWith({ "poe-bot@pc": [pending()] });
    const store = memoryStore({ key: KEY, pushes: [{ id: "p1", type: "question", from: "poe-bot@pc", notify: { title: "poe-bot@pc спрашивает", body: "База?" }, at: 1 }] });
    const t = await stand(parts(), { relay, store });
    const lists = relay.got.filter((f) => f.type === "question.list" && f.callsign === "poe-bot@pc");
    expect(lists).toHaveLength(1);
    expect(relay.got.indexOf(lists[0])).toBeGreaterThanOrEqual(0);
    // hello — на каждую машину флота: laptop и pc
    expect(relay.hellos).toHaveLength(2);
    await t.expand();
    expect(row(t, "poe-bot@pc").textContent).toContain("База?");
    expect(row(t, "poe-bot@pc").querySelector(".sb-badge")!.textContent).toBe("?");
  });

  it("4051 · нажатый пуш вопроса — открыт экран вопроса отправителя", async () => {
    const relay = relayWith({ "poe-bot@pc": [pending()] });
    const store = memoryStore({ key: KEY, pushes: [{ id: "p1", type: "question", from: "poe-bot@pc", notify: { body: "База?" }, at: 1, clicked: true }] });
    const t = await stand(parts(), { relay, store });
    await flush();
    expect(location.hash).toBe("#ask?callsign=poe-bot%40pc");
    expect(t.$(".ask-qt")!.textContent).toBe("База?");
  });
});

describe("кадр answered", () => {
  it("4052 · свой ответ подтверждён кадром answered — «Ответ принят», шапка «ответ принят», метка снята", async () => {
    const relay = relayWith({ "profiles@laptop": [pending()] });
    relay.handlers.answer = () => undefined;
    const t = await stand(parts(), { relay });
    await t.click(row(t, "profiles@laptop"));
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    relay.push({ type: "answered", from: "profiles@laptop", question: "q1", by: "phone", answers: { "База?": "стенд" } });
    await flush();
    expect(t.text()).toContain("Ответ «стенд» принят.");
    expect(t.$(".sb-pill")!.textContent).toBe("ответ принят");
    t.button("‹")!.click();
    await flush();
    expect(row(t, "profiles@laptop").querySelector(".sb-badge")).toBeNull();
  });

  it("4053 · ответили кнопкой уведомления этого устройства — «Уже ответили с phone», answer со страницы нет", async () => {
    const relay = relayWith({ "profiles@laptop": [pending()] });
    const t = await stand(parts(), { relay });
    await t.click(row(t, "profiles@laptop"));
    relay.push({ type: "answered", from: "profiles@laptop", question: "q1", by: "phone", answers: { "База?": "стенд" } });
    await flush();
    expect(t.text()).toContain("Уже ответили с phone: «стенд».");
    expect(t.$$<HTMLButtonElement>(".ask-opt").every((b) => b.disabled)).toBe(true);
    expect(relay.sent("answer")).toHaveLength(0);
  });
});

describe("ждущие вопросы у Host", () => {
  it("4054 · телефон: сессия ждёт — question.list один раз на два одинаковых roster", async () => {
    const relay = relayWith({ "profiles@laptop": [pending()] });
    await stand(parts(), { relay });
    relay.setRoster(homeRoster());
    await flush();
    expect(relay.sent("question.list").filter((f) => f.callsign === "profiles@laptop")).toHaveLength(1);
  });

  it("4055 · пульт: сессия ждёт — question.list один раз на два одинаковых roster, вопрос в строке сразу после загрузки", async () => {
    // источник: живой обход 3 нояб., пользователь: «закрывай хвосты»: у пульта после перезагрузки ждущей сессии не было ни в «Вам», ни с вопросом в строке
    const relay = relayWith({ "profiles@laptop": [pending()] });
    const t = await stand(parts(), { relay, wide: true });
    relay.setRoster(homeRoster());
    await flush(5);
    expect(relay.sent("question.list").filter((f) => f.callsign === "profiles@laptop")).toHaveLength(1);
    await t.expand();
    expect(row(t, "profiles@laptop").textContent).toContain("База?");
  });

  it("4056 · ответили, пока приложения не было — Host вопроса не знает, вопрос исчез", async () => {
    const relay = relayWith({});
    const t = await stand(parts(), { relay });
    relay.push(question("site@laptop"));
    await flush();
    expect(row(t, "site@laptop").textContent).toContain("База?");
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("question.list").some((f) => f.callsign === "site@laptop")).toBe(true);
    expect(row(t, "site@laptop").textContent).not.toContain("База?");
  });

  it("4057 · question.list отказал — вопрос не показан, на следующем roster снова question.list", async () => {
    const relay = relayWith();
    relay.handlers["question.list"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(), { relay });
    expect(relay.sent("question.list")).toHaveLength(1);
    expect(t.run.failed).toEqual({});
    relay.handlers["question.list"] = () => ({ ok: true, result: [pending()] });
    relay.setRoster(homeRoster());
    await flush();
    expect(relay.sent("question.list")).toHaveLength(2);
    expect(row(t, "profiles@laptop").textContent).toContain("База?");
  });

  it("4058 · после переподключения ждущие перечитаны: вопрос, на который ответили в разрыв, исчез", async () => {
    const relay = relayWith({ "profiles@laptop": [pending()] });
    const t = await stand(parts(), { relay });
    expect(row(t, "profiles@laptop").textContent).toContain("База?");
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    // hello — на каждую машину флота, до разрыва и после: laptop и pc дважды
    expect(relay.hellos).toHaveLength(4);
    expect(relay.sent("question.list").filter((f) => f.callsign === "profiles@laptop").length).toBeGreaterThanOrEqual(2);
    expect(row(t, "profiles@laptop").textContent).not.toContain("База?");
  });

  it("4059 · вопрос задан во время разрыва — после hello телефон берёт его у Host", async () => {
    const r = homeRoster();
    r.sessions = r.sessions.map((s) => ({ ...s, state: s.state === "waiting" ? "idle" : s.state }));
    const relay = relayWith({}, r);
    const t = await stand(parts(), { relay });
    expect(relay.sent("question.list")).toHaveLength(0);
    relay.drop();
    const r2 = homeRoster();
    r2.sessions = r2.sessions.map((s) => (s.callsign === "site@laptop" ? { ...s, state: "waiting" } : { ...s, state: s.state === "waiting" ? "idle" : s.state }));
    relay.roster = r2;
    relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "site@laptop" ? [pending("q2")] : [] });
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("question.list")).toEqual([expect.objectContaining({ callsign: "site@laptop" })]);
    await t.expand();
    expect(row(t, "site@laptop").querySelector(".sb-badge")!.textContent).toBe("?");
  });
});

describe("экран вопроса", () => {
  it("4060 · вопроса больше нет — unknown_question: «Вопроса больше нет»", async () => {
    const relay = relayWith({ "profiles@laptop": [pending()] });
    relay.handlers.answer = () => ({ ok: false, error: "unknown_question" });
    const t = await stand(parts(), { relay });
    await t.click(row(t, "profiles@laptop"));
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.button("Ответить"));
    expect(t.text()).toContain("Вопроса больше нет.");
    expect(t.text()).toContain("profiles@laptop его не ждёт: unknown_question.");
  });

  it("4061 · ждущих вопросов нет — пока грузится «Загружаю вопросы…», потом «нет ждущих вопросов»", async () => {
    const relay = relayWith({});
    relay.handlers["question.list"] = () => undefined;
    const t = await stand(parts(), { relay });
    history.pushState(null, "", "/#ask?callsign=poe-bot%40pc");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(t.text()).toContain("Загружаю вопросы…");
    const q = relay.sent("question.list").find((f) => f.callsign === "poe-bot@pc")!;
    relay.reply(q.id!, { ok: true, result: [] });
    await flush();
    expect(t.text()).toContain("У poe-bot@pc нет ждущих вопросов.");
    expect(t.button("Ответить")).toBeNull();
  });

  it("4062 · question.list отказал при открытии — отказ виден словом, а не «нет ждущих вопросов»", async () => {
    const relay = relayWith({});
    relay.handlers["question.list"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(), { relay });
    history.pushState(null, "", "/#ask?callsign=site%40laptop");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(t.root.textContent).toContain("offline");
    expect(t.text()).not.toContain("нет ждущих вопросов");
    expect(t.run.failed).toEqual({});
  });

  it("4063 · пульт: следующий вопрос сессии при открытом чате — над вводом новый вопрос", async () => {
    const r = homeRoster();
    r.sessions = r.sessions.map((s) => (s.callsign === "poe-bot@pc" ? { ...s, state: "waiting" } : s));
    const relay = relayWith({ "poe-bot@pc": [pending()] }, r);
    relay.handlers.answer = () => ({ ok: true });
    const t = await stand(parts(), { relay, wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } });
    history.pushState(null, "", "/#chat?callsign=poe-bot%40pc");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    const ask = () => t.$(".chat-ask")!;
    await t.click([...ask().querySelectorAll<HTMLButtonElement>(".ask-opt")][1]);
    await t.click([...ask().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Ответить")!);
    expect(ask().textContent).toContain("Ответ «стенд» принят.");
    relay.handlers["question.list"] = () => ({ ok: true, result: [pending("q2", { question: "Деплоить?", header: "", multiSelect: false, options: [{ label: "да" }, { label: "нет" }] })] });
    relay.push(question("poe-bot@pc", "q2", { question: "Деплоить?", header: "", multiSelect: false, options: [{ label: "да" }, { label: "нет" }] }));
    await flush();
    expect(ask().querySelector(".ask-qt")!.textContent).toBe("Деплоить?");
    expect([...ask().querySelectorAll("button")].some((b) => b.textContent === "Ответить")).toBe(true);
  });
});

describe("вопрос в двух местах пульта", () => {
  it("6900 · карточка «Вам» и док чата рядом: ответ в доке — карточка уходит, в доке остаётся «Ответ принят»", async () => {
    // источник: найдено слепым архитектором 4 нояб.: уход карточки стирал показанный вопрос у дока
    const relay = relayWith({ "poe-bot@pc": [pending()] });
    relay.handlers.answer = () => ({ ok: true });
    const t = await stand(pultParts(fakeBrowser("granted")), { relay, wide: true, options: PULT, url: "/#inbox" });
    relay.push(question("poe-bot@pc"));
    await flush();
    await t.go(`#chat?callsign=${encodeURIComponent("poe-bot@pc")}`);
    expect(t.$(".ib-q")?.textContent).toContain("База?");
    const dock = () => t.$(".chat-ask")!;
    expect(dock().textContent).toContain("База?");
    await t.click([...dock().querySelectorAll<HTMLElement>(".ask-opt")].find((b) => b.textContent?.startsWith("стенд"))!);
    await t.click([...dock().querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Ответить")!);
    await flush();
    expect(t.$(".ib-q")).toBeNull();
    expect(dock().textContent).toContain("Ответ «стенд» принят.");
    expect(dock().textContent).not.toContain("нет ждущих вопросов");
  });
});
