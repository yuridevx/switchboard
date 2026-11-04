// Режимы разрешений и запрос разрешения в чате. Источник: цель пользователя 4 нояб. «чат со всеми фичами Claude»;
// кадры и ответы — настоящий процесс claude 0.3.311. По умолчанию ничего не меняется: режим «без вопросов» — решение устава.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asst, chat, relayFor, roster } from "./stand.ts";
import { flush } from "../../core/stand/app.ts";

const CS = "site@laptop";
/** Roster, где у сессии CS нынешний режим и состояние. */
const rosterOf = (o: { mode?: string; state?: string }) =>
  roster((r) => {
    const s = r.sessions.find((x) => x.callsign === CS) as unknown as Record<string, unknown>;
    if (o.mode) s.mode = o.mode;
    if (o.state) s.state = o.state;
  });

/** Стенд, где Host знает режим и отвечает на session.call. */
function bench(mode = "bypassPermissions", answers: Record<string, unknown> = {}) {
  const relay = relayFor(rosterOf({ mode }));
  const calls: Array<Record<string, unknown>> = [];
  relay.handlers["session.call"] = (f) => {
    calls.push(f);
    const a = answers[String(f.method)];
    return a === "refuse" ? { ok: false, error: "sdk_error" } : { ok: true, result: a ?? null };
  };
  return { relay, calls };
}

/** question.list: ждущие вопросы только у сессии CS, у остальных пусто. */
const listOf = (get: () => unknown[]) => (f: { callsign?: unknown }) => ({ ok: true as const, result: f.callsign === CS ? get() : [] });

