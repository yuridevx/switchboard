// Свёртка ленты без стенда: сообщение SDK → записи, инструменты, задачи. Источник форм — sdk.d.ts и fixtures чата claude-fleet.
import { describe, expect, it } from "vitest";
import { addMine, applyEvents, emptyFeed, withHistory, withOlder } from "../src/state/feed.ts";
import { focusRows } from "../src/state/focus.ts";
import { isHtmlDocument, peerOf, specialOf, summaryOf } from "../src/state/parse.ts";
import type { WireMessage } from "../src/state/wire.ts";

const asst = (uuid: string, content: unknown[], id = uuid): WireMessage => ({ type: "assistant", uuid, message: { id, content: content as never } });
const tool = (uuid: string, tid: string, name = "Bash") => asst(uuid, [{ type: "tool_use", id: tid, name, input: { command: "x" } }]);
const result = (uuid: string, tid: string, content: unknown = "вывод", is_error = false): WireMessage => ({ type: "user", uuid, message: { content: [{ type: "tool_result", tool_use_id: tid, content, is_error }] } as never });
const user = (uuid: string, text: string): WireMessage => ({ type: "user", uuid, message: { content: text } });
const fold = (...msgs: WireMessage[]) => applyEvents(emptyFeed(), msgs);

describe("свёртка", () => {
  it("6200 · блоки одного сообщения claude — одна запись; повтор по uuid не задваивает", () => {
    const f = fold(asst("a1", [{ type: "text", text: "раз" }], "m1"), asst("a2", [{ type: "text", text: "два" }], "m1"), asst("a2", [{ type: "text", text: "два" }], "m1"));
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ parts: [{ text: "раз" }, { text: "два" }], uuids: ["a1", "a2"] });
  });

  it("6201 · кусочки растут и сменяются готовым блоком", () => {
    const start: WireMessage = { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };
    const piece = (text: string): WireMessage => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    const live = fold(start, piece("Сбор"), piece("ка"));
    expect(live.items[0]).toMatchObject({ parts: [{ kind: "text", text: "Сборка", live: true }] });
    const done = applyEvents(live, [asst("a1", [{ type: "text", text: "Сборка зелёная" }], "m1")]);
    expect(done.items).toHaveLength(1);
    expect((done.items[0] as { parts: unknown[] }).parts).toEqual([{ kind: "text", text: "Сборка зелёная" }]);
  });

  it("6202 · снимок неизменяем: новое сообщение не трогает прежние записи (рисуется одна карточка)", () => {
    const a = fold(user("u1", "раз"), asst("a1", [{ type: "text", text: "два" }]));
    const b = applyEvents(a, [user("u2", "три")]);
    expect(b.items[0]).toBe(a.items[0]);
    expect(b.items[1]).toBe(a.items[1]);
    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(3);
  });

  it("6203 · итог инструмента — в его карточке, текст и картинки порознь; ошибка помечена", () => {
    const pic = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
    const f = fold(tool("a1", "t1"), result("r1", "t1", [{ type: "text", text: "готово" }, pic]), tool("a2", "t2"), result("r2", "t2", "упало", true));
    expect(f.tools.t1.result).toEqual({ text: "готово", images: ["data:image/png;base64,AAA"], isError: false });
    expect(f.tools.t2.result).toMatchObject({ text: "упало", isError: true });
    expect(f.items.filter((i) => i.kind === "user")).toHaveLength(0);
  });

  it("6204 · шаги субагента — в карточке его инструмента, не в ленте", () => {
    const step: WireMessage = { ...asst("a2", [{ type: "tool_use", id: "t2", name: "Grep", input: {} }]), parent_tool_use_id: "t1" };
    const f = fold(tool("a1", "t1", "Agent"), step);
    expect(f.items).toHaveLength(1);
    expect(f.tools.t1.parts).toEqual([{ kind: "tool", id: "t2" }]);
    expect(f.tools.t2.parent).toBe("t1");
  });

  it("6205 · служебное «пользователя» не становится пузырём: команда с выводом — одна строка, прерывание, напоминание", () => {
    const f = fold(user("c1", "<command-name>/context</command-name><command-args>--full</command-args>"), user("c2", "<local-command-stdout>42%</local-command-stdout>"), user("i1", "[Request interrupted by user]"), user("h1", "<system-reminder>скрыто</system-reminder>"));
    expect(f.items.map((i) => (i.kind === "sys" ? i.sys.type : i.kind))).toEqual(["command", "interrupted"]);
    expect(f.items[0]).toMatchObject({ sys: { name: "/context", args: "--full", output: "42%" } });
  });

  it("6206 · сводка сжатия — на строке границы, а не пузырём; в истории без границы — своя строка", () => {
    const bound: WireMessage = { type: "system", subtype: "compact_boundary", uuid: "b1", compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } };
    const sum: WireMessage = { ...user("s1", "This session is being continued from a previous conversation.\nSummary:\nтаймаут поднят"), isCompactSummary: true };
    const live = fold(bound, sum);
    expect(live.items).toHaveLength(1);
    expect(live.items[0]).toMatchObject({ sys: { type: "compact", pre: 90_000, post: 8000, summary: "таймаут поднят" } });
    expect(fold(sum).items[0]).toMatchObject({ sys: { type: "compact", summary: "таймаут поднят" } });
    // источник: файл разговора 3 нояб. — сводка посреди ленты; реплики до и после на месте, текст обёртки не виден (перенесено из 5537)
    const mid = fold(user("u1", "до"), sum, user("u2", "после"));
    expect(mid.items.map((i) => (i.kind === "sys" ? i.sys.type : i.kind))).toEqual(["user", "compact", "user"]);
    expect(JSON.stringify(mid.items)).not.toContain("This session is being continued");
  });

  it("6207 · стоимость накопительная за процесс: строка хода — разница; прерванный ход без строки ошибки", () => {
    const res = (uuid: string, total: number): WireMessage => ({ type: "result", uuid, subtype: "success", total_cost_usd: total });
    const f = fold(res("z1", 0.5), res("z2", 0.75));
    expect(f.items.map((i) => (i.kind === "sys" && i.sys.type === "result" ? i.sys.cost : null))).toEqual([0.5, 0.25]);
    const cut = fold(user("i1", "[Request interrupted by user]"), { type: "result", uuid: "z3", subtype: "error_during_execution", is_error: true });
    expect(cut.items.map((i) => (i.kind === "sys" ? i.sys.type : i.kind))).toEqual(["interrupted"]);
  });

  it("6208 · отказ модели: начатый ответ отозван; ответ-ошибка и событие об одном отказе — одна плашка", () => {
    const answer = asst("a1", [{ type: "text", text: "начал" }]);
    const f = fold(answer, { type: "system", subtype: "model_refusal_fallback", uuid: "x1", retracted_message_uuids: ["a1"], original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", scope: "local" });
    expect(f.items.map((i) => i.kind)).toEqual(["sys"]);
    expect(f.items[0]).toMatchObject({ sys: { type: "refusal", to: "claude-opus-5-5", local: true } });
    const errorAnswer: WireMessage = { type: "assistant", uuid: "a2", isApiErrorMessage: true, message: { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] } };
    const two = fold(errorAnswer, { type: "system", subtype: "model_refusal_no_fallback", uuid: "x2", api_refusal_explanation: "причина" });
    expect(two.items).toHaveLength(1);
    expect(two.items[0]).toMatchObject({ sys: { type: "refusal", category: "bio", text: "причина" } });
  });

  it("6209 · фоновая задача: идёт по набору; ушла из набора — кончилась; конец — одна строка ленты", () => {
    const start: WireMessage = { type: "system", subtype: "task_started", uuid: "k1", task_id: "t1", tool_use_id: "x", description: "сборка", is_backgrounded: true };
    const live = fold(start);
    expect(live.tasks.t1).toMatchObject({ status: "running", background: true });
    expect(live.items).toHaveLength(0);
    const end = applyEvents(live, [{ type: "system", subtype: "task_notification", uuid: "k2", task_id: "t1", status: "completed" }, { type: "system", subtype: "task_notification", uuid: "k3", task_id: "t1", status: "completed" }]);
    expect(end.items).toHaveLength(1);
    const gone = applyEvents(live, [{ type: "system", subtype: "background_tasks_changed", uuid: "k4", tasks: [] }]);
    expect(gone.tasks.t1.status).toBe("completed");
  });

  it("6210 · повтор API подряд — одна строка с последней попыткой", () => {
    const retry = (uuid: string, attempt: number): WireMessage => ({ type: "system", subtype: "api_retry", uuid, attempt, max_retries: 10 });
    const f = fold(retry("p1", 1), retry("p2", 2));
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ sys: { attempt: 2 } });
  });
});

