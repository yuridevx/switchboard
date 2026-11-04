// Режимы разрешений и запрос разрешения в чате. Источник: цель пользователя 4 нояб. «чат со всеми фичами Claude»;
// кадры и ответы — настоящий процесс claude 0.3.311. По умолчанию ничего не меняется: режим «без вопросов» — решение устава.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEvents, emptyFeed, withHistory } from "../src/state/feed.ts";
import type { WireMessage } from "../src/state/wire.ts";
import { asst, chat, relayFor, roster } from "./stand.ts";
import { flush } from "../../core/stand/app.ts";

const CS = "site@laptop";
const status = (permissionMode: string) => ({ type: "system", subtype: "status", status: null, permissionMode, uuid: crypto.randomUUID() });
const withSpec = () => roster((r) => r.machines.forEach((m) => (m.contract = { ...m.contract, "session.spec": 1 })));

/** Стенд, где Host знает режим и отвечает на session.call. */
function bench(mode = "bypassPermissions", answers: Record<string, unknown> = {}) {
  const relay = relayFor(withSpec());
  const calls: Array<Record<string, unknown>> = [];
  relay.handlers["session.spec"] = () => ({ ok: true, result: { mode, title: "" } });
  relay.handlers["session.call"] = (f) => {
    calls.push(f);
    const a = answers[String(f.method)];
    return a === "refuse" ? { ok: false, error: "sdk_error" } : { ok: true, result: a ?? null };
  };
  return { relay, calls };
}

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

describe("режим в свёртке", () => {
  it("7150 · permissionMode из init и status — feed.mode; прочие кадры его не трогают; история его не затирает", () => {
    let f = applyEvents(emptyFeed(), [{ type: "system", subtype: "init", permissionMode: "default", uuid: "i1" } as WireMessage]);
    expect(f.mode).toBe("default");
    f = applyEvents(f, [status("plan") as unknown as WireMessage]);
    expect(f.mode).toBe("plan");
    f = applyEvents(f, [{ type: "system", subtype: "status", status: "compacting", uuid: "s2" } as WireMessage]);
    expect(f.mode).toBe("plan");
    expect(withHistory(f, []).mode).toBe("plan");
  });
});

describe("выбор режима", () => {
  it("7151 · режим из session.spec: четыре режима, нынешний выбран; Авто нет, пока модель не умеет", async () => {
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

  it("7153 · смена — session.call setPermissionMode; значение меняет кадр status, а не клик", async () => {
    const { relay, calls } = bench();
    const t = await chat(CS, { relay, wide: true });
    await pick(select(t)!, "plan");
    expect(calls.filter((c) => c.method === "setPermissionMode")).toEqual([expect.objectContaining({ callsign: CS, args: ["plan"] })]);
    expect(select(t)!.value).toBe("bypassPermissions");
    await t.events(CS, [status("plan")]);
    expect(select(t)!.value).toBe("plan");
  });

  it("7154 · отказ — тост словом, режим прежний", async () => {
    const { relay } = bench("bypassPermissions", { setPermissionMode: "refuse" });
    const t = await chat(CS, { relay, wide: true });
    await pick(select(t)!, "plan");
    expect(t.$(".sb-toast")!.textContent).toContain("sdk_error");
    expect(select(t)!.value).toBe("bypassPermissions");
  });

  it("7155 · на узком экране выбор тоже есть", async () => {
    const { relay } = bench("acceptEdits");
    const t = await chat(CS, { relay });
    expect(t.$(".chat-bar")).toBeNull();
    expect(select(t)!.value).toBe("acceptEdits");
  });

  it("7156 · Host не знает режима — выбора нет; session.spec не спрашиваем без контракта", async () => {
    const relay = relayFor();
    const asked: string[] = [];
    relay.handlers["session.spec"] = () => (asked.push("x"), { ok: true, result: {} });
    const t = await chat(CS, { relay, wide: true });
    expect(select(t)).toBeNull();
    expect(asked).toEqual([]);
    const b = relayFor(withSpec());
    b.handlers["session.spec"] = () => ({ ok: true, result: { title: "" } });
    const u = await chat(CS, { relay: b, wide: true });
    expect(select(u)).toBeNull();
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
      res("toolu_p1", "Пользователь отклонил: не трогай"),
      asst("a2", [{ type: "tool_use", id: "toolu_e", name: "ExitPlanMode", input: { plan: "1. шаг" } }]),
      res("toolu_e", "Пользователь вернул план: добавь тест"),
    ]);
    const t = await chat(CS, { relay, wide: true });
    for (const name of ["Bash", "ExitPlanMode"]) {
      const card = t.$(`.chat-tool[data-tool="${name}"]`)!;
      expect(card.getAttribute("data-state")).toBe("denied");
      expect(card.querySelector(".tc-st")!.textContent).toBe("отклонено");
    }
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
    expect(u.$('[data-sec="rules"] .bad')!.textContent).toBe("sdk_error");
  });
});
