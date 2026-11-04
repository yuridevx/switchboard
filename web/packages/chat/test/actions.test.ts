// Флоу экрана чата на стенде: лента, ввод, вложения, подсказки, методы сессии, откат, вид, переписка.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "@switchboard/web-core";
import { flush, KEY } from "../../core/stand/app.ts";
import { createChatStore } from "../src/state/chat.ts";
import { asst, chat, parts, relayFor, roster, user } from "./stand.ts";
import { stand } from "../../core/stand/app.ts";

const CS = "site@laptop"; // в стенде busy
const IDLE = "poe-bot@pc";
const tool = (uuid: string, id: string, name = "Bash", input: unknown = { command: "x" }) => asst(uuid, [{ type: "tool_use", id, name, input }]);
const bgStart = (id: string, tu?: string, description = "сборка") => ({ type: "system", subtype: "task_started", uuid: `k-${id}`, task_id: id, tool_use_id: tu, description, is_backgrounded: true });
const file = (name: string, type = "text/plain", body = "x") => new File([body], name, { type });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("request-session-history", () => {
  it("6653 · разрыв seq", async () => {
    const t = await chat(IDLE);
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "раз" }])], 40);
    expect(t.relay.sent("session.history")).toHaveLength(1);
    await t.events(IDLE, [asst("a2", [{ type: "text", text: "два" }])], 42);
    expect(t.relay.sent("session.history")).toHaveLength(2);
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["раз", "два"]);
    // Host перезапущен: нумерация с начала — та же ветка, подписка не повторяется
    await t.events(IDLE, [], 1);
    expect(t.relay.sent("session.history")).toHaveLength(3);
    expect(t.relay.sent("session.watch")).toHaveLength(1);
  });

  it("6654 · первая пачка после подписки", async () => {
    const t = await chat(IDLE);
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "раз" }])], 40);
    expect(t.$(".chat-txt")!.textContent).toBe("раз");
    expect(t.relay.sent("session.history")).toHaveLength(1);
  });

  it("6655 · раньше", async () => {
    const relay = relayFor();
    relay.handlers["session.history"] = (f) => (f.before ? { ok: true, result: { messages: [user("u1", "раньше")], more: false } } : { ok: true, result: { messages: [user("u2", "потом")], more: true } });
    const t = await chat(IDLE, { relay });
    await t.click(t.$(".chat-older"));
    expect(relay.sent("session.history").at(-1)).toMatchObject({ before: "u2" });
    expect(t.$$(".chat-me").map((x) => x.textContent)).toEqual([expect.stringContaining("раньше"), expect.stringContaining("потом")]);
    expect(t.$(".chat-older")).toBeNull();
  });

  it("6656 · раньше отказал", async () => {
    const relay = relayFor();
    relay.handlers["session.history"] = (f) => (f.before ? { ok: false, error: "offline" } : { ok: true, result: { messages: [user("u2", "потом")], more: true } });
    const t = await chat(IDLE, { relay });
    await t.click(t.$(".chat-older"));
    expect(t.$(".sb-toast")!.textContent).toBe(`${IDLE}: session.history — offline`);
    expect(t.$(".chat-older")).not.toBeNull();
    expect(t.$(".chat-me")).not.toBeNull();
  });

  it("6657 · машина вернулась, пока другая держала связь", async () => {
    const t = await chat(IDLE);
    expect(t.relay.sent("session.watch")).toHaveLength(1);
    // Host поднялся заново: тот же адрес, новый since
    const back = roster();
    back.machines[1].since = 2;
    t.relay.setRoster(back);
    await flush();
    expect(t.relay.sent("session.watch")).toHaveLength(2);
    expect(t.relay.got.filter((f) => f.type === "session.watch" || f.type === "session.history").slice(-2).map((f) => f.type)).toEqual(["session.watch", "session.history"]);
    // тот же roster подписку не повторяет
    t.relay.setRoster(back);
    await flush();
    expect(t.relay.sent("session.watch")).toHaveLength(2);
  });

  it("6658 · машины нет в roster при открытии", async () => {
    const relay = relayFor();
    const t = await stand(parts(), { relay });
    const noPc = roster();
    noPc.machines = noPc.machines.filter((m) => m.machine !== "pc");
    noPc.sessions = noPc.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    relay.setRoster(noPc);
    await flush();
    history.pushState(null, "", `/#chat?callsign=${encodeURIComponent(IDLE)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(relay.sent("session.watch").filter((f) => f.callsign === IDLE)).toHaveLength(0);
    relay.setRoster(roster());
    await flush();
    expect(relay.sent("session.watch").filter((f) => f.callsign === IDLE)).toHaveLength(1);
    expect(relay.sent("session.history").filter((f) => f.callsign === IDLE)).toHaveLength(1);
    expect(t.$(".chat-feed")).not.toBeNull();
  });

  it("6659 · нет истории в contract", async () => {
    const r = roster((x) => {
      for (const m of x.machines) delete (m.contract as Record<string, number>)["session.history"];
    });
    const t = await chat(IDLE, { relay: relayFor(r) });
    expect(t.relay.sent("session.watch")).toHaveLength(1);
    expect(t.relay.sent("session.history")).toHaveLength(0);
    expect(t.$('.chat-note[role="alert"]')).toBeNull();
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "живое" }])], 1);
    expect(t.$(".chat-txt")!.textContent).toBe("живое");
  });

  it("6660 · отказ снят после связи", async () => {
    const relay = relayFor();
    relay.handlers["session.watch"] = () => ({ ok: false, error: "stopped" });
    const t = await chat(IDLE, { relay });
    expect(t.$('.chat-note[role="alert"]')!.textContent).toBe("session.watch: stopped");
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(t.$('.chat-note[role="alert"]')).toBeNull();
  });

  it("6661 · два экрана одного разговора и штатная остановка", async () => {
    const got: string[] = [];
    const saved: unknown[] = [];
    const ask = async (name: string, body: { callsign?: string }) => (got.push(`${name} ${body.callsign}`), { ok: true, result: { messages: [] } });
    const app = {
      request: ask,
      read: ask,
      can: () => true,
      roster: () => ({ machines: [], sessions: [] }),
      changed() {},
      toast() {},
      mark: () => undefined,
      use: <T,>(s: () => T) => s(),
      store: () => ({ get: async () => undefined, set: async (v: unknown) => void saved.push(v) }),
    };
    const store = createChatStore(app as never);
    await store.start();
    const close1 = store.mount(CS);
    const close2 = store.mount(CS);
    store.mount(IDLE);
    store.setDraft(IDLE, "черновик");
    await flush();
    close1();
    await flush();
    expect(got.filter((x) => x.startsWith("session.unwatch"))).toEqual([]);
    close2();
    await flush();
    expect(got.filter((x) => x.startsWith("session.unwatch"))).toEqual([`session.unwatch ${CS}`]);
    await store.stop();
    expect(got.filter((x) => x.startsWith("session.unwatch"))).toEqual([`session.unwatch ${CS}`, `session.unwatch ${IDLE}`]);
    expect(saved.at(-1)).toEqual({ [IDLE]: "черновик" });
  });
});

describe("action-chat-send", () => {
  it("6662 · несколько строк кнопкой", async () => {
    const t = await chat(IDLE);
    await t.type("раз\nдва");
    await t.key("Enter", { shiftKey: true });
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")[0]).toMatchObject({ text: "раз\nдва" });
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
  });

  it("6663 · эхо раньше ответа", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    const p = relay.sent("session.prompt")[0];
    await t.events(IDLE, [user(String(p.uuid), "Катим")], 1);
    expect(t.$(".chat-me small")!.textContent).toMatch(/✓✓$/);
    relay.reply(String(p.id), { ok: true, result: { uuid: p.uuid } });
    await flush();
    expect(t.$(".chat-me small")!.textContent).toMatch(/✓✓$/);
  });

  it("6664 · отправка без связи", async () => {
    const t = await chat(IDLE);
    t.relay.refuse.push(...Array<string>(40).fill("gate_unavailable"));
    t.relay.drop();
    await flush(1);
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".chat-me.pend")).not.toBeNull();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
  });

  it("6665 · повтор получил отказ", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "disconnected" });
    const t = await chat(IDLE, { relay });
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me.pend")).not.toBeNull();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "stopped" });
    await t.click(t.btn(".chat-me", "отправить ещё раз"));
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Катим");
    expect(t.$(".sb-toast")!.textContent).toBe(`${IDLE}: не доставлено — сессия остановлена. Черновик цел.`);
  });

  it("6666 · нет ответа за предел", async () => {
    // решение главной сессии 4 нояб.: timeout — не отказ: сообщение могло дойти, поэтому пузырь «не подтверждено», как при обрыве
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "timeout" });
    const t = await chat(IDLE, { relay });
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me.pend")).not.toBeNull();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
    expect(t.$(".sb-toast")!.hidden).toBe(true);
  });

  it("6667 · отправить ещё раз — с вложениями", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "disconnected" });
    const t = await chat(IDLE, { relay });
    await t.pick(file("a.txt"));
    await t.type("Смотри");
    await t.click(t.$(".chat-send"));
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    await t.click(t.btn(".chat-me", "отправить ещё раз"));
    const [first, again] = relay.sent("session.prompt");
    expect(again.uuid).toBe(first.uuid);
    expect(again).toMatchObject({ text: "Смотри", attachments: [{ name: "a.txt", media_type: "text/plain" }] });
  });

  it("6668 · отказ, пока человек печатает", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await chat(IDLE, { relay });
    await t.pick(file("a.txt"));
    await t.type("первое");
    await t.click(t.$(".chat-send"));
    await t.type("новое");
    const p = relay.sent("session.prompt")[0];
    relay.reply(String(p.id), { ok: false, error: "offline" });
    await flush();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("новое");
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.txt"]);
    const toast = t.$(".sb-toast")!.textContent;
    expect(toast).toContain("не доставлено — pc не на связи");
    expect(toast).not.toContain("Черновик цел");
    expect(toast).toContain("текст не возвращён");
  });

  it("6669 · отказ при закрытом чате", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await chat(IDLE, { relay });
    await t.pick(file("a.txt"));
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    await t.click(t.button("‹"));
    const p = relay.sent("session.prompt")[0];
    relay.reply(String(p.id), { ok: false, error: "offline" });
    await flush();
    expect(document.querySelector(".sb-toast")!.textContent).toContain("Черновик цел, вложения не сохранены");
    history.pushState(null, "", `/#chat?callsign=${encodeURIComponent(IDLE)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Катим");
    expect(t.$(".chat-me")).toBeNull();
  });

  it("6670 · черновик переживает перезапуск страницы", async () => {
    const store = memoryStore({ key: KEY });
    const t = await chat(IDLE, { store });
    await t.type("недописанное");
    await t.run.hide();
    expect(store.data.drafts).toEqual({ [IDLE]: "недописанное" });
    const again = await chat(IDLE, { store });
    expect(again.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("недописанное");
  });
});

