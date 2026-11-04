// Свёртка → карточка: сообщение SDK на входе, на выходе — что видно в ленте. Настоящая свёртка и настоящие карточки, без стенда.
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemView } from "../src/cards/ItemView.tsx";
import { CardsCtx, type CardsView } from "../src/context.ts";
import { applyEvents, emptyFeed } from "../src/state/feed.ts";
import type { Feed } from "../src/state/types.ts";
import type { WireMessage } from "../src/state/wire.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

function View({ feed }: { feed: Feed }) {
  const view: CardsView = { useFeed: (select) => select(feed), useAsking: () => false, name: "site@laptop", wide: true, background: () => {}, stopTask: () => {} };
  return (
    <CardsCtx.Provider value={view}>
      {feed.items.map((it) => (
        <ItemView key={it.id} it={it} />
      ))}
    </CardsCtx.Provider>
  );
}

async function draw(msgs: WireMessage[], start = emptyFeed()) {
  const feed = applyEvents(start, msgs);
  document.body.innerHTML = '<div id="r"></div>';
  const el = document.getElementById("r")!;
  await act(async () => root?.unmount());
  root = createRoot(el);
  await act(async () => root!.render(<View feed={feed} />));
  const open = async (sel: string) => act(async () => el.querySelector<HTMLElement>(sel)!.click());
  return { el, feed, open, text: () => el.textContent ?? "" };
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
});

let n = 0;
const uid = () => `w${++n}`;
const asst = (content: unknown[], x: Partial<WireMessage> = {}, id = uid()): WireMessage => ({ type: "assistant", uuid: uid(), message: { id, model: "claude-opus-5-5", content: content as never }, ...x });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}, x: Partial<WireMessage> = {}) => asst([{ type: "tool_use", id, name, input }], x);
const res = (id: string, content: unknown = "вывод", is_error = false, x: Partial<WireMessage> = {}): WireMessage => ({ type: "user", uuid: uid(), message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] as never }, ...x });
const user = (content: unknown, x: Partial<WireMessage> = {}): WireMessage => ({ type: "user", uuid: uid(), message: { content: content as never }, ...x });
const sys = (subtype: string, x: Partial<WireMessage> = {}): WireMessage => ({ type: "system", subtype, uuid: uid(), ...x });
const start = (id: string, x: Partial<WireMessage> = {}): WireMessage => ({ type: "stream_event", event: { type: "message_start", message: { id } }, ...x });
const delta = (d: Record<string, string>, x: Partial<WireMessage> = {}): WireMessage => ({ type: "stream_event", event: { type: "content_block_delta", delta: d }, ...x });
const textD = (text: string, x: Partial<WireMessage> = {}) => delta({ type: "text_delta", text }, x);
const thinkD = (thinking: string) => delta({ type: "thinking_delta", thinking });

