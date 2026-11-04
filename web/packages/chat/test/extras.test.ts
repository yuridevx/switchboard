// Возможности claude-fleet в чате: вопрос сбоку, вывод фоновой команды, снятие из очереди, разделы панели, черновики в снимке.
// Источник: устав — Switchboard заменяет claude-fleet, все его функции (слово пользователя 31 окт.); цель 3 нояб.: «чат со всеми фичами claude».
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, KEY } from "../../core/stand/app.ts";
import { memoryStore } from "@switchboard/web-core";
import { chat, relayFor, roster } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const CS = "poe-bot@pc";
const calls = (relay: ReturnType<typeof relayFor>, method: string) => relay.sent("session.call").filter((f) => f.method === method);
const answer = (relay: ReturnType<typeof relayFor>, table: Record<string, () => unknown>) => {
  relay.handlers["session.call"] = (f) => {
    const a = table[String(f.method)];
    return a ? (a() as never) : { ok: true, result: [] };
  };
};

describe("вопрос сбоку", () => {
  it("7010 · «/btw вопрос» — askSideQuestion, в ленту и session.prompt не идёт; ответ разметкой; поле пусто", async () => {
    const relay = relayFor();
    answer(relay, { askSideQuestion: () => ({ ok: true, result: { response: "Ответ **сбоку**" } }) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("/btw какая версия?");
    await t.click(t.$(".chat-send"));
    expect(calls(relay, "askSideQuestion")[0]).toMatchObject({ callsign: CS, args: ["какая версия?"] });
    expect(relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$(".chat-side")!.textContent).toContain("какая версия?");
    expect(t.$(".chat-side strong")!.textContent).toBe("сбоку");
    expect(t.$(".chat-side")!.getAttribute("data-state")).toBe("done");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
  });

  it("7011 · пока ответа нет — «думает»; несколько вопросов подряд; крестик закрывает один", async () => {
    const relay = relayFor();
    let replied = false;
    answer(relay, { askSideQuestion: () => (replied ? { ok: true, result: { response: "второй" } } : undefined) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("/btw первый?");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-side")!.getAttribute("data-state")).toBe("wait");
    expect(t.$(".chat-side")!.textContent).toContain("думает");
    replied = true;
    await t.type("/btw второй?");
    await t.click(t.$(".chat-send"));
    expect(t.$$(".chat-side").map((x) => x.getAttribute("data-state"))).toEqual(["wait", "done"]);
    await t.click(t.$(".chat-side [aria-label='Закрыть']"));
    expect(t.$$(".chat-side").map((x) => x.getAttribute("data-state"))).toEqual(["done"]);
  });

  it("7012 · отказ метода — слово в карточке, тоста нет", async () => {
    const relay = relayFor();
    answer(relay, { askSideQuestion: () => ({ ok: false, error: "sdk_error" }) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("/btw что?");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-side")!.getAttribute("data-state")).toBe("bad");
    expect(t.$(".chat-side")!.textContent).toContain("sdk_error");
    expect(t.$(".sb-toast")?.textContent ?? "").toBe("");
  });

  it("7013 · «/b» — в подсказках «/btw» и без ответа о командах; нет session.call — ни подсказки, ни вопроса", async () => {
    const relay = relayFor();
    answer(relay, { supportedCommands: () => ({ ok: true, result: [{ name: "compact" }] }) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("/b");
    expect(t.$$(".chat-sugi b").map((x) => x.textContent)).toEqual(["/btw"]);

    const r2 = roster((x) => {
      for (const m of x.machines) delete m.contract!["session.call"];
    });
    const relay2 = relayFor(r2);
    const t2 = await chat(CS, { relay: relay2, wide: true });
    await t2.type("/btw что?");
    expect(t2.$(".chat-sugi")).toBeNull();
    await t2.click(t2.$(".chat-send"));
    expect(relay2.sent("session.prompt")[0]).toMatchObject({ text: "/btw что?" });
    expect(t2.$(".chat-side")).toBeNull();
  });
});

describe("вывод фоновой команды", () => {
  const bg = (type = "local_bash") => [{ type: "system", subtype: "task_started", uuid: "k1", task_id: "t1", task_type: type, tool_use_id: "x", description: "npm run dev", is_backgrounded: true }];

  it("7014 · «Вывод» — getTaskOutput, хвост и подпись; «Скрыть» снимает опрос", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const relay = relayFor(roster(), bg());
      answer(relay, { getTaskOutput: () => ({ ok: true, result: { output: "listening 3000", total_bytes: 20480, truncated: true } }) });
      const t = await chat(CS, { relay, wide: true });
      await t.click(t.$(".chat-bg .dis-h"));
      await t.click(t.btn(".chat-bg", "Вывод"));
      expect(calls(relay, "getTaskOutput")[0]).toMatchObject({ args: ["t1"] });
      expect(t.$(".chat-out pre")!.textContent).toBe("listening 3000");
      expect(t.$(".chat-out")!.textContent).toContain("последние 8 КБ из 20 КБ");
      const n = calls(relay, "getTaskOutput").length;
      vi.advanceTimersByTime(2100);
      await flush();
      expect(calls(relay, "getTaskOutput").length).toBe(n + 1);
      await t.click(t.btn(".chat-bg", "Скрыть"));
      expect(t.$(".chat-out")).toBeNull();
      const m = calls(relay, "getTaskOutput").length;
      vi.advanceTimersByTime(6000);
      await flush();
      expect(calls(relay, "getTaskOutput").length).toBe(m);
    } finally {
      vi.useRealTimers();
    }
  });

  it("7015 · отказ — словом; у субагента кнопки нет", async () => {
    const relay = relayFor(roster(), bg());
    answer(relay, { getTaskOutput: () => ({ ok: false, error: "no_task" }) });
    const t = await chat(CS, { relay, wide: true });
    await t.click(t.$(".chat-bg .dis-h"));
    await t.click(t.btn(".chat-bg", "Вывод"));
    expect(t.$(".chat-out")!.textContent).toContain("no_task");

    const t2 = await chat(CS, { relay: relayFor(roster(), bg("local_agent")), wide: true });
    await t2.click(t2.$(".chat-bg .dis-h"));
    expect(t2.btn(".chat-bg", "Вывод")).toBeNull();
  });
});

describe("снятие из очереди", () => {
  const busy = () => roster((x) => void (x.sessions.find((s) => s.callsign === CS)!.state = "busy"));
  const png = () => new File(["x"], "a.png", { type: "image/png" });

  it("7016 · «отменить» — cancelAsyncMessage: снято — пузыря нет, текст и вложение в поле", async () => {
    const relay = relayFor(busy());
    answer(relay, { cancelAsyncMessage: () => ({ ok: true, result: true }) });
    const t = await chat(CS, { relay, wide: true });
    await t.pick(png());
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me")!.textContent).toContain("в очереди");
    const id = relay.sent("session.prompt")[0].uuid;
    await t.click(t.btn(".chat-me", "отменить"));
    expect(calls(relay, "cancelAsyncMessage")[0]).toMatchObject({ args: [id] });
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Потом");
    expect(t.$$(".chat-file")).toHaveLength(1);
  });

  it("7017 · уже взято — пузырь на месте, тост словами", async () => {
    const relay = relayFor(busy());
    answer(relay, { cancelAsyncMessage: () => ({ ok: true, result: false }) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    await t.click(t.btn(".chat-me", "отменить"));
    expect(t.$(".chat-me")).not.toBeNull();
    expect(t.$(".sb-toast")!.textContent).toBe("Claude уже взял это сообщение");
  });

  it("7018 · эхо пришло — кнопки нет; без очереди и без session.call — нет", async () => {
    const relay = relayFor(busy());
    const t = await chat(CS, { relay, wide: true });
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    const id = relay.sent("session.prompt")[0].uuid;
    await t.events(CS, [{ type: "user", uuid: id, message: { content: "Потом" } }], 1);
    expect(t.btn(".chat-me", "отменить")).toBeNull();

    const t2 = await chat(CS, { wide: true });
    await t2.type("Сразу");
    await t2.click(t2.$(".chat-send"));
    expect(t2.btn(".chat-me", "отменить")).toBeNull();

    const r3 = busy();
    for (const m of r3.machines) delete m.contract!["session.call"];
    const t3 = await chat(CS, { relay: relayFor(r3), wide: true });
    await t3.type("Потом");
    await t3.click(t3.$(".chat-send"));
    expect(t3.btn(".chat-me", "отменить")).toBeNull();
  });
});

describe("снятие из очереди на телефоне", () => {
  it("7023 · в занятую на телефоне: «в очереди», а не «доставлено», и «отменить»; эхо — «доставлено»", async () => {
    const r = roster((x) => void (x.sessions.find((s) => s.callsign === CS)!.state = "busy"));
    const relay = relayFor(r);
    const t = await chat(CS, { relay });
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me small")!.textContent).toBe("в очереди");
    expect(t.btn(".chat-me", "отменить")).not.toBeNull();
    const id = relay.sent("session.prompt")[0].uuid;
    await t.events(CS, [{ type: "user", uuid: id, message: { content: "Потом" } }], 1);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
    expect(t.btn(".chat-me", "отменить")).toBeNull();
  });
});

describe("панель контекста", () => {
  const full = {
    getContextUsage: () => ({ ok: true, result: { totalTokens: 84200, maxTokens: 200000, percentage: 42, categories: [{ name: "Messages", tokens: 51200 }] } }),
    supportedAgents: () => ({ ok: true, result: [] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => ({ ok: true, result: { session: { total_cost_usd: 1.84, total_api_duration_ms: 312000, total_lines_added: 148, total_lines_removed: 37 }, rate_limits: { five_hour: { utilization: 34, resets_at: "2026-11-04T15:00:00Z" }, seven_day: null } } }),
    getStatus: () => ({ ok: true, result: { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.310" }, { label: "Peer address", value: "скрыт" }] }] } }),
    getHooksListing: () => ({ ok: true, result: { hooks: [{ event: "PostToolUse", matcher: "Edit", source: "projectSettings", displayText: "cargo fmt" }] } }),
  };
  const open = async (t: Awaited<ReturnType<typeof chat>>) => {
    await t.click(t.btn(".chat-bar", "контекст"));
    await flush();
  };

  it("7019 · разделы «Расход», «Claude», «Хуки» из своих методов; окна лимитов без пустых; адрес peer скрыт", async () => {
    const relay = relayFor();
    answer(relay, full);
    const t = await chat(CS, { relay, wide: true });
    await open(t);
    expect(calls(relay, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET")[0]).toMatchObject({ args: [{ skipBehaviors: true }] });
    const p = t.$(".chat-panel")!.textContent!;
    expect(p).toContain("$1,84");
    expect(p).toContain("+148");
    expect(p).toContain("−37");
    expect(t.$$('.chat-panel [data-window]').map((x) => x.getAttribute("data-window"))).toEqual(["five_hour"]);
    expect(t.$('.chat-panel [data-window="five_hour"]')!.textContent).toContain("34 %");
    expect(p).toContain("2.1.310");
    expect(p).not.toContain("скрыт");
    expect(p).toContain("PostToolUse");
    expect(p).toContain("cargo fmt");
  });

  it("7020 · метода нет на Host (unknown_method) — раздела нет и тоста нет; другой отказ — слово в разделе", async () => {
    const relay = relayFor();
    answer(relay, { ...full, getStatus: () => ({ ok: false, error: "unknown_method" }), getHooksListing: () => ({ ok: false, error: "sdk_error" }) });
    const t = await chat(CS, { relay, wide: true });
    await open(t);
    expect(t.$('[data-sec="claude"]')).toBeNull();
    expect(t.$('[data-sec="hooks"]')!.textContent).toContain("sdk_error");
    expect(t.$(".sb-toast")?.textContent ?? "").toBe("");
  });

  it("7021 · «Перечитать плагины» — reloadPlugins; следующий «/» спрашивает команды заново", async () => {
    const relay = relayFor();
    answer(relay, { ...full, reloadPlugins: () => ({ ok: true, result: {} }), supportedCommands: () => ({ ok: true, result: [{ name: "compact" }] }) });
    const t = await chat(CS, { relay, wide: true });
    await t.type("/");
    expect(calls(relay, "supportedCommands")).toHaveLength(1);
    await t.type("");
    await open(t);
    await t.click(t.btn(".chat-panel", "Перечитать плагины"));
    expect(calls(relay, "reloadPlugins")).toHaveLength(1);
    await t.type("/");
    expect(calls(relay, "supportedCommands")).toHaveLength(2);
  });
});

describe("черновики", () => {
  it("7022 · снимок: черновик переживает повторный start и закрытие экрана, в хранилище — только непустые", async () => {
    const store = memoryStore({ key: KEY, drafts: { "other@pc": "прежний" } });
    const t = await chat(CS, { store, wide: true });
    await t.type("недописанное");
    await t.go("#sessions");
    await flush();
    expect(store.data.drafts).toEqual({ "other@pc": "прежний", [CS]: "недописанное" });
    await t.go(`#chat?callsign=${encodeURIComponent(CS)}`);
    await flush();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("недописанное");
    await t.type("");
    await t.go("#sessions");
    await flush();
    expect(store.data.drafts).toEqual({ "other@pc": "прежний" });
  });
});