describe("action-chat-attach", () => {
  it("6671 · вложить и отправить", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.pick(file("a.txt"), file("b.txt"), file("c.png", "image/png"));
    expect(t.$(".chat-file img")).not.toBeNull();
    await t.click(t.$('[aria-label="убрать b.txt"]'));
    await t.type("смотри");
    await t.click(t.$(".chat-send"));
    expect((t.relay.sent("session.prompt")[0].attachments as Array<{ name: string }>).map((a) => a.name)).toEqual(["a.txt", "c.png"]);
    expect(t.$(".chat-me img")).not.toBeNull();
    expect(t.$(".chat-att")!.textContent).toBe("a.txt");
    expect(t.$(".chat-file")).toBeNull();
  });

  it("6672 · вставка и перетаскивание", async () => {
    const t = await chat(IDLE);
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file("p.png", "image/png")] } });
    inp.dispatchEvent(paste);
    await flush(10);
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["p.png"]);
    expect(inp.value).toBe("");
    const comp = t.$(".chat-comp")!;
    const drag = (type: string, extra: object) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: extra });
      comp.dispatchEvent(e);
    };
    drag("dragover", { types: ["Files"], files: [] });
    await flush();
    expect(t.$(".chat-comp.drag")).not.toBeNull();
    drag("drop", { types: ["Files"], files: [file("d.txt")] });
    await flush(10);
    expect(t.$(".chat-comp.drag")).toBeNull();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["p.png", "d.txt"]);
  });

  it("6673 · только вложения", async () => {
    const t = await chat(IDLE);
    await t.pick(file("c.png", "image/png"));
    expect(t.$<HTMLButtonElement>(".chat-send")!.disabled).toBe(false);
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")[0]).toMatchObject({ text: "", attachments: [{ name: "c.png" }] });
    expect(t.$(".chat-me img")).not.toBeNull();
  });

  it("6674 · вставка текста и перетаскивание без файла", async () => {
    const t = await chat(IDLE);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [] } });
    t.$(".chat-inp")!.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    const comp = t.$(".chat-comp")!;
    const drag = (type: string, types: string[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { types, files: [] } });
      comp.dispatchEvent(e);
    };
    drag("dragover", ["text/plain"]);
    await flush();
    expect(t.$(".chat-comp.drag")).toBeNull();
    drag("dragover", ["Files"]);
    await flush();
    drag("dragleave", ["Files"]);
    await flush();
    expect(t.$(".chat-comp.drag")).toBeNull();
    expect(t.$(".chat-file")).toBeNull();
    // тот же файл снова: выбор сбрасывается, событие придёт и второй раз
    await t.pick(file("a.txt"));
    await t.click(t.$('[aria-label="убрать a.txt"]'));
    await t.pick(file("a.txt"));
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.txt"]);
  });

  it("6675 · тип, который сессия не примет, и файл больше предела", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "bad_frame" });
    const t = await chat(IDLE, { relay });
    await t.pick(new File(["x"], "a.bin"));
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.bin"]);
    await t.click(t.$(".chat-send"));
    expect(relay.sent("session.prompt")[0]).toMatchObject({ attachments: [{ media_type: "application/octet-stream" }] });
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.bin"]);
    expect(t.$(".sb-toast")!.textContent).toContain("bad_frame");
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "too_large" });
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.bin"]);
    expect(t.$(".sb-toast")!.textContent).toContain("too_large");
  });
});