describe("frame-session-events-stream", () => {
  it("6600 · текст растёт кусочками", async () => {
    const t = await draw([start("m1"), textD("Сбор"), textD("ка")]);
    expect(t.feed.items).toHaveLength(1);
    expect(t.el.querySelectorAll(".chat-txt")).toHaveLength(1);
    expect(t.el.querySelector(".chat-txt")!.textContent).toBe("Сборка");
    expect(t.el.querySelector(".md.caret")).not.toBeNull();
  });

  it("6601 · размышление идёт и заканчивается", async () => {
    const live = await draw([start("m1"), thinkD("думаю о таймауте")]);
    expect(live.text()).toContain("Размышляет…");
    expect(live.text()).toContain("думаю о таймауте");
    const done = await draw([asst([{ type: "thinking", thinking: "весь **текст**" }], {}, "m1")], live.feed);
    expect(done.text()).toContain("Размышлял");
    expect(done.text()).not.toContain("Размышляет");
    expect(done.text()).not.toContain("весь");
    await done.open(".chat-think .dis-h");
    expect(done.el.querySelector(".chat-think strong")!.textContent).toBe("текст");
  });

  it("6602 · кусочек без начала сообщения", async () => {
    const t = await draw([textD("ничей")]);
    expect(t.feed.items).toHaveLength(0);
  });

  it("6603 · второе сообщение хода — своя запись", async () => {
    const first = await draw([toolUse("t1", "Bash")]);
    const was = first.feed.items[0];
    const t = await draw([start("m2"), textD("дальше")], first.feed);
    expect(t.feed.items).toHaveLength(2);
    expect(t.feed.items[0]).toBe(was);
    expect(t.el.querySelector(".md.caret")!.textContent).toBe("дальше");
  });

  it("6604 · размышление, затем текст одного сообщения", async () => {
    const t = await draw([start("m1"), thinkD("ду"), asst([{ type: "thinking", thinking: "думал" }], {}, "m1"), textD("отв"), asst([{ type: "text", text: "ответ" }], {}, "m1")]);
    expect(t.feed.items).toHaveLength(1);
    expect((t.feed.items[0] as { parts: unknown[] }).parts).toEqual([{ kind: "think", text: "думал" }, { kind: "text", text: "ответ" }]);
    expect(t.el.querySelector(".caret")).toBeNull();
  });

  it("6605 · размышление скрыто", async () => {
    const t = await draw([asst([{ type: "redacted_thinking" }, { type: "text", text: "ответ" }])]);
    expect(t.text()).toContain("Размышлял");
    expect(t.el.querySelector(".chat-think .dis-h")).toBeNull();
    expect(t.el.querySelector(".chat-txt")!.textContent).toBe("ответ");
  });

  it("6606 · кусочки субагента", async () => {
    const x = { parent_tool_use_id: "t1" };
    const live = await draw([toolUse("t1", "Agent", { prompt: "ищи" }), start("m2", x), textD("шаг идёт", x)]);
    expect(live.feed.items).toHaveLength(1);
    expect(live.el.querySelector(".tb-steps .md.caret")!.textContent).toBe("шаг идёт");
    const done = await draw([asst([{ type: "text", text: "шаг готов" }], x, "m2")], live.feed);
    expect(done.feed.items).toHaveLength(1);
    expect(done.el.querySelector(".tb-steps .chat-txt")!.textContent).toBe("шаг готов");
    expect(done.el.querySelector(".caret")).toBeNull();
  });

  it("6607 · кусочки входа инструмента не рисуются", async () => {
    const t = await draw([start("m1"), delta({ type: "input_json_delta", partial_json: "{" }), delta({ type: "signature_delta", signature: "x" })]);
    expect(t.feed.items).toHaveLength(0);
  });

  it("6608 · ход кончился без готового блока", async () => {
    const t = await draw([start("m1"), thinkD("ду"), textD("начал"), { type: "result", uuid: uid(), subtype: "success" }]);
    expect(t.text()).not.toContain("Размышляет");
    expect(t.el.querySelector(".caret")).toBeNull();
    expect(t.text()).toContain("начал");
  });
});