describe("история", () => {
  it("6211 · заново из истории: свой пузырь найден — ✓✓ с его вложениями; живое, чего в ней нет, — следом", () => {
    const mine = addMine(emptyFeed(), { id: "u1", text: "Смотри", images: ["data:image/png;base64,A"], files: ["a.txt"], at: 5, queued: true });
    const cur = applyEvents(mine, [asst("a9", [{ type: "text", text: "живое" }])]);
    const f = withHistory(cur, [user("u1", "Смотри"), asst("a1", [{ type: "text", text: "из истории" }])]);
    expect(f.items.map((i) => i.id)).toEqual(["u1", "aa1", "aa9"]);
    expect(f.items[0]).toMatchObject({ state: "echo", images: ["data:image/png;base64,A"], files: ["a.txt"], queued: true });
  });

  it("6212 · более ранняя страница: записи перед текущими; итог, ждавший вызова, — в его карточке", () => {
    const cur = fold(result("r1", "t1", "вывод"), user("u2", "потом"));
    expect(cur.orphans.t1).toBeDefined();
    const f = withOlder(cur, [user("u1", "раньше"), tool("a1", "t1")]);
    expect(f.items.map((i) => i.id)).toEqual(["u1", "aa1", "u2"]);
    expect(f.tools.t1.result).toMatchObject({ text: "вывод" });
    expect(f.orphans.t1).toBeUndefined();
  });
});