describe("action-chat-suggest", () => {
  const withCommands = () => {
    const relay = relayFor();
    relay.handlers["session.call"] = (f) => (f.method === "supportedCommands" ? { ok: true, result: [{ name: "review", description: "ревью" }, { name: "reload" }] } : { ok: true, result: null });
    return relay;
  };

  it("6676 · клавиши", async () => {
    const t = await chat(IDLE, { relay: withCommands() });
    await t.type("/");
    const sel = () => t.$$(".chat-sugi").findIndex((x) => x.getAttribute("aria-selected") === "true");
    expect(sel()).toBe(0);
    await t.key("ArrowDown");
    expect(sel()).toBe(1);
    await t.key("Tab");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("/reload ");
    await t.type("/re");
    await t.key("Escape");
    expect(t.$(".chat-sug")).toBeNull();
    await t.type("/rev");
    expect(t.$(".chat-sug")).not.toBeNull();
    await t.key("Enter");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("/review ");
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    await t.type("/review");
    await t.key("Enter");
    expect(t.relay.sent("session.prompt")).toHaveLength(1);
  });

  it("6677 · кнопки над полем", async () => {
    const relay = withCommands();
    relay.handlers["session.files"] = () => ({ ok: true, result: ["a.ts"] });
    const t = await chat(IDLE, { relay });
    await t.type("Сравни");
    await t.click(t.$('[aria-label="Файл папки"]'));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Сравни @");
    expect(relay.sent("session.files")[0]).toMatchObject({ query: "" });
    expect(document.activeElement).toBe(t.$(".chat-inp"));
    await t.click(t.$('[aria-label="Команда"]'));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("/");
    expect(relay.sent("session.call").filter((f) => f.method === "supportedCommands")).toHaveLength(1);
  });

  it("6678 · текст без подсказок", async () => {
    const t = await chat(IDLE, { relay: withCommands() });
    t.relay.handlers["session.files"] = () => ({ ok: true, result: ["a"] });
    await t.type("почта me@host и путь /tmp/x");
    expect(t.$(".chat-sug")).toBeNull();
    expect(t.relay.sent("session.files")).toHaveLength(0);
    expect(t.relay.sent("session.call")).toHaveLength(0);
  });

  it("6679 · быстрый набор после @", async () => {
    const relay = relayFor();
    const asked: Array<{ id: string; query: string }> = [];
    relay.handlers["session.files"] = (f) => (asked.push({ id: String(f.id), query: String(f.query) }), undefined);
    const t = await chat(IDLE, { relay });
    await t.type("@w");
    await t.type("@wor");
    relay.reply(asked[1].id, { ok: true, result: ["worker.ts"] });
    await flush();
    relay.reply(asked[0].id, { ok: true, result: ["web.ts"] });
    await flush();
    expect(t.$$(".chat-sugi").map((x) => x.textContent)).toEqual(["worker.ts"]);
  });

  it("6680 · подсказка скрыта при тексте и следующий ход её снимает", async () => {
    const t = await chat(IDLE);
    await t.events(IDLE, [{ type: "prompt_suggestion", suggestion: "Запусти" }], 1);
    await t.type("свой");
    expect(t.$(".chat-hint")).toBeNull();
    await t.key("Tab");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("свой");
    await t.type("");
    expect(t.$(".chat-hint")).not.toBeNull();
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "ход" }])], 2);
    expect(t.$(".chat-hint")).toBeNull();
  });

  it("6681 · метод подсказок отказал", async () => {
    const relay = relayFor();
    relay.handlers["session.call"] = () => ({ ok: false, error: "stopped" });
    const t = await chat(IDLE, { relay });
    await t.type("/");
    await t.type("/x");
    expect(t.$(".chat-sug")).toBeNull();
    expect(relay.sent("session.call")).toHaveLength(1);
    await t.key("Enter");
    expect(relay.sent("session.prompt")).toHaveLength(1);
  });

  it("6682 · кнопка команд у неживой сессии", async () => {
    const t = await chat("wiki@pc");
    expect(t.$('[aria-label="Команда"]')).toBeNull();
    expect(t.$('[aria-label="Файл папки"]')).not.toBeNull();
    expect(t.$('[aria-label="Вложить файл"]')).not.toBeNull();
  });
});