const select = (t: { $<T extends Element>(s: string): T | null }) => t.$<HTMLSelectElement>('select[aria-label="Режим разрешений"]');
const pick = async (el: HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};
const labels = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("выбор режима", () => {
  it("7151 · режим из поля roster: четыре режима, нынешний выбран; Авто нет, пока модель не умеет", async () => {
    const { relay } = bench("default");
    const t = await chat(CS, { relay, wide: true });
    const el = select(t)!;
    expect(el.value).toBe("default");
    expect(labels(el)).toEqual(["Без вопросов", "Спрашивать", "Правки сами", "План"]);
    expect([...el.options].map((o) => o.value)).toEqual(["bypassPermissions", "default", "acceptEdits", "plan"]);
  });

  it("7152 · «Авто» — только если модель сессии умеет", async () => {
    const { relay } = bench("default", { supportedModels: [{ value: "haiku" }, { value: "opus", supportsAutoMode: true }] });
    const t = await chat(CS, { relay, wide: true });
    await t.events(CS, [{ type: "system", subtype: "init", model: "claude-opus-5-5", permissionMode: "default", uuid: "i1" }]);
    await flush();
    expect(labels(select(t)!)).toContain("Авто");
    const b = bench("default", { supportedModels: [{ value: "opus", supportsAutoMode: true }] });
    const u = await chat(CS, { relay: b.relay, wide: true });
    await u.events(CS, [{ type: "system", subtype: "init", model: "claude-haiku-5-5", permissionMode: "default", uuid: "i1" }]);
    await flush();
    expect(labels(select(u)!)).not.toContain("Авто");
  });

  it("7153 · смена — session.call setPermissionMode; значение меняет поле roster, а не клик и не кадр ленты", async () => {
    const { relay, calls } = bench();
    const t = await chat(CS, { relay, wide: true });
    await pick(select(t)!, "plan");
    expect(calls.filter((c) => c.method === "setPermissionMode")).toEqual([expect.objectContaining({ callsign: CS, args: ["plan"] })]);
    expect(select(t)!.value).toBe("bypassPermissions");
    await t.events(CS, [{ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "s1" }]);
    expect(select(t)!.value).toBe("bypassPermissions");
    relay.setRoster(rosterOf({ mode: "plan" }));
    await flush();
    expect(select(t)!.value).toBe("plan");
  });

  it("7154 · отказ — тост словом, режим прежний", async () => {
    const { relay } = bench("bypassPermissions", { setPermissionMode: "refuse" });
    const t = await chat(CS, { relay, wide: true });
    await pick(select(t)!, "plan");
    expect(t.$(".sb-toast")!.textContent).toContain("Claude отказал");
    expect(select(t)!.value).toBe("bypassPermissions");
  });

  it("7155 · на узком экране выбор тоже есть", async () => {
    const { relay } = bench("acceptEdits");
    const t = await chat(CS, { relay });
    expect(t.$(".chat-bar")).toBeNull();
    expect(select(t)!.value).toBe("acceptEdits");
  });

  it("7156 · Host не знает режима — поля нет, выбора нет; session.spec чат не спрашивает", async () => {
    const relay = relayFor(roster((r) => r.machines.forEach((m) => (m.contract = { ...m.contract, "session.spec": 1 }))));
    const asked: string[] = [];
    relay.handlers["session.spec"] = () => (asked.push("x"), { ok: true, result: { mode: "plan" } });
    const t = await chat(CS, { relay, wide: true });
    expect(select(t)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("карточка инструмента", () => {
  const tool = asst("a1", [{ type: "tool_use", id: "toolu_p1", name: "Bash", input: { command: "npm test" } }]);
  const asking = { type: "question", from: CS, to: ["phone"], question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test" } };

  async function waiting() {
    const relay = relayFor(roster(), [tool]);
    const t = await chat(CS, { relay, wide: true });
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ ...asking, type: undefined, from: undefined, to: undefined }] });
    relay.push(asking);
    await flush();
    return { t, relay };
  }

  it("7157 · пока идёт запрос — состояние wait и «ждёт разрешения»", async () => {
    const { t } = await waiting();
    const card = t.$('.chat-tool[data-tool="Bash"]')!;
    expect(card.getAttribute("data-state")).toBe("wait");
    expect(card.querySelector(".tc-st")!.textContent).toBe("ждёт разрешения");
    expect(t.text()).not.toContain("выполнится");
    expect(card.textContent).not.toContain("В фон");
  });

  it("7158 · ответили — снова идёт; чужой вопрос сессии карточку не трогает", async () => {
    const { t, relay } = await waiting();
    relay.push({ type: "answered", from: CS, question: "toolu_p1", by: "phone", action: "allow" });
    await flush();
    expect(t.$('.chat-tool[data-tool="Bash"]')!.getAttribute("data-state")).toBe("running");
    relay.push({ ...asking, question: "toolu_other", tool: "Read" });
    await flush();
    expect(t.$('.chat-tool[data-tool="Bash"]')!.getAttribute("data-state")).toBe("running");
  });

  it("7159 · отклонённый человеком — «отклонено», а не ошибка; и план, который вернули", async () => {
    const res = (id: string, text: string) => ({ type: "user", uuid: `r${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] } });
    const relay = relayFor(roster(), [
      tool,
      res("toolu_p1", "The user doesn't want to proceed with this tool use. Reason: не трогай"),
      asst("a2", [{ type: "tool_use", id: "toolu_e", name: "ExitPlanMode", input: { plan: "1. шаг" } }]),
      res("toolu_e", "The user doesn't want to proceed with this tool use. Reason: добавь тест"),
    ]);
    const t = await chat(CS, { relay, wide: true });
    for (const name of ["Bash", "ExitPlanMode"]) {
      const card = t.$(`.chat-tool[data-tool="${name}"]`)!;
      expect(card.getAttribute("data-state")).toBe("denied");
      expect(card.querySelector(".tc-st")!.textContent).toBe("отклонено");
    }
    await t.click(t.$('.chat-tool[data-tool="Bash"] .tc-h')!);
    expect(t.$('.chat-tool[data-tool="Bash"] .tb-pre:not(.muted)')!.textContent).toBe("не трогай");
    expect(t.text()).not.toContain("doesn't want");
  });
});

describe("над вводом", () => {
  const asking = { type: "question", from: CS, to: ["phone"], question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test" }, title: "Claude хочет выполнить npm test" };
  const list = (f: { callsign?: unknown }) => ({ ok: true as const, result: f.callsign === CS ? [{ ...asking, type: undefined, from: undefined, to: undefined }] : [] });

  it("7160 · широко — запрос над вводом; узко — полоса с заголовком, открывает экран", async () => {
    const wide = relayFor();
    wide.handlers["question.list"] = list;
    const t = await chat(CS, { relay: wide, wide: true });
    wide.push(asking);
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("Claude просит разрешения");
    const narrow = relayFor();
    narrow.handlers["question.list"] = list;
    const u = await chat(CS, { relay: narrow });
    narrow.push(asking);
    await flush();
    const bar = u.$(".chat-askbar")!;
    expect(bar.textContent).toContain("Claude хочет выполнить npm test");
    await u.click(bar);
    await flush();
    expect(u.$(".ask")!.textContent).toContain("Claude просит разрешения");
  });
});

describe("правила в панели контекста", () => {
  const open = async (t: Awaited<ReturnType<typeof chat>>) => {
    await t.click(t.btn(".chat-bar", "контекст")!);
    await flush(10);
  };

  it("7161 · список правил: можно, нельзя, спросить, с источником", async () => {
    const { relay } = bench("default", {
      listPermissionRules: {
        state: {
          rules: [
            { behavior: "allow", source: "localSettings", rule: "Bash(npm test:*)" },
            { behavior: "deny", source: "projectSettings", rule: "Read(.env)" },
            { behavior: "ask", source: "userSettings", rule: "WebFetch" },
          ],
        },
      },
    });
    const t = await chat(CS, { relay, wide: true });
    await open(t);
    const sec = t.$('[data-sec="rules"]')!;
    expect(sec.querySelector("h4")!.textContent).toBe("Разрешения");
    const rows = [...sec.querySelectorAll(".chat-pn-r")].map((r) => r.textContent);
    expect(rows).toEqual(["можноBash(npm test:*)локально", "нельзяRead(.env)проект", "спроситьWebFetchпользователь"]);
  });

  it("7162 · правил нет или метода нет — раздела нет; отказ — слово", async () => {
    const empty = bench("default", { listPermissionRules: { state: { rules: [] } } });
    const t = await chat(CS, { relay: empty.relay, wide: true });
    await open(t);
    expect(t.$('[data-sec="rules"]')).toBeNull();
    const refused = bench("default", { listPermissionRules: "refuse" });
    const u = await chat(CS, { relay: refused.relay, wide: true });
    await open(u);
    expect(u.$('[data-sec="rules"] .bad')!.textContent).toBe("Claude отказал, причина в журнале машины");
  });
});

describe("сессия ждёт человека", () => {
  const waiting = () => relayFor(rosterOf({ state: "waiting" }));

  it("7208 · waiting: «Прервать» есть; сообщение — в очередь и его можно снять", async () => {
    // источник: цель пользователя 4 нояб. и решение главной сессии: предел ожидания человека — «Прервать» и session.stop; ход идёт, ввод ждёт в очереди, как в busy
    const relay = waiting();
    const asked: unknown[] = [];
    relay.handlers["session.call"] = (f) => (asked.push(f.method), { ok: true, result: null });
    const t = await chat(CS, { relay, wide: true });
    const stop = t.$<HTMLButtonElement>(".chat-stop")!;
    expect(stop.textContent).toBe("Прервать");
    await t.click(stop);
    expect(asked).toEqual(["interrupt"]);
    await t.type("ещё");
    await t.key("Enter");
    await flush();
    expect(t.$(".chat-me small")!.textContent).toContain("в очереди");
    expect(t.btn(".chat-me", "отменить")).not.toBeNull();
  });

  const q = { question: "toolu_w1", kind: "perm", tool: "Bash", input: { command: "ls" } };

  it("7209 · ждала и перестала, ответа не видели: запись снята по question.list; следующее ожидание снова спрашивает", async () => {
    // источник: цель 4 нояб.: запрос, на который ответили на другом устройстве без кадра до этого клиента, не висит; чьё: код — question.list держит правду
    const relay = waiting();
    let list: unknown[] = [q];
    let n = 0;
    relay.handlers["question.list"] = listOf(() => (n++, list));
    const t = await chat(CS, { relay, wide: true });
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("Claude просит разрешения");
    const opened = n;
    // тот же waiting в новом roster — запрос один раз на ожидание
    relay.setRoster(rosterOf({ state: "waiting", mode: "default" }));
    await flush();
    expect(n).toBe(opened);
    list = [];
    relay.setRoster(rosterOf({ state: "idle" }));
    await flush(5);
    expect(t.$(".chat-ask .ask-acts")).toBeNull();
    expect(n).toBe(opened + 1);
    // кадра нового вопроса не было — видно по waiting
    list = [{ ...q, question: "toolu_w2" }];
    relay.setRoster(rosterOf({ state: "waiting" }));
    await flush(5);
    expect(n).toBe(opened + 2);
    expect(t.$(".chat-ask .ask-acts")).not.toBeNull();
  });

  it("7210 · вопрос пришёл кадром раньше waiting в roster: лишнего question.list на каждый roster нет", async () => {
    // источник: то же; запрос один раз на ожидание
    const relay = relayFor(rosterOf({ state: "busy" }));
    let n = 0;
    relay.handlers["question.list"] = listOf(() => (n++, [q]));
    await chat(CS, { relay, wide: true });
    relay.push({ type: "question", from: CS, to: ["phone"], ...q });
    await flush();
    const before = n;
    for (let i = 0; i < 3; i++) {
      relay.setRoster(rosterOf({ state: "busy", mode: `m${i}` }));
      await flush();
    }
    expect(n - before).toBeLessThanOrEqual(1);
  });

  it("7213 · вопросы сессии идут один за другим: на экране новый, а не итог прежнего", async () => {
    // источник: второй проход архитектора — закрытые вытесняются (7215), экран от этого не меняется; чьё: код — current
    const relay = relayFor(rosterOf({ state: "busy" }));
    const frame = (id: string) => ({ question: id, kind: "perm", tool: "Bash", input: { command: id } });
    let now = "";
    relay.handlers["question.list"] = listOf(() => (now ? [frame(now)] : []));
    const t = await chat(CS, { relay, wide: true });
    for (const id of ["a", "b", "c"]) {
      now = id;
      relay.push({ type: "question", from: CS, to: ["phone"], ...frame(id) });
      await flush();
      expect(t.$(".chat-ask code")!.textContent).toBe(id);
      now = "";
      relay.push({ type: "answered", from: CS, question: id, by: "phone", action: "allow" });
      await flush();
    }
  });
});

describe("Разрешать всегда", () => {
  const frame = (suggestions: unknown[]) => ({ type: "question", from: CS, to: ["phone"], question: "toolu_s", kind: "perm", tool: "Bash", input: { command: "npm test" }, suggestions });
  const shown = async (suggestions: unknown[]) => {
    const relay = relayFor();
    const f = frame(suggestions);
    relay.handlers["question.list"] = listOf(() => [{ ...f, type: undefined, from: undefined, to: undefined }]);
    const t = await chat(CS, { relay, wide: true });
    relay.push(f);
    await flush();
    return t;
  };

  it("7211 · правило и куда ляжет видно до нажатия", async () => {
    // источник: цель 4 нояб. «чат со всеми фичами»: человек видит, что разрешает навсегда; форма suggestions — настоящий процесс 0.3.311
    const t = await shown([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]);
    expect(t.$(".chat-ask")!.textContent).toContain("Bash(npm test:*) · локально");
    const u = await shown([{ type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addDirectories", directories: ["/tmp/a"], destination: "session" }]);
    expect(u.$(".chat-ask")!.textContent).toContain("Правки сами · сессия");
    expect(u.$(".chat-ask")!.textContent).toContain("/tmp/a · сессия");
  });

  it("7214 · нет предложений SDK — ни кнопки, ни строки", async () => {
    // источник: комментарий кода «разрешить всегда — только если предложил SDK», чьё: код
    const t = await shown([]);
    expect(t.btn(".chat-ask", "Разрешать всегда")).toBeNull();
    expect(t.$(".chat-ask")!.textContent).not.toContain("·");
  });
});

describe("план один раз", () => {
  it("7212 · пока план ждёт одобрения, в карточке инструмента он свёрнут; ответили — раскрыт; правка Edit раскрыта и пока ждёт", async () => {
    // источник: цель 4 нояб., просмотр окон: один и тот же план двумя блоками один над другим; чьё: код — у плана своё место над вводом
    const relay = relayFor(roster(), [asst("a1", [{ type: "tool_use", id: "toolu_pl", name: "ExitPlanMode", input: { plan: "## План один" } }])]);
    const plan = { question: "toolu_pl", kind: "perm", tool: "ExitPlanMode", input: { plan: "## План один" } };
    relay.handlers["question.list"] = listOf(() => [plan]);
    const t = await chat(CS, { relay, wide: true });
    relay.push({ type: "question", from: CS, to: ["phone"], ...plan });
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("План один");
    expect(t.$('.chat-tool[data-tool="ExitPlanMode"] .tc-h')!.getAttribute("aria-expanded")).toBe("false");
    relay.push({ type: "answered", from: CS, question: "toolu_pl", by: "phone", action: "allow" });
    await flush();
    expect(t.$('.chat-tool[data-tool="ExitPlanMode"] .tc-h')!.getAttribute("aria-expanded")).toBe("true");

    const b = relayFor(roster(), [asst("a2", [{ type: "tool_use", id: "toolu_ed", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }])]);
    const edit = { question: "toolu_ed", kind: "perm", tool: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } };
    b.handlers["question.list"] = listOf(() => [edit]);
    const u = await chat(CS, { relay: b, wide: true });
    b.push({ type: "question", from: CS, to: ["phone"], ...edit });
    await flush();
    expect(u.$('.chat-tool[data-tool="Edit"] .tc-h')!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("панель контекста на одном ходе к методам", () => {
  it("7216 · отказ getContextUsage и supportedAgents — слово в панели, без тоста; по одному запросу", async () => {
    // источник: устав «ошибка словом»; второй проход — один путь отказа у панели; чьё: код — разделы панели показывают слово
    const relay = relayFor();
    const asked: unknown[] = [];
    relay.handlers["session.call"] = (f) => {
      asked.push(f.method);
      return f.method === "getContextUsage" ? { ok: false, error: "sdk_error" } : f.method === "supportedAgents" ? { ok: false, error: "unknown_method" } : { ok: true, result: null };
    };
    const t = await chat(CS, { relay, wide: true });
    await t.click(t.btn(".chat-bar", "контекст")!);
    await flush(10);
    expect(t.$(".chat-panel > .bad")!.textContent).toBe("Claude отказал, причина в журнале машины");
    expect(t.$(".sb-toast")!.hidden).toBe(true);
    expect(asked.filter((m) => m === "getContextUsage")).toHaveLength(1);
  });
});