describe("request-session-history", () => {
  it("6646 · повторная история: строка команды одна", () => {
    const cmd = user("c1", "<command-name>/context</command-name>");
    const out = user("c2", "<local-command-stdout>42%</local-command-stdout>");
    const f = withHistory(fold(cmd, out), [cmd, out]);
    expect(f.items.filter((i) => i.kind === "sys")).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ sys: { name: "/context", output: "42%" } });
  });

  it("6647 · повторная история: шаги субагента целы", () => {
    const call = tool("a1", "T", "Agent");
    const step: WireMessage = { ...asst("a2", [{ type: "text", text: "шаг" }], "m2"), parent_tool_use_id: "T" };
    const sum: WireMessage = { type: "tool_use_summary", uuid: "s1", summary: "сводка", preceding_tool_use_ids: ["T"] };
    const f = withHistory(fold(call, step, sum, result("r1", "T", "итог из кадра")), [call]);
    expect(f.tools.T.parts).toEqual([{ kind: "text", text: "шаг" }]);
    expect(f.tools.T.summary).toBe("сводка");
    expect(f.tools.T.result).toMatchObject({ text: "итог из кадра" });
  });

  it("6648 · повторная история не меняет порядок", () => {
    let f = withHistory(emptyFeed(), [user("u3", "в"), user("u4", "г")]);
    f = withOlder(f, [user("u1", "а"), user("u2", "б")]);
    f = withHistory(f, [user("u3", "в"), user("u4", "г")]);
    expect(f.items.map((i) => i.id)).toEqual(["u1", "u2", "u3", "u4"]);
    const turn = fold(user("u1", "а"), asst("a1", [{ type: "text", text: "о" }]), { type: "result", uuid: "z1", subtype: "success" }, user("u2", "б"));
    const again = withHistory(turn, [user("u1", "а"), asst("a1", [{ type: "text", text: "о" }]), user("u2", "б")]);
    expect(again.items.map((i) => i.id)).toEqual(["u1", "aa1", "s:z1", "u2"]);
  });

  it("6649 · записи без истории не пропадают", () => {
    const mine = addMine(emptyFeed(), { id: "m1", text: "моё", images: [], files: [], at: 1 });
    const f = withHistory(mine, [user("u1", "из истории")]);
    expect(f.items.map((i) => i.id)).toEqual(["u1", "m1"]);
    expect(f.items[1]).toMatchObject({ state: "sending" });
  });

  it("6650 · раньше дважды: итог на средней странице", () => {
    let f = withHistory(emptyFeed(), [user("u3", "в")]);
    f = withOlder(f, [result("r1", "T", "итог"), user("u2", "б")]);
    f = withOlder(f, [tool("a1", "T")]);
    expect(f.tools.T.result).toMatchObject({ text: "итог" });
    expect(f.orphans.T).toBeUndefined();
    expect(f.items.map((i) => i.id)).toEqual(["aa1", "u2", "u3"]);
  });

  it("6651 · сообщение разрезано границей страницы", () => {
    const early = asst("a1", [{ type: "text", text: "текст" }], "m1");
    const late = asst("a2", [{ type: "tool_use", id: "T", name: "Bash", input: {} }], "m1");
    const f = withOlder(withHistory(emptyFeed(), [late]), [early]);
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ parts: [{ kind: "text", text: "текст" }, { kind: "tool", id: "T" }], uuids: ["a1", "a2"] });
  });

  it("6652 · сводка сжатия из кадра и она же в истории без границы — одна строка", () => {
    const bound: WireMessage = { type: "system", subtype: "compact_boundary", uuid: "b1", compact_metadata: { pre_tokens: 90_000 } };
    const sum: WireMessage = { ...user("s1", "This session is being continued from a previous conversation.\nSummary:\nсуть"), isCompactSummary: true };
    const f = withHistory(fold(bound, sum), [sum]);
    expect(f.items.filter((i) => i.kind === "sys")).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ sys: { type: "compact", pre: 90_000, summary: "суть" } });
  });
});