describe("action-chat-call", () => {
  it("6683 · нет метода или сессия не жива", async () => {
    const history = [tool("a1", "t1"), { type: "system", subtype: "task_started", uuid: "k1", task_id: "k", tool_use_id: "t1", description: "сборка" }];
    const stopped = await chat("wiki@pc", { relay: relayFor(roster(), history), wide: true });
    expect(stopped.btn(".chat-feed", "Стоп")).toBeNull();
    expect(stopped.btn(".chat-feed", "В фон")).toBeNull();
  });

  it("6684 · команда без задачи", async () => {
    const relay = relayFor(roster(), [tool("a1", "t1")]);
    relay.handlers["session.call"] = () => ({ ok: true, result: null });
    const t = await chat(IDLE, { relay, wide: true });
    expect(t.btn(".chat-feed", "Стоп")).toBeNull();
    await t.click(t.btn(".chat-feed", "В фон"));
    expect(relay.sent("session.call")[0]).toMatchObject({ method: "backgroundTasks", args: ["t1"] });
    await t.events(IDLE, [{ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }], 1);
    expect(t.btn(".chat-feed", "В фон")).toBeNull();
  });

  it("6685 · задача уже в фоне", async () => {
    const relay = relayFor(roster(), [tool("a1", "t1"), bgStart("k", "t1")]);
    relay.handlers["session.call"] = () => ({ ok: true, result: null });
    const t = await chat(IDLE, { relay, wide: true });
    expect(t.btn(".chat-feed", "В фон")).toBeNull();
    expect(t.btn(".chat-feed", "Стоп")).not.toBeNull();
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 1");
    await t.click(t.$(".chat-bg .dis-h"));
    await t.click(t.btn(".chat-bg", "Стоп"));
    expect(relay.sent("session.call")[0]).toMatchObject({ method: "stopTask", args: ["k"] });
  });

  it("6686 · полоса фона без session.call", async () => {
    const r = roster((x) => {
      for (const m of x.machines) delete (m.contract as Record<string, number>)["session.call"];
    });
    const t = await chat(IDLE, { relay: relayFor(r, [tool("a1", "t1"), bgStart("k", "t1")]), wide: true });
    await t.click(t.$(".chat-bg .dis-h"));
    expect(t.btn(".chat-bg", "Стоп")).toBeNull();
    expect(t.$(".chat-bgr")!.textContent).toContain("сборка");
  });
});