describe("frame-session-events-tools", () => {
  it("6609 · итог с картинкой", async () => {
    const t = await draw([toolUse("t1", "Grep", { pattern: "x" }), res("t1", [{ type: "text", text: "снимок" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }])]);
    await t.open(".tc-h");
    expect(t.el.querySelector(".tb-pre")!.textContent).toBe("снимок");
    expect(t.el.querySelector<HTMLImageElement>(".tb-img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("6610 · ошибка инструмента", async () => {
    const t = await draw([toolUse("t1", "Bash", { command: "npm run gate" }), res("t1", "нет зависимости", true)]);
    expect(t.el.querySelector(".chat-tool")!.getAttribute("data-state")).toBe("error");
    expect(t.el.querySelector(".tc-st")!.textContent).toBe("ошибка");
    await t.open(".tc-h");
    expect(t.el.querySelector(".tb-pre.bad")!.textContent).toBe("нет зависимости");
  });

  it("6611 · отказ человека", async () => {
    const t = await draw([toolUse("t1", "Bash"), res("t1", "The user doesn't want to proceed with this tool use.", true)]);
    expect(t.el.querySelector(".chat-tool")!.getAttribute("data-state")).toBe("denied");
    expect(t.el.querySelector(".tc-st")!.textContent).toBe("отклонено");
  });

  it("6612 · шаги субагента", async () => {
    const x = { parent_tool_use_id: "t1" };
    const t = await draw([toolUse("t1", "Agent", { description: "ищет", prompt: "найди таймауты" }), toolUse("t2", "Grep", { pattern: "timeout" }, x)]);
    expect(t.feed.items).toHaveLength(1);
    expect(t.el.querySelector(".tb-steps .chat-tool")!.getAttribute("data-tool")).toBe("Grep");
    expect(t.text()).not.toContain("найди таймауты");
    await t.open(".tb-agent .dis-h");
    expect(t.text()).toContain("найди таймауты");
    const done = await draw([res("t1", "Нашёл **три**")], t.feed);
    await done.open(".tc-h");
    expect(done.el.querySelector(".tb-final strong")!.textContent).toBe("три");
  });

  it("6613 · сводка шагов", async () => {
    const t = await draw([toolUse("t1", "Read"), { type: "tool_use_summary", uuid: uid(), summary: "Прочитал конфиг", preceding_tool_use_ids: ["t1"] }]);
    expect(t.el.querySelector(".tc-note")!.textContent).toBe("Прочитал конфиг");
  });

  it("6614 · итог раньше вызова", async () => {
    const t = await draw([res("t1", "вывод"), toolUse("t1", "Bash")]);
    expect(t.el.querySelector(".chat-tool")!.getAttribute("data-state")).toBe("ok");
  });

  it("6615 · итог шага субагента", async () => {
    const x = { parent_tool_use_id: "t1" };
    const t = await draw([toolUse("t1", "Agent"), toolUse("t2", "Bash", {}, x), res("t2", "ok", false, x)]);
    expect(t.el.querySelector(".tb-steps .chat-tool")!.getAttribute("data-state")).toBe("ok");
    expect(t.el.querySelector(".chat-me")).toBeNull();
  });

  it("6616 · субагент ушёл в фон", async () => {
    const running = await draw([toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1", task_type: "local_agent", is_backgrounded: true }), res("t1", "Async agent launched")]);
    expect(running.el.querySelector(".chat-tool")!.getAttribute("data-state")).toBe("bg");
    expect(running.text()).not.toContain("launched");
    const done = await draw([sys("task_notification", { task_id: "k", status: "completed", summary: "Готово: три теста" })], running.feed);
    await done.open(".tc-h");
    expect(done.el.querySelector(".tb-final")!.textContent).toBe("Готово: три теста");
  });

  it("6617 · шаг субагента без карточки", async () => {
    const t = await draw([asst([{ type: "text", text: "шаг" }], { parent_tool_use_id: "нет" })]);
    expect(t.feed.items).toHaveLength(1);
    expect(t.el.querySelector(".chat-txt")!.textContent).toBe("шаг");
    const none = await draw([{ type: "tool_progress", tool_use_id: "нет", elapsed_time_seconds: 3 }, { type: "tool_use_summary", uuid: uid(), summary: "x", preceding_tool_use_ids: ["нет"] }]);
    expect(none.feed.items).toHaveLength(0);
    expect(none.feed.tools).toEqual({});
  });

  it("6618 · инструмент сервера", async () => {
    const t = await draw([asst([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "react" } }])]);
    expect(t.el.querySelector(".tc-h b")!.textContent).toBe("web_search");
  });
});

describe("frame-session-events-user", () => {
  it("6619 · реплика с картинкой", async () => {
    const t = await draw([user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "снимок" }])]);
    expect(t.el.querySelector(".chat-me img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(t.el.querySelector(".chat-me")!.textContent).toContain("снимок");
  });

  it("6620 · сообщение другой сессии", async () => {
    const t = await draw([user('<fleet-message from="poe-bot@pc">\nСобрано\n</fleet-message>'), user('<agent-message from-name="Explore">\nНашёл\n</agent-message>')]);
    const [a, b] = t.el.querySelectorAll(".chat-in");
    expect(a.textContent).toContain("сессия Claude · poe-bot@pc");
    expect(a.textContent).toContain("Собрано");
    expect(a.textContent).not.toContain("fleet-message");
    expect(b.textContent).toContain("субагент · Explore");
    const long = await draw([user("слово ".repeat(200), { origin: { kind: "peer", name: "a@b" } })]);
    expect(long.el.querySelector(".chat-clamp")).not.toBeNull();
    await long.open(".chat-more");
    expect(long.el.querySelector(".chat-clamp")).toBeNull();
  });

  it("6621 · вывод раньше имени команды", async () => {
    const t = await draw([sys("local_command_output", { content: "сжато" }), user("<command-name>/compact</command-name>")]);
    expect(t.feed.items).toHaveLength(1);
    expect(t.el.querySelector(".chat-cmd")!.textContent).toBe("/compactсжато");
  });

  it("6622 · служебное скрыто", async () => {
    const t = await draw([user("<system-reminder>x</system-reminder>"), user("Caveat: x"), user("синтетика", { isSynthetic: true }), user("мета", { isMeta: true }), user("задание", { parent_tool_use_id: "t" })]);
    expect(t.feed.items).toHaveLength(0);
  });

  it("6623 · своя слэш-команда", async () => {
    const t = await draw([user("/compact"), user("<command-name>/compact</command-name>")]);
    expect(t.el.querySelector(".chat-me")).toBeNull();
    expect(t.el.querySelectorAll(".chat-cmd")).toHaveLength(1);
  });

  it("6624 · вывод без команды", async () => {
    const t = await draw([sys("local_command_output", { content: "Set model" }), user("<local-command-stdout>Done</local-command-stdout>")]);
    expect(t.el.querySelector(".chat-cmd")).toBeNull();
    expect(t.text()).toContain("Set model");
    expect(t.text()).toContain("Done");
  });

  it("6625 · служебное от другой сессии показано", async () => {
    const t = await draw([user('<agent-message from-name="Explore">\nНашёл\n</agent-message>', { isSynthetic: true }), user('<fleet-message from="a@b">\nПривет\n</fleet-message>', { isSynthetic: true })]);
    expect(t.el.querySelectorAll(".chat-in")).toHaveLength(2);
  });
});

describe("frame-session-events-system", () => {
  it("6626 · итог хода", async () => {
    const t = await draw([{ type: "result", uuid: uid(), subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41, usage: { input_tokens: 1000, cache_read_input_tokens: 45_000 } }]);
    expect(t.el.querySelector(".chat-res")!.textContent).toBe("ход закончен · 2 мин 14 с · 6 шагов · $0,41 · 46 К в контексте");
  });

  it("6627 · ход оборвался", async () => {
    const t = await draw([{ type: "result", uuid: uid(), subtype: "error_during_execution", is_error: true, errors: ["процесс упал"] }]);
    expect(t.el.querySelector(".chat-res.err")!.textContent).toContain("ход оборвался: сбой при выполнении");
    expect(t.el.querySelector(".chat-res.err p")!.textContent).toBe("процесс упал");
    const ok = await draw([{ type: "result", uuid: uid(), subtype: "success", is_error: true, result: "API упал" }]);
    expect(ok.el.querySelector(".chat-res.err p")!.textContent).toBe("API упал");
  });

  it("6628 · лимит", async () => {
    const t = await draw([{ type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000 } }, { type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }, { type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "allowed" } }]);
    const [a, b] = t.el.querySelectorAll(".chat-ban");
    expect(t.el.querySelectorAll(".chat-ban")).toHaveLength(2);
    expect(a.textContent).toContain("Лимит подписки скоро кончится");
    expect(a.textContent).toContain("5 ч, сброс в");
    expect(b.textContent).toContain("Лимит подписки исчерпаннеделя");
  });

  it("6629 · отказ модели, переписано", async () => {
    const answer = asst([{ type: "text", text: "начал" }]);
    const t = await draw([answer, sys("model_refusal_fallback", { retracted_message_uuids: [answer.uuid!], original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", api_refusal_category: "cyber" })]);
    expect(t.text()).not.toContain("начал");
    expect(t.el.querySelector(".chat-ban.wait")!.textContent).toContain("Fable 5.1 отказалась — ответ переписан моделью Opus 5.5");
    expect(t.text()).toContain("Дальше сессия идёт на Opus 5.5");
    const local = await draw([sys("model_refusal_fallback", { original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", scope: "local" })]);
    expect(local.text()).toContain("Только этот ответ: модель сессии прежняя");
  });

  it("6630 · запасная модель и смена модели", async () => {
    const t = await draw([sys("model_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", trigger: "overloaded" }), asst([{ type: "text", text: "x" }]), sys("init", { model: "claude-sonnet-5-5" })]);
    expect(t.el.querySelector(".chat-ban.wait")!.textContent).toBe("Opus 5.5 перегружена — этот ход отвечает Sonnet 5.5");
    expect(t.el.querySelector(".chat-sys")!.textContent).toBe("модель: Opus 5.5 → Sonnet 5.5");
    const same = await draw([sys("init", { model: "claude-x" }), asst([{ type: "text", text: "x" }], {}), sys("init", { model: "claude-opus-5-5[1m]" })]);
    expect(same.el.querySelector(".chat-sys")).toBeNull();
  });

  it("6631 · хук упал", async () => {
    const t = await draw([sys("hook_response", { hook_name: "fmt", exit_code: 2, stderr: "не найден" }), sys("hook_response", { hook_name: "ok", exit_code: 0 })]);
    expect(t.feed.items).toHaveLength(1);
    expect(t.el.querySelector(".chat-line.wait")!.textContent).toBe("Хук fmt не сработал (код 2): не найден");
  });

  it("6632 · прочие строки", async () => {
    const t = await draw([sys("memory_recall", { memories: [{ path: "m/backlog.md" }] }), sys("informational", { content: "заметка" }), sys("notification", { text: "вход истекает", priority: "high" }), sys("permission_denied", { tool_name: "Bash", message: "запрещено" }), sys("files_persisted", { files: [{ filename: "a.pdf" }], failed: [] }), { type: "conversation_reset", uuid: uid() }]);
    expect(t.feed.items).toHaveLength(6);
    expect(t.text()).toContain("Из памяти: backlog.md");
    expect(t.text()).toContain("заметка");
    expect(t.el.querySelector(".chat-ban.wait")!.textContent).toBe("вход истекает");
    expect(t.text()).toContain("Отклонено правилами: Bash — запрещено");
    expect(t.text()).toContain("Файлы сохранены: a.pdf");
    expect(t.text()).toContain("разговор начат заново");
  });

  it("6633 · ошибка ответа claude", async () => {
    const t = await draw([asst([], { error: "overloaded" }), asst([], { error: "oauth_org_not_allowed" }), { type: "auth_status", uuid: uid(), error: "вход истёк" }, sys("mirror_error", { error: "зеркало упало" }), sys("plugin_install", { status: "failed", name: "p", error: "нет сети" })]);
    const bans = [...t.el.querySelectorAll(".chat-ban.bad")].map((x) => x.textContent);
    expect(bans).toEqual(["ОшибкаСерверы Anthropic перегружены", "Ошибкаoauth_org_not_allowed", "Ошибкавход истёк", "Ошибказеркало упало", "ОшибкаПлагин не установился (p): нет сети"]);
  });

  it("6634 · незнакомое сообщение", async () => {
    const t = await draw([{ type: "из будущего", uuid: uid() }, sys("commands_changed"), sys("hook_started"), sys("worker_shutting_down"), sys("plugin_install", { status: "installed" })]);
    expect(t.feed.items).toHaveLength(0);
  });

  it("6635 · сжатие не вышло", async () => {
    const t = await draw([sys("status", { status: "compacting" })]);
    expect(t.feed.compacting).toBe(true);
    const f = await draw([sys("status", { status: null as never, compact_result: "failed", compact_error: "нет места" })], t.feed);
    expect(f.feed.compacting).toBe(false);
    expect(f.el.querySelector(".chat-ban.bad")!.textContent).toBe("ОшибкаСжать контекст не вышло: нет места");
  });

  it("6636 · стоимость после перезапуска процесса", async () => {
    const res2 = (total: number): WireMessage => ({ type: "result", uuid: uid(), subtype: "success", total_cost_usd: total });
    const t = await draw([res2(7), res2(1), res2(1.5)]);
    expect([...t.el.querySelectorAll(".chat-res")].map((x) => x.textContent)).toEqual(["ход закончен · $7,00", "ход закончен · $1,00", "ход закончен · $0,50"]);
  });

  it("6637 · ошибка и отказ субагента", async () => {
    const x = { parent_tool_use_id: "t1" };
    const t = await draw([toolUse("t1", "Agent"), asst([{ type: "text", text: "шаг упал" }], { ...x, error: "overloaded" }), { type: "assistant", uuid: uid(), parent_tool_use_id: "t1", isApiErrorMessage: true, error: "x", message: { stop_reason: "refusal", content: [] } }]);
    expect(t.el.querySelector(".chat-ban")).toBeNull();
    expect(t.el.querySelector(".tb-steps .chat-txt")!.textContent).toBe("шаг упал");
  });

  it("6638 · файлы не сохранились", async () => {
    const t = await draw([sys("files_persisted", { files: [{ filename: "a.pdf" }], failed: [{ filename: "b.pdf", error: "нет места" }] })]);
    expect(t.el.querySelector(".chat-line.bad")!.textContent).toBe("Файлы сохранены: a.pdf · Не сохранились: b.pdf: нет места");
  });

  it("6639 · записи файла разговора", async () => {
    const answer = asst([{ type: "text", text: "начал" }]);
    const u = user("вопрос");
    const t = await draw([sys("compact_boundary", { compactMetadata: { preTokens: 90_000, postTokens: 8000 } }), answer, sys("model_refusal_fallback", { originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-5-5", retractedMessageUuids: [answer.uuid!] }), u, sys("model_refusal_no_fallback", { refusedUserMessageUuid: u.uuid, originalModel: "claude-opus-5-5" })]);
    expect(t.text()).toContain("контекст сжат · 90 К → 8 К");
    expect(t.text()).not.toContain("начал");
    expect(t.text()).toContain("Fable 5.1 отказалась — ответ переписан моделью Opus 5.5");
    expect(t.feed.items.at(-1)).toMatchObject({ sys: { type: "refusal", ask: "вопрос" } });
  });
});

describe("frame-session-events-tasks", () => {
  it("6640 · задача у вызова инструмента", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const pending = draw([toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1", task_type: "local_agent" }), sys("task_progress", { task_id: "k", summary: "читает README", usage: { tool_uses: 3 } })]);
    await vi.advanceTimersByTimeAsync(0);
    const t = await pending;
    expect(t.el.querySelector(".tc-bar")!.textContent).toContain("идёт 0 с · читает README · шагов 3");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(t.el.querySelector(".tc-bar")!.textContent).toContain("идёт 2 с");
  });

  it("6641 · задача без вызова", async () => {
    const t = await draw([sys("task_started", { task_id: "k", description: "ищет", task_type: "local_agent" }), sys("task_progress", { task_id: "k", usage: { tool_uses: 2 } })]);
    expect(t.el.querySelector(".chat-line.run")!.textContent).toBe("ищет2 шагаСтоп");
  });

  it("6642 · задача у вызова кончилась", async () => {
    const t = await draw([toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1" }), sys("task_notification", { task_id: "k", status: "completed" }), res("t1", "ok")]);
    expect(t.el.querySelector(".tc-bar")).toBeNull();
    expect(t.feed.items).toHaveLength(1);
  });

  it("6643 · задача без вызова кончилась", async () => {
    const plain = await draw([sys("task_started", { task_id: "k", description: "ищет" }), sys("task_notification", { task_id: "k", status: "completed" })]);
    expect(plain.feed.items).toHaveLength(1);
    expect(plain.el.querySelector(".chat-line.ok")!.textContent).toBe("Задача завершена · ищет");
    expect(plain.text()).not.toContain("Стоп");
    const bg = await draw([sys("task_started", { task_id: "b", description: "сборка", is_backgrounded: true }), sys("task_notification", { task_id: "b", status: "completed" })]);
    expect(bg.feed.items).toHaveLength(1);
  });

  it("6644 · фоновая упала или остановлена", async () => {
    const bg = (id: string, tu: string, status: string) => [toolUse(tu, "Bash"), sys("task_started", { task_id: id, tool_use_id: tu, description: id, is_backgrounded: true }), sys("task_notification", { task_id: id, status })];
    const t = await draw([...bg("a", "t1", "failed"), ...bg("b", "t2", "stopped")]);
    expect(t.el.querySelector(".chat-line.bad")!.textContent).toBe("Задача упала · a");
    expect(t.el.querySelector(".chat-line.wait")!.textContent).toBe("Задача остановлена · b");
    expect(t.el.querySelector('[data-state="stopped"] .tc-st')!.textContent).toBe("остановлено");
  });

  it("6645 · конец задачи текстом разговора", async () => {
    const note = "<task-notification><task-id>k</task-id><status>failed</status><summary>сборка упала</summary></task-notification>";
    const t = await draw([user(note)]);
    expect(t.el.querySelector(".chat-me")).toBeNull();
    expect(t.el.querySelector(".chat-line.bad")!.textContent).toBe("Задача упала · сборка упала");
    const origin = await draw([user(note, { origin: { kind: "task-notification" } })]);
    expect(origin.feed.items).toHaveLength(1);
    const once = await draw([sys("task_started", { task_id: "k", tool_use_id: "x", is_backgrounded: true }), sys("task_notification", { task_id: "k", status: "failed" }), user(note)]);
    expect(once.feed.items).toHaveLength(1);
  });
});