describe("фокус", () => {
  it("6213 · ход: сообщение, сводка шагов, вопрос на виду, итоговый текст, строка итога", () => {
    const f = fold(
      user("u1", "Почини"),
      tool("a1", "t1"),
      tool("a2", "t2"),
      asst("a3", [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: {} }]),
      asst("a4", [{ type: "text", text: "Готово" }]),
      { type: "result", uuid: "z1", subtype: "success" },
    );
    const rows = focusRows(f.items, f.tools);
    expect(rows.map((r) => ("steps" in r ? "steps" : r.item.kind))).toEqual(["user", "steps", "assistant", "assistant", "sys"]);
    expect(rows[1]).toMatchObject({ steps: { tools: { Bash: 2 } } });
    expect(rows[2]).toMatchObject({ item: { parts: [{ kind: "tool", id: "t3" }] } });
    expect(rows[3]).toMatchObject({ item: { parts: [{ kind: "text", text: "Готово" }] } });
  });
});

describe("разбор текста", () => {
  it("6214 · сообщения не от человека: тег флота, обёртка субагента, peer", () => {
    expect(peerOf('<fleet-message from="a@b">\nпривет\n</fleet-message>', undefined)).toEqual({ text: "привет", from: { kind: "session", name: "a@b" } });
    expect(peerOf('<agent-message from-name="Explore">\nнашёл\n</agent-message>', undefined)).toMatchObject({ text: "нашёл", from: { kind: "agent", name: "Explore" } });
    expect(peerOf("текст", { kind: "peer", name: "c@d", fromMode: "plan" })).toMatchObject({ from: { kind: "session", name: "c@d", mode: "plan" } });
    expect(peerOf("обычное сообщение", undefined)).toBeNull();
  });

  it("6215 · служебный текст и сводка", () => {
    expect(specialOf("обычное")).toBeNull();
    expect(specialOf("<task-notification><task-id>k</task-id><status>failed</status></task-notification>")).toEqual({ kind: "task", id: "k", status: "failed", summary: undefined });
    expect(summaryOf("<system-reminder>x</system-reminder>This session is being continued from a previous conversation.\nSummary:\nсуть\nContinue the conversation from where it left off")).toBe("суть");
    expect(isHtmlDocument("  <!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlDocument("Текст с <b>тегом</b>")).toBe(false);
  });
});