describe("frame-session-events-tasks", () => {
  it("6687 · фоновая и её конец", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [{ type: "system", subtype: "background_tasks_changed", uuid: "s0", tasks: [{ task_id: "n", task_type: "local_bash", description: "из набора" }] }], 1);
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 1");
    expect(t.$(".chat-bg")!.textContent).toContain("из набора");
    await t.events(IDLE, [tool("a1", "t1"), bgStart("k", "t1"), { type: "system", subtype: "task_updated", uuid: "u1", task_id: "k", patch: { is_backgrounded: true } }], 2);
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 2");
    await t.events(IDLE, [{ type: "system", subtype: "task_updated", uuid: "u2", task_id: "k", patch: { status: "killed", end_time: 5 } }, { type: "system", subtype: "task_notification", uuid: "e1", task_id: "n", status: "completed" }, { type: "system", subtype: "task_notification", uuid: "e2", task_id: "n", status: "completed" }], 3);
    expect(t.$(".chat-bg")).toBeNull();
    expect(t.$('[data-tool="Bash"] .tc-st')!.textContent).toBe("остановлено");
    expect(t.$$(".chat-line.ok").map((x) => x.textContent)).toEqual(["Задача завершена · из набора"]);
  });

  it("6688 · список задач claude", async () => {
    const todos = [{ content: "а", status: "completed" }, { content: "б", activeForm: "делаю б", status: "in_progress" }, { content: "в", status: "pending" }];
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [tool("a1", "t1", "TodoWrite", { todos })], 1);
    expect(t.$('[data-tool="TodoWrite"] .tc-sum')!.textContent).toBe("1 из 3 готово");
    expect(t.$(".chat-todo .dis-h")!.textContent).toBe("1 из 3делаю б");
    await t.events(IDLE, [tool("a2", "t2", "TodoWrite", { todos: todos.map((x) => ({ ...x, status: "completed" })) })], 2);
    expect(t.$(".chat-todo")).toBeNull();
    // список субагента — только в его карточке
    await t.events(IDLE, [tool("a3", "t3", "Agent"), { ...tool("a4", "t4", "TodoWrite", { todos }), parent_tool_use_id: "t3" }], 3);
    expect(t.$(".tb-steps .chat-todos")).not.toBeNull();
    expect(t.$(".chat-todo")).toBeNull();
  });
});

