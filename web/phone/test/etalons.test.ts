// Эталоны телефона и каркаса. Стенд — страница happy-dom, поддельные relay и служба пушей;
// код приложения настоящий (слово пользователя 31 окт.: «да, оба»). Номер эталона — номер теста.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepo } from "@switchboard/manifest-gate";
import { serviceWorker } from "@switchboard/web-alerts";
import { appGate, memoryStore } from "@switchboard/web-core";
import { phoneParts } from "../stand/parts.ts";
import { defined, FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser, fakeScope } from "../../packages/alerts/stand/fakes.ts";

const QUESTION = {
  type: "question",
  from: "profiles@laptop",
  to: ["phone", "panel-desk"],
  question: "toolu_01Hx",
  kind: "ask",
  questions: [
    {
      question: "Какую базу мигрировать первой?",
      header: "База",
      multiSelect: false,
      options: [
        { label: "прод", description: "Боевая база, 2,1 млн строк. Окно — ночью, с 02:00." },
        { label: "стенд", description: "Копия недельной давности. Можно сразу." },
      ],
    },
  ],
};
const pending = { question: QUESTION.question, kind: "ask", questions: QUESTION.questions };

/** relay флота home: лента и вопросы отвечают как Host. */
function homeRelay(roster = homeRoster()) {
  const relay = new FakeRelay(roster);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "profiles@laptop" ? [pending] : [] });
  return relay;
}

