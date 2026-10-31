// Эталоны телефона и каркаса. Стенд — страница happy-dom, поддельные relay и служба пушей;
// код приложения настоящий (слово пользователя 31 окт.: «да, оба»). Номер эталона — номер теста.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceWorker } from "@switchboard/web-alerts";
import { memoryStore, type AppPart } from "@switchboard/web-core";
import { phoneParts } from "../contract.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../packages/core/stand/app.ts";
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
  inp.dispatchEvent(new Event("input"));
  await t.click(t.$(".chat-send"));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны телефона", () => {
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
    expect(t.$(".sb-bt b")!.textContent).toBe("poe-bot@pc");
    expect(t.$(".chat-in")!.textContent).toContain(text);
    expect(t.$(".chat-tag")!.textContent).toBe("из уведомления");
    await type(t, "Катим");
    expect(relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", text: "Катим" })]);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });

  it("100 · адрес с ключом после #: ключ — в хранилище, из адреса убран; hello с ключом; roster — «Флот»; на сервер ключ не уходит", async () => {
    const store = memoryStore();
    const relay = homeRelay();
    const t = await stand(phoneParts(fakeBrowser()), { url: "/#" + KEY, store, relay });
    expect(store.data.key).toBe(KEY);
    expect(location.href).not.toContain(KEY);
    expect(relay.hellos).toEqual([{ type: "hello", key: KEY, proto: 1 }]);
    expect(relay.socks.every((s) => !s.url.includes("k2a9"))).toBe(true);
    expect(t.$(".sb-bt b")!.textContent).toBe("Флот");
    expect(t.$(".sb-pill")!.textContent).toBe("на связи");
  });

  it("101 · вопрос: чип «База», варианты с описаниями и «Свой ответ»; «стенд» → answer; reply ok → «Ответ принят»", async () => {
    const relay = homeRelay();
    relay.handlers.answer = () => ({ ok: true });
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    relay.push(QUESTION);
    await flush();
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    expect(t.$(".ask-chip")!.textContent).toBe("База");
    expect(t.$$(".ask-opt").map((o) => o.textContent)).toEqual([
      "продБоевая база, 2,1 млн строк. Окно — ночью, с 02:00.",
      "стендКопия недельной давности. Можно сразу.",
      "Свой ответНаписать сессии текстом",
    ]);
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    expect(relay.sent("answer")).toEqual([
      expect.objectContaining({ type: "answer", callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": "стенд" } }),
    ]);
    expect(t.text()).toContain("Ответ «стенд» принят.");
  });

  it("102 · уже ответили с пульта: already_answered — «Уже ответили с panel-desk: прод», варианты недоступны, повтора нет", async () => {
    const relay = homeRelay();
    relay.handlers.answer = () => ({ ok: false, error: "already_answered" });
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    relay.push(QUESTION);
    await flush();
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    relay.push({ type: "answered", from: "profiles@laptop", question: "toolu_01Hx", by: "panel-desk", answers: { "Какую базу мигрировать первой?": "прод" } });
    await flush();
    expect(t.text()).toContain("Уже ответили с panel-desk: «прод».");
    expect(t.$$<HTMLButtonElement>(".ask-opt").every((b) => b.disabled)).toBe(true);
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

  it("104 · обрыв, пока сообщение ждёт reply: disconnected сразу, «не подтверждено», без переотправки; после hello — снова watch и history", async () => {
    const relay = homeRelay();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await stand(phoneParts(fakeBrowser()), { relay, pauseMs: 150 });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await type(t, "Задеплой на стенд");
    relay.drop();
    await flush();
    expect(t.$(".chat-me.pend")!.textContent).toBe("Задеплой на стендсвязь оборвалась до ответа — не подтверждено · отправить ещё раз");
    expect(t.$(".sb-off")!.hidden).toBe(false);
    expect(t.$(".sb-pill")!.textContent).toBe("нет связи");
    // сообщение дошло до сессии до обрыва: после hello история покажет его uuid
    const id = relay.sent("session.prompt")[0].uuid;
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [{ type: "user", uuid: id, message: { content: "Задеплой на стенд" } }] } });
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(relay.hellos).toHaveLength(2);
    expect(relay.sent("session.prompt")).toHaveLength(1);
    expect(relay.sent("session.watch")).toHaveLength(2);
    expect(relay.sent("session.history")).toHaveLength(2);
    expect(t.$(".chat-me.pend")).toBeNull();
    expect(t.$$(".chat-me")).toHaveLength(1);
  });

  it("105 · iPhone, Safari: экран «Добавьте на экран „Домой“», ключ в адресе, разрешение не спрашивается; с экрана «Домой» — ключ из адреса и «Включить уведомления»", async () => {
    const br = fakeBrowser();
    const store = memoryStore();
    const relay = homeRelay();
    const t = await stand(phoneParts(br), { url: "/#" + KEY, ios: true, store, relay });
    expect(t.text()).toContain("Добавьте Switchboard на экран «Домой»");
    expect(t.$$(".sb-ol li").map((li) => li.textContent)).toEqual(["Нажмите «Поделиться» внизу", "«На экран „Домой“»", "Откройте Switchboard с экрана «Домой»"]);
    expect(location.hash).toBe("#" + KEY);
    expect(br.calls).not.toContain("requestPermission");
    expect(relay.socks).toHaveLength(0);
    const home = await stand(phoneParts(br), { url: "/#" + KEY, ios: true, standalone: true, store, relay });
    expect(store.data.key).toBe(KEY);
    expect(location.hash).toBe("");
    expect(home.$(".al-card b")!.textContent).toBe("Включить уведомления");
    expect(br.calls).not.toContain("requestPermission");
  });

  it("106 · revoked — «Ключ отозван» с командой нового QR; contract_mismatch — «Приложение устарело» с «Перезагрузить»; повторных hello нет", async () => {
    const r1 = homeRelay();
    r1.refuse = ["revoked"];
    const t = await stand(phoneParts(fakeBrowser()), { relay: r1 });
    await flush(10);
    expect(t.text()).toContain("Ключ отозван");
    expect(t.text()).toContain("client.phone.k2a9 больше не принимают");
    expect(t.text()).toContain("switchboard invite client phone --qr");
    expect(r1.hellos).toHaveLength(1);
    const r2 = homeRelay();
    r2.refuse = ["contract_mismatch"];
    const t2 = await stand(phoneParts(fakeBrowser()), { relay: r2 });
    await flush(10);
    expect(t2.text()).toContain("Приложение устарело");
    expect(t2.text()).toContain("У приложения proto 1");
    expect(t2.button("Перезагрузить")).not.toBeNull();
    expect(r2.hellos).toHaveLength(1);
  });

  it("107 · уход на домашний экран: ждущий reply дошёл, модули дописали разделы, лента снята, close(1000)", async () => {
    const relay = homeRelay();
    relay.handlers["session.prompt"] = () => undefined;
    const store = memoryStore({ key: KEY });
    const t = await stand(phoneParts(fakeBrowser()), { relay, store });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await type(t, "Задеплой на стенд");
    const draft = t.$<HTMLTextAreaElement>(".chat-inp")!;
    draft.value = "и потом";
    draft.dispatchEvent(new Event("input"));
    const before = relay.got.length;
    const hiding = t.run.hide();
    await flush();
    expect(relay.socks[0].closedWith).toBeNull();
    relay.reply(relay.sent("session.prompt")[0].id!, { ok: true });
    await hiding;
    expect(relay.got.slice(before).map((f) => f.type)).toEqual(["session.unwatch"]);
    expect(store.data.drafts).toEqual({ "site@laptop": "и потом" });
    expect(relay.socks[0].closedWith).toEqual({ code: 1000, reason: "hidden" });
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });

  it("108 · два модуля объявили кадр question — приложение не стартует, связи нет", async () => {
    const parts: AppPart[] = [
      ...phoneParts(fakeBrowser()),
      { manifest: { name: "dupe", type: "web", version: "1.0.0", provides: {}, uses: { "question@host-questions": 1 } }, module: { frames: { question: () => {} } } },
    ];
    const relay = homeRelay();
    const t = await stand(parts, { relay });
    expect(t.text()).toContain("Приложение не стартует");
    expect(t.text()).toContain("имя question: два владельца — web-ask и dupe");
    expect(relay.socks).toHaveLength(0);
  });

  it("109 · chat бросил ошибку на session.events — «Лента выключена» с причиной; флот и вопросы работают", async () => {
    const relay = homeRelay();
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    relay.push({ type: "session.events", from: "site@laptop", seq: 1, events: [null] });
    await flush();
    expect(t.text()).toContain("Лента выключена");
    expect(t.text()).toMatch(/Модуль web-chat упал на кадре session\.events: TypeError/);
    expect(t.button("Перезапустить приложение")).not.toBeNull();
    expect(t.$(".sb-bt b")!.textContent).toBe("site@laptop");
    await t.click(t.button("‹"));
    relay.push(QUESTION);
    relay.setRoster(homeRoster());
    await flush();
    expect(t.$('[data-callsign="profiles@laptop"]')!.textContent).toContain("Какую базу мигрировать первой?");
    expect(t.run.failed).toEqual({ "web-chat": expect.stringContaining("session.events") });
  });

  it("156 · «Включить уведомления»: push.key и push.subscribe — только Worker push; машинам ни кадра, в хранилище подписки нет", async () => {
    const br = fakeBrowser();
    const relay = homeRelay();
    relay.handlers["push.key"] = () => ({ ok: true, result: { key: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9" } });
    relay.handlers["push.subscribe"] = () => ({ ok: true });
    const store = memoryStore({ key: KEY });
    const t = await stand(phoneParts(br), { relay, store });
    await t.click(t.button("Включить"));
    const r = homeRoster();
    r.machines.push({ machine: "mac", since: 2, proto: 1, contract: r.machines[0].contract });
    relay.setRoster(r);
    await flush();
    expect(relay.got.filter((f) => f.to === "push").map((f) => f.type)).toEqual(["push.key", "push.subscribe"]);
    const toMachines = relay.got.filter((f) => f.to !== "push");
    expect(toMachines.every((f) => !f.type.startsWith("push") && !("sub" in f))).toBe(true);
    expect(JSON.stringify(store.data)).not.toContain("endpoint");
    expect(t.$(".al-card")).toBeNull();
  });

  it("157 · gate_unavailable — не стоп: «Нет связи», пауза, второй hello принят — «Флот»", async () => {
    const relay = homeRelay();
    relay.refuse = ["gate_unavailable"];
    const t = await stand(phoneParts(fakeBrowser()), { relay, pauseMs: 40 });
    expect(t.run.stopped).toBeNull();
    expect(t.$(".sb-off")!.hidden).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    expect(relay.hellos).toHaveLength(2);
    expect(t.$(".sb-bt b")!.textContent).toBe("Флот");
    expect(t.$(".sb-off")!.hidden).toBe(true);
  });

  it("158 · у pc нет session.watch: ленту не просим, «pc не отдаёт ленту»; «Катим» — session.prompt, reply ok", async () => {
    const roster = homeRoster();
    roster.machines[1].contract = { ...roster.machines[1].contract };
    delete roster.machines[1].contract!["session.watch"];
    const relay = homeRelay(roster);
    relay.handlers["session.prompt"] = () => ({ ok: true });
    const t = await stand(phoneParts(fakeBrowser()), { relay });
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    expect(relay.sent("session.watch")).toHaveLength(0);
    expect(t.text()).toContain("pc не отдаёт ленту");
    await type(t, "Катим");
    expect(relay.sent("session.prompt")).toEqual([expect.objectContaining({ callsign: "poe-bot@pc", text: "Катим" })]);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
  });
});