describe("frame-session-events-system", () => {
  it("6689 · отказ модели, ход кончился", async () => {
    const t = await chat(IDLE, { relay: relayFor(roster(), [user("u1", "сломай"), { type: "assistant", uuid: "a1", isApiErrorMessage: true, error: "x", message: { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] } }, { type: "system", subtype: "model_refusal_no_fallback", uuid: "x1", refused_user_message_uuid: "u1", api_refusal_explanation: "причина" }]) });
    expect(t.$$(".chat-ban.bad")).toHaveLength(1);
    expect(t.$(".chat-ban.bad")!.textContent).toContain("Opus 5.5 отказалась отвечать");
    expect(t.$(".chat-ban.bad")!.textContent).toContain("Область: биология и химия. причина");
    await t.click(t.btn(".chat-ban", "Изменить сообщение"));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("сломай");
  });
});

describe("action-chat-rewind", () => {
  it("6690 · вторая проба, пока идёт первая; проба отказала", async () => {
    const relay = relayFor(roster(), [user("m1", "раз"), user("m2", "два")]);
    const asked: string[] = [];
    relay.handlers["session.call"] = (f) => (asked.push(String(f.id)), undefined);
    const t = await chat(IDLE, { relay, wide: true });
    const links = t.$$(".chat-rw");
    await t.click(links[0]);
    await t.click(links[1]);
    relay.reply(asked[1], { ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } });
    await flush();
    relay.reply(asked[0], { ok: true, result: { canRewind: false, error: "поздно" } });
    await flush();
    expect(t.$$(".chat-rwc")).toHaveLength(1);
    expect(t.$(".chat-rwc")!.textContent).toContain("сообщению? 1 файл");
    await t.click(t.btn(".chat-rwc", "Отмена"));
    relay.handlers["session.call"] = () => ({ ok: false, error: "offline" });
    await t.click(t.$$(".chat-rw")[0]);
    expect(t.$(".chat-rwc")!.textContent).toBe("Откатить нельзя: pc не на связи");
    expect(t.btn(".chat-rwc", "Откатить")).toBeNull();
  });

  it("6691 · ссылки нет", async () => {
    const history = [user("m1", "раз")];
    const stopped = await chat("wiki@pc", { relay: relayFor(roster(), history), wide: true });
    expect(stopped.$(".chat-rw")).toBeNull();
    const narrow = await chat(IDLE, { relay: relayFor(roster(), history) });
    expect(narrow.$(".chat-rw")).toBeNull();
    const relay = relayFor(roster(), history);
    relay.handlers["session.prompt"] = () => undefined;
    const sending = await chat(IDLE, { relay, wide: true });
    expect(sending.$(".chat-rw")).not.toBeNull();
    await sending.type("Катим");
    await sending.click(sending.$(".chat-send"));
    expect(sending.$$(".chat-rw")).toHaveLength(1);
  });
});