const type = async (t: Awaited<ReturnType<typeof stand>>, text: string) => {
  const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
  inp.value = text;
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  await t.click(t.$(".chat-send"));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны телефона", () => {
  it("5139 · модули стенда телефона — те же, что в into телефона", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — единственная запись состава
    const want = loadRepo(join(import.meta.dirname, "../../..")).filter((m) => m.into?.includes("phone") && !["web-core", "web-view", "web-ui"].includes(m.name));
    expect(phoneParts().map((p) => p.manifest.name).sort()).toEqual(want.map((m) => m.name).sort());
    expect(want.length).toBe(13);
  });

  it("5319 · новая сессия на телефоне: имя сверху, машина кнопкой, адрес и папки", async () => {
    const r = homeRoster();
    for (const m of r.machines) m.contract = { ...m.contract, "session.open": 1, "machine.dirs": 1 };
    const relay = homeRelay(r);
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: ["src"] } });
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
    const t = await stand(phoneParts(fakeBrowser()), { relay, url: "/#open" });
    await flush(5);
    // машина — кнопкой над адресом; список машин открывается по ней
    expect(t.$('.op-bl')).toBeNull();
    await t.click(t.$('[data-act="pick-machine"]'));
    await t.click(t.$('.op-bl [data-machine="pc"]'));
    await flush(5);
    expect(t.$(".op-bl")).toBeNull();
    expect(t.$(".op-bk")!.textContent).toBe("@pc");
    expect(t.$$("[data-dir]").map((x) => x.dataset.dir)).toEqual(["src"]);
    expect(t.$<HTMLInputElement>('[data-f="name"]')!.value).toBe("");
  });

  it("4001 · набор телефона проходит гейт ядра и стартует: hello, домашний раздел «Вам»", async () => {
    expect(appGate(defined(phoneParts()))).toEqual([]);
    const relay = homeRelay();
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    expect(t.run.stopped).toBeNull();
    expect(t.run.failed).toEqual({});
    expect(relay.hellos).toHaveLength(2); // hello — на каждую машину флота: laptop и pc
    expect(t.$(".sb-bt b")!.textContent).toBe("Вам");
  });

  it("22 · пуш при закрытом приложении: уведомление с полным текстом, нажатие — переписка из уведомления, ответ — session.prompt", async () => {
    const store = memoryStore({ key: KEY });
    const scope = fakeScope();
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2 });
    const text = "Эталоны: 13 из 13. Катить в основную?";
    await scope.fire("push", { data: { json: () => ({ type: "message", from: "poe-bot@pc", notify: { title: "poe-bot@pc", body: text, tag: "m-91" } }) } });
    expect(scope.shown[0]).toMatchObject({ title: "poe-bot@pc", o: { body: text } });
    await scope.fire("notificationclick", { action: "", notification: { data: scope.shown[0].o.data, close: () => {} } });
    expect(scope.opened).toHaveLength(1);
    // окно открылось: приложение стартует с тем же хранилищем
    const relay = homeRelay();
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    const t = await stand(phoneParts(fakeBrowser("granted")), { relay, store });
    expect(t.$(".sb-bt b")!.textContent).toBe("poe-bot");
    expect(t.$(".chat-in")!.textContent).toContain(text);
    expect(t.$(".chat-tag")!.textContent).toBe("из уведомления");
    await type(t, "Катим");
    expect(relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", text: "Катим" })]);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });

  it("102 · уже ответили с пульта: already_answered — повтора нет; answered убирает вопрос из «Вам» на телефоне", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): «ответ, данный на одном устройстве, сразу пропадает из «Вам»
    // на другом: побеждает первый ответ»
    const relay = homeRelay();
    relay.handlers.answer = () => ({ ok: false, error: "already_answered" });
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    relay.push(QUESTION);
    await flush();
    await t.click(t.$$(".ib-it .ask-opt")[1]);
    await t.click(t.button("Ответить"));
    relay.push({ type: "answered", from: "profiles@laptop", question: "toolu_01Hx", by: "panel-desk", answers: { "Какую базу мигрировать первой?": "прод" } });
    await flush();
    expect(t.$('.ib-it[data-kind="q"]')).toBeNull();
    expect(relay.sent("answer")).toHaveLength(1);
  });

  it("103 · кнопка «стенд» в уведомлении на Android: hello с ключом из хранилища, кадр кнопки, reply ok, close(1000); окно не открывалось", async () => {
    const relay = homeRelay();
    relay.handlers.answer = () => ({ ok: true });
    const store = memoryStore({ key: KEY });
    const scope = fakeScope();
    serviceWorker(scope, { relayUrl: "wss://relay.test", store, maxActions: () => 2, WebSocket: relay.WebSocket as never });
    const frame = (v: string) => ({ type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": v } });
    const notify = { title: "profiles@laptop спрашивает", body: "Какую базу мигрировать первой?", tag: "toolu_01Hx", actions: [{ title: "прод", frame: frame("прод") }, { title: "стенд", frame: frame("стенд") }] };
    await scope.fire("push", { data: { json: () => ({ type: "question", from: "profiles@laptop", notify }) } });
    expect(scope.shown[0].o.actions.map((a: { title: string }) => a.title)).toEqual(["прод", "стенд"]);
    const close = vi.fn();
    await scope.fire("notificationclick", { action: "1", notification: { data: scope.shown[0].o.data, close } });
    await flush();
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(relay.got).toEqual([expect.objectContaining(frame("стенд"))]);
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "done" });
    expect(close).toHaveBeenCalled();
    expect(scope.opened).toEqual([]);
    expect(scope.shown).toHaveLength(1);
  });

  it("107 · уход на домашний экран: ждущий reply дошёл, модули дописали разделы, лента снята, close(1000)", async () => {
    const relay = homeRelay();
    relay.handlers["session.prompt"] = () => undefined;
    const store = memoryStore({ key: KEY });
    const t = await stand(phoneParts(fakeBrowser()), { relay, store, url: "/#sessions" });
    await t.click(t.$('[data-fid="all"]'));
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await type(t, "Задеплой на стенд");
    const draft = t.$<HTMLTextAreaElement>(".chat-inp")!;
    draft.value = "и потом";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    const before = relay.got.length;
    const hiding = t.run.hide();
    await flush();
    expect(relay.socks[0].closedWith).toBeNull();
    relay.reply(relay.sent("session.prompt")[0].id!, { ok: true });
    await hiding;
    expect(relay.got.slice(before).map((f) => f.type)).toEqual(["session.unwatch"]);
    expect(store.data.drafts).toEqual({ "site@laptop": "и потом" });
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    // сессия занята: reply дошёл — сообщение в очереди (эталон 7023)
    expect(t.$(".chat-me small")!.textContent).toBe("в очереди");
  });

  it("158 · у pc нет session.watch: ленту не просим, «pc не отдаёт ленту»; «Катим» — session.prompt, reply ok", async () => {
    const roster = homeRoster();
    roster.machines[1].contract = { ...roster.machines[1].contract };
    delete roster.machines[1].contract!["session.watch"];
    const relay = homeRelay(roster);
    relay.handlers["session.prompt"] = () => ({ ok: true });
    const t = await stand(phoneParts(fakeBrowser()), { relay, url: "/#sessions" });
    await t.click(t.$('[data-fid="all"]'));
    await t.expand();
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    expect(relay.sent("session.watch")).toHaveLength(0);
    expect(t.text()).toContain("pc не отдаёт ленту");
    await type(t, "Катим");
    expect(relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", text: "Катим" })]);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });
});