describe("action-chat-view", () => {
  const withPanel = (usage: unknown = { totalTokens: 84_200, maxTokens: 200_000, percentage: 42, categories: [{ name: "Messages", tokens: 51_200 }, { name: "Skills", tokens: 0 }] }) => {
    const relay = relayFor();
    relay.handlers["session.call"] = (f) => (f.method === "getContextUsage" ? { ok: true, result: usage } : f.method === "supportedAgents" ? { ok: true, result: [{ name: "Explore", description: "поиск" }] } : { ok: true, result: null });
    return relay;
  };
  const panelBtn = (t: Awaited<ReturnType<typeof chat>>) => t.$$<HTMLButtonElement>(".chat-bar button").find((b) => b.textContent === "контекст") ?? null;

  it("6692 · контекст", async () => {
    const relay = withPanel();
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(panelBtn(t));
    expect(t.$(".chat-panel")!.textContent).toContain("84 К из 200 К");
    expect(t.$(".chat-panel")!.textContent).toContain("Разговор");
    expect(t.$(".chat-panel")!.textContent).not.toContain("Скилы");
    expect(t.$(".chat-panel")!.textContent).toContain("Explore");
    await t.click(t.$$<HTMLButtonElement>(".chat-panel button").find((b) => b.textContent === "Сжать контекст")!);
    expect(relay.sent("session.prompt")[0]).toMatchObject({ text: "/compact" });
    expect(t.$(".chat-panel")).toBeNull();
    // панель заново: кадр ленты запросов не шлёт, новое открытие спрашивает снова
    const before = relay.sent("session.call").length;
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "ход" }])], 1);
    expect(relay.sent("session.call").length).toBe(before);
    await t.click(panelBtn(t));
    // контекст, субагенты, расход, сведения claude, правила, хуки
    expect(relay.sent("session.call").length).toBe(before + 6);
  });

  it("6693 · контекст недоступен: отказ — словом в панели, панель открыта", async () => {
    const stopped = await chat("wiki@pc", { wide: true });
    expect(panelBtn(stopped)).toBeNull();
    const relay = relayFor();
    relay.handlers["session.call"] = () => ({ ok: false, error: "stopped" });
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(panelBtn(t));
    expect(t.$(".chat-panel > .bad")!.textContent).toBe("сессия остановлена");
    expect(t.$(".chat-panel")).not.toBeNull();
  });

  it("6694 · контекст заполнен", async () => {
    const warn = await chat(IDLE, { relay: withPanel({ percentage: 75 }), wide: true });
    await warn.click(panelBtn(warn));
    expect(warn.$(".chat-panel .sb-barw.warn")).not.toBeNull();
    const bad = await chat(IDLE, { relay: withPanel({ percentage: 95 }), wide: true });
    await bad.click(panelBtn(bad));
    expect(bad.$(".chat-panel .sb-barw.bad")).not.toBeNull();
  });

  it("6695 · прокрутка", async () => {
    const t = await chat(IDLE, { relay: relayFor(roster(), [user("u1", "раз")]) });
    const f = t.$<HTMLElement>(".chat-feed")!;
    let top = 900;
    Object.defineProperty(f, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(f, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(f, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
    f.dispatchEvent(new Event("scroll"));
    await flush();
    expect(t.$(".chat-jump")).toBeNull();
    top = 100;
    f.dispatchEvent(new Event("scroll"));
    await flush();
    expect(t.$(".chat-jump")).not.toBeNull();
    await t.click(t.$(".chat-jump"));
    expect(top).toBe(1000);
    expect(t.$(".chat-jump")).toBeNull();
  });

  it("6696 · узкий вид; индикатор работы", async () => {
    const narrow = await chat(CS);
    expect(narrow.$(".chat-bar")).toBeNull();
    expect(narrow.$(".chat-work i")).not.toBeNull();
    await narrow.events(CS, [{ type: "system", subtype: "thinking_tokens", uuid: "s1", estimated_tokens: 1500 }], 1);
    expect(narrow.$(".chat-work")!.textContent).toBe("размышляет · 1.5 К");
    await narrow.events(CS, [{ type: "system", subtype: "status", uuid: "s2", status: "compacting" }], 2);
    expect(narrow.$(".chat-work")!.textContent).toBe("Сжимаю контекст…");
    await narrow.events(CS, [{ type: "system", subtype: "compact_boundary", uuid: "s3", compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } }], 3);
    expect(narrow.$(".chat-work")!.textContent).not.toContain("Сжимаю");
    expect(narrow.$(".chat-sys")!.textContent).toBe("контекст сжат · 90 К → 8 К");
    const idle = await chat(IDLE);
    await idle.events(IDLE, [{ type: "system", subtype: "thinking_tokens", uuid: "s4", estimated_tokens: 1500 }, { type: "system", subtype: "session_state_changed", uuid: "s5", state: "idle" }], 1);
    expect(idle.$(".chat-work")).toBeNull();
  });

  it("6697 · фокус: на виду ошибка и прерывание; итога ещё нет; фокус снят", async () => {
    const relay = relayFor(roster(), [user("u1", "Почини"), tool("a1", "t1"), { type: "assistant", uuid: "a2", error: "overloaded", message: { id: "a2", content: [{ type: "text", text: "промежуточный" }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } }, user("i1", "[Request interrupted by user]")]);
    const t = await chat(IDLE, { relay, wide: true });
    const focus = t.$$<HTMLButtonElement>(".chat-bar button").find((b) => b.textContent === "фокус")!;
    await t.click(focus);
    expect(t.$(".chat-col .chat-ban.bad")).not.toBeNull();
    expect(t.$(".chat-col > .chat-sys.wait")!.textContent).toContain("прервано");
    expect(t.$(".chat-steps")!.textContent).toContain("2 шага");
    expect(t.$(".chat-col > .chat-reply")).toBeNull();
    await t.click(focus);
    expect(focus.getAttribute("aria-pressed")).toBe("false");
    expect(t.$$(".chat-tool")).toHaveLength(2);
    expect(t.$(".chat-steps")).toBeNull();
  });

  it("6698 · выгрузка переписки", async () => {
    const relay = relayFor(roster(), [user("u1", '<fleet-message from="a@b">\nПривет\n</fleet-message>')]);
    const t = await chat(IDLE, { relay, wide: true });
    relay.push({ type: "message", from: IDLE, to: "phone", text: "Готово" });
    await flush();
    const a = t.$<HTMLAnchorElement>(".chat-bar a")!;
    a.addEventListener("click", (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }));
    expect(a.getAttribute("download")).toBe("poe-bot-pc.md");
    const md = decodeURIComponent(a.href);
    expect(md).toContain("## a@b → сессии");
    expect(md).toContain(`## ${IDLE} → вам`);
  });
});

describe("frame-message", () => {
  it("6699 · сообщения при закрытом и открытом чате; пуш без нажатия; обрыв", async () => {
    const relay = relayFor();
    const t = await stand(parts(), { relay });
    relay.push({ type: "message", from: IDLE, to: "phone", text: "первое" });
    relay.push({ type: "message", from: IDLE, to: "phone", notify: { body: "из пуша" } });
    await flush();
    expect(location.hash).not.toContain("chat");
    await t.expand();
    const row = t.$(`[data-callsign="${IDLE}"]`)!;
    expect(row.querySelector(".sb-badge")!.textContent).toBe("2");
    expect(row.textContent).toContain("из пуша");
    await t.click(row);
    expect(t.$$(".chat-in")).toHaveLength(2);
    expect(t.$$(".chat-in")[1].textContent).toContain("из уведомления");
    relay.push({ type: "message", from: IDLE, to: "phone", text: "третье" });
    await flush();
    expect(t.$$(".chat-in")).toHaveLength(3);
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(t.$$(".chat-in")).toHaveLength(3);
    relay.setRoster(roster());
    await flush();
    expect(t.$$(".chat-sys.swap")).toHaveLength(0);
  });
});
