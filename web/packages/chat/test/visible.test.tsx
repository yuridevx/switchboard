// Что видит человек сверх лесов границы: слова, значки, порядок и правила показа. Источник свойств — поведение кода до сноса (чьё: код).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, stand } from "../../core/stand/app.ts";
import { chat, open, parts, relayFor, roster, set } from "./stand.ts";

const BUSY = "site@laptop";
const ASKING = "profiles@laptop";
const IDLE = "poe-bot@pc";

vi.setConfig({ testTimeout: 20_000 });

type Msg = Record<string, unknown>;
let n = 0;
const uid = () => `v${++n}`;
const sys = (subtype: string, x: Msg = {}): Msg => ({ type: "system", subtype, uuid: uid(), ...x });
const say = (content: unknown[], x: Msg = {}, message: Msg = {}): Msg => ({ type: "assistant", uuid: uid(), message: { id: uid(), model: "claude-opus-5-5", content, ...message }, ...x });
const human = (content: unknown, x: Msg = {}): Msg => ({ type: "user", uuid: uid(), message: { content }, ...x });
const toolUse = (id: string, name: string, input: unknown = {}) => say([{ type: "tool_use", id, name, input }]);
const res = (id: string, content: unknown = "вывод", is_error = false): Msg => ({ type: "user", uuid: uid(), message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Экран с лентой из пачки сообщений. */
async function feed(msgs: Msg[], cs = IDLE, wide = false) {
  const t = await chat(cs, { wide });
  await t.events(cs, msgs, 1);
  return { ...t, feedText: () => t.$(".chat-feed")!.textContent ?? "", q: (s: string) => t.$(".chat-feed")!.querySelector<HTMLElement>(s) };
}

describe("строки ленты", () => {
  it.each([
    ["authentication_failed", "Вход в claude не действует"],
    ["billing_error", "Проблема с оплатой подписки"],
    ["rate_limit", "Лимит подписки исчерпан"],
    ["overloaded", "Серверы Anthropic перегружены"],
    ["server_error", "Ошибка сервера Anthropic"],
    ["invalid_request", "Запрос отклонён API"],
    ["model_not_found", "Модель не найдена"],
    ["max_output_tokens", "Ответ упёрся в предел длины"],
    ["account_on_hold", "Аккаунт приостановлен"],
    ["unknown", "Неизвестная ошибка API"],
    ["новая_ошибка", "новая_ошибка"],
  ])("ошибка ответа %s — словом, текст ответа остаётся", async (error, word) => {
    const f = await feed([say([{ type: "text", text: "начало ответа" }], { error, isApiErrorMessage: true })]);
    expect(f.q(".chat-ban.bad")!.textContent).toContain(word);
    expect(f.feedText()).toContain("начало ответа");
  });

  it.each([
    ["weapons", "Область: оружие"],
    ["self_harm", "Область: самоповреждение"],
    ["chem", "Область: химия"],
    ["other", "Область: other"],
  ])("отказ модели, область %s: без точки в конце, значок щита", async (category, line) => {
    const f = await feed([say([], { isApiErrorMessage: true }, { stop_reason: "refusal", stop_details: { category } })]);
    expect(f.q(".chat-ban.bad p")!.textContent).toBe(line);
    expect(f.q(".chat-ban.bad svg.lucide-shield-off")).not.toBeNull();
  });

  it("стоп-причина refusal без ошибки — обычный ответ, плашки нет", async () => {
    const f = await feed([say([{ type: "text", text: "ответ" }], {}, { stop_reason: "refusal" })]);
    expect(f.q(".chat-ban")).toBeNull();
    expect(f.feedText()).toContain("ответ");
  });

  it("запасная модель при отказе: область в теле, точка после условия", async () => {
    const f = await feed([sys("model_refusal_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", scope: "local", api_refusal_category: "bio", api_refusal_explanation: "почему" })]);
    expect(f.q(".chat-ban.wait p")!.textContent).toBe("Только этот ответ: модель сессии прежняя. Область: биология и химия. почему");
  });

  it.each([
    ["model_not_found", "Opus 5.5 недоступна — этот ход отвечает Sonnet 5.5"],
    ["permission_denied", "Opus 5.5 недоступна организации — этот ход отвечает Sonnet 5.5"],
    ["overloaded", "Opus 5.5 перегружена — этот ход отвечает Sonnet 5.5"],
    ["server_error", "Opus 5.5 не ответила (сбой сервера) — этот ход отвечает Sonnet 5.5"],
    ["last_resort", "Opus 5.5 не ответила (ошибка) — этот ход отвечает Sonnet 5.5"],
    ["model_blocked", "Opus 5.5 временно отключена — этот ход отвечает Sonnet 5.5"],
    ["другое", "Opus 5.5 не ответила — этот ход отвечает Sonnet 5.5"],
  ])("запасная модель, причина %s", async (trigger, title) => {
    const f = await feed([sys("model_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", trigger })]);
    expect(f.q(".chat-ban.wait b")!.textContent).toBe(title);
  });

  it.each([
    [{ subtype: "error_during_execution" }, "ход оборвался: сбой при выполнении"],
    [{ subtype: "error_max_turns" }, "ход оборвался: предел шагов"],
    [{ subtype: "error_max_budget_usd" }, "ход оборвался: предел бюджета"],
    [{ subtype: "error_max_structured_output_retries" }, "ход оборвался: предел повторов ответа"],
    [{ subtype: "error_новый" }, "ход оборвался: error_новый"],
    [{}, "ход оборвался: ошибка"],
    [{ subtype: "success", is_error: true }, "ход оборвался: success"],
  ])("конец хода с ошибкой %j", async (x, line) => {
    const f = await feed([{ type: "result", uuid: uid(), is_error: true, ...x }]);
    expect(f.q(".chat-res.err")!.textContent).toBe(line);
  });

  it("причина конца хода: result, иначе ошибки через точку с запятой; прерванный ход молчит", async () => {
    const a = await feed([{ type: "result", uuid: uid(), subtype: "error_max_turns", is_error: true, errors: ["раз", "два"] }]);
    expect(a.q(".chat-res.err p")!.textContent).toBe("раз; два");
    const b = await feed([{ type: "result", uuid: uid(), subtype: "error_max_turns", is_error: true, result: "итог" }]);
    expect(b.q(".chat-res.err p")!.textContent).toBe("итог");
    const c = await feed([human("[Request interrupted by user]"), { type: "result", uuid: uid(), subtype: "error_during_execution", is_error: true, errors: ["сбой"] }]);
    expect(c.q(".chat-res")).toBeNull();
  });

  it("контекст в итоге хода и в сжатии — целыми тысячами", async () => {
    const f = await feed([{ type: "result", uuid: uid(), subtype: "success", usage: { input_tokens: 1500 } }, sys("compact_boundary", { compact_metadata: { pre_tokens: 84200, post_tokens: 1500 } })]);
    expect(f.q(".chat-res")!.textContent).toBe("ход закончен · 2 К в контексте");
    expect(f.q(".chat-res .chat-nb")).not.toBeNull();
    expect(f.q(".chat-sys svg.lucide-archive")).not.toBeNull();
    expect(f.feedText()).toContain("контекст сжат · 84 К → 2 К");
  });

  it("повтор запроса: попытка, ошибка и задержка; подряд — одна строка", async () => {
    const f = await feed([sys("api_retry", { attempt: 1, max_retries: 3, error_status: 529, retry_delay_ms: 2000 }), sys("api_retry", { attempt: 2, max_retries: 3, error: "overloaded", retry_delay_ms: 4000 })]);
    const rows = [...f.$$(".chat-feed .chat-sys")].filter((r) => r.textContent?.includes("повтор"));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe("повтор запроса к API · 2 из 3 · overloaded · через\u00a04\u00a0с");
    expect(rows[0].classList.contains("wait")).toBe(true);
    expect(rows[0].querySelector("svg.lucide-refresh-cw")).not.toBeNull();
  });

  it("прерывание — со временем сообщения", async () => {
    const f = await feed([human("[Request interrupted by user]", { timestamp: "2026-11-04T10:20:00" })]);
    expect(f.q(".chat-sys.wait")!.textContent).toBe("прервано · 10:20");
  });

  it("лимит подписки: всегда жёлтая плашка, окно и сброс", async () => {
    const f = await feed([{ type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus", resetsAt: 1 } }]);
    expect(f.q(".chat-ban.wait b")!.textContent).toBe("Лимит подписки исчерпан");
    expect(f.q(".chat-ban.wait p")!.textContent).toMatch(/^неделя opus, сброс в \d\d:\d\d$/);
    const g = await feed([{ type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "allowed_warning" } }]);
    expect(g.q(".chat-ban.wait b")!.textContent).toBe("Лимит подписки скоро кончится");
    expect(g.q(".chat-ban.wait p")).toBeNull();
  });

  it("сведения: предупреждение и важное уведомление — плашка, остальное — строка", async () => {
    const f = await feed([sys("informational", { content: "заметка" }), sys("informational", { content: "осторожно", level: "warning" }), sys("notification", { text: "просто", priority: "low" }), sys("notification", { text: "срочно", priority: "immediate" })]);
    expect([...f.$$(".chat-feed .chat-line")].map((x) => x.textContent)).toEqual(["заметка", "просто"]);
    expect([...f.$$(".chat-feed .chat-ban.wait b")].map((x) => x.textContent)).toEqual(["осторожно", "срочно"]);
  });

  it("хук: упал по исходу или коду, причина обрезана; удачный не виден", async () => {
    const f = await feed([sys("hook_response", { outcome: "error", hook_name: "lint", output: "x".repeat(400) }), sys("hook_response", { hook_name: "ok", exit_code: 0 })]);
    const line = f.q(".chat-line.wait")!;
    expect(line.textContent).toBe(`Хук lint не сработал: ${"x".repeat(300)}`);
    expect(line.querySelector(".chat-dim")).not.toBeNull();
    expect(f.feedText()).not.toContain("Хук ok");
  });

  it("память: имя файла и из пути Windows; пустой список молчит", async () => {
    const f = await feed([sys("memory_recall", { memories: [{ path: "C:\\m\\a.md" }] }), sys("memory_recall", { memories: [] })]);
    expect([...f.$$(".chat-feed .chat-line")].map((x) => x.textContent)).toEqual(["Из памяти: a.md"]);
  });

  it("ошибки служб без подробностей — без хвоста", async () => {
    const f = await feed([sys("status", { compact_result: "failed" }), sys("plugin_install", { status: "failed" }), sys("mirror_error", {})]);
    expect([...f.$$(".chat-feed .chat-ban p")].map((x) => x.textContent)).toEqual(["Сжать контекст не вышло", "Плагин не установился"]);
  });

  it("вывод локальной команды своим сообщением", async () => {
    const f = await feed([sys("local_command_output", { content: "  готово  " })]);
    expect(f.q(".chat-line")!.textContent).toBe("готово");
    expect(f.q(".chat-line svg.lucide-zap")).not.toBeNull();
  });

  it("вывод раньше имени команды — одна строка; свой пузырь команды исчезает", async () => {
    const f = await feed([sys("local_command_output", { content: "сжато" }), human("<command-name>/compact</command-name>")]);
    expect(f.q(".chat-cmd")!.textContent).toContain("/compact");
    expect(f.q(".chat-cmd pre")!.textContent).toBe("сжато");
    expect(f.$$(".chat-feed .chat-cmd")).toHaveLength(1);
  });

  it("имя команды без косой черты и из command-message; вывод stderr не показывается", async () => {
    const f = await feed([human("<command-message>foo</command-message>"), human("<local-command-stderr>сбой</local-command-stderr>")]);
    expect(f.q(".chat-cmd")!.textContent).toBe("/foo");
    expect(f.feedText()).not.toContain("сбой");
  });

  it("обычный текст с косой чертой — пузырь, а не команда", async () => {
    const f = await feed([human("/compact сейчас")]);
    expect(f.q(".chat-me")!.textContent).toContain("/compact сейчас");
    expect(f.q(".chat-cmd")).toBeNull();
  });

  it("задача без инструмента: идёт — 0 шагов, описание и сводка; оборвана — своим словом", async () => {
    const f = await feed([sys("task_started", { task_id: "t1", description: "сборка", task_type: "local_agent" }), sys("task_progress", { task_id: "t1", summary: "идёт тест" })]);
    expect(f.q(".chat-line.run span")!.textContent).toBe("сборка · идёт тест");
    expect(f.q(".chat-line.run em")!.textContent).toBe("0 шагов");
    expect(f.q(".chat-line.run svg.lucide-bot")).not.toBeNull();
    await f.events(IDLE, [sys("task_updated", { task_id: "t1", patch: { status: "killed" } })], 2);
    expect(f.q(".chat-line.wait")!.textContent).toBe("Задача оборвана · сборка");
  });

  it("ответ: пустой текст не часть, подряд размышления — одно, пустое размышление без раскрытия", async () => {
    const f = await feed([say([{ type: "text", text: "  " }, { type: "thinking", thinking: "" }, { type: "thinking", thinking: "" }])]);
    expect(f.$$(".chat-feed .chat-txt")).toHaveLength(0);
    expect(f.$$(".chat-feed .chat-think")).toHaveLength(1);
    expect(f.q(".chat-think .dis-h")).toBeNull();
    expect(f.q(".chat-think svg.lucide-brain-circuit")).not.toBeNull();
  });

  it("HTML-документ — код без обёртки текста; живое размышление — последние 400 символов", async () => {
    const f = await feed([say([{ type: "text", text: "<!doctype html><p>д</p>" }])]);
    expect(f.q(".chat-txt")).toBeNull();
    const g = await chat(IDLE);
    await g.events(IDLE, [{ type: "stream_event", event: { type: "message_start", message: { id: "m" } } }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "я".repeat(500) } } }], 1);
    expect(g.$(".chat-think-t")!.textContent).toHaveLength(400);
  });

  it("сводка сжатия: без служебных вставок и хвоста «продолжай»", async () => {
    const text = "This session is being continued from a previous conversation that ran out of context.\n<system-reminder>скрыто</system-reminder>\nSummary:\nСуть работы\nIf you need specific details from before compaction, read it";
    const f = await feed([sys("compact_boundary", { compact_metadata: { pre_tokens: 2000 } }), human(text, { isCompactSummary: true })]);
    await f.click(f.q(".chat-sum .dis-h"));
    expect(f.q(".chat-sum .dis-b")!.textContent).toBe("Суть работы");
  });

  it("сообщения сессий: режим отправителя, значок, длинное свёрнуто; владельцу не сворачивается", async () => {
    const f = await feed([human(`<cross-session-message from-name="tests" from-mode="plan">\n${"а".repeat(701)}\n</cross-session-message>`), human('<agent-message from-name="fix">\nготово\n</agent-message>'), human("текст", { origin: { kind: "peer", name: "сосед", fromMode: "default" } })]);
    const [long, agent, peer] = f.$$(".chat-feed .chat-in.fleet");
    expect(long.dataset.from).toBe("session");
    expect(long.querySelector(".chat-from")!.textContent).toBe("сессия Claude · testsРежим плана".replace("Режим плана", long.querySelector(".chat-tag")!.textContent!));
    expect(long.querySelector(".chat-clamp")).not.toBeNull();
    expect(long.querySelector(".chat-more")!.textContent).toBe("показать всё");
    expect(long.querySelector("svg.lucide-messages-square")).not.toBeNull();
    expect(agent.dataset.from).toBe("agent");
    expect(agent.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(peer.querySelector(".chat-tag")).toBeNull();
    f.relay.push({ type: "message", from: IDLE, to: "phone", text: "б\n".repeat(20) });
    await flush();
    expect(f.q(".chat-in:not(.fleet) .chat-clamp")).toBeNull();
  });

  it("картинка без данных или обрезанная не показывается; своя картинка — ссылкой с подписью", async () => {
    const f = await feed([human([{ type: "image", source: { type: "url", url: "http://x/y.png" } }, { type: "text", text: "а" }]), human([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AB…" } }, { type: "text", text: "б" }]), human([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "в" }])]);
    const imgs = f.$$<HTMLImageElement>(".chat-feed .chat-pics img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].alt).toBe("картинка 1");
    expect(imgs[0].parentElement!.tagName).toBe("A");
    expect(imgs[0].parentElement!.getAttribute("target")).toBe("_blank");
  });
});

describe("карточки инструментов", () => {
  it("значок и суть по виду; длинная строка обрезана, первая непустая", async () => {
    const f = await feed([toolUse("a", "Bash", { command: `\n${"x".repeat(200)}` }), toolUse("b", "Edit", { file_path: "a.ts", old_string: "x", new_string: "x" }), toolUse("c", "Skill", { command: "fix" }), toolUse("d", "Monitor", { command: "tail" }), toolUse("e", "Glob", { pattern: "*" }), toolUse("f", "ExitPlanMode", {}), toolUse("g", "Read", { file_path: "a", offset: 0 })]);
    const sum = (tool: string) => f.q(`[data-tool="${tool}"] .tc-sum`)!;
    expect(sum("Bash").textContent).toBe(`${"x".repeat(140)}…`);
    expect(sum("Bash").getAttribute("title")).toBe(`${"x".repeat(140)}…`);
    expect(sum("Skill").textContent).toBe("fix");
    expect(sum("Monitor").textContent).toBe("tail");
    expect(sum("Read").textContent).toBe("a");
    expect(f.q('[data-tool="Edit"] svg.lucide-file-pen')).not.toBeNull();
    expect(f.q('[data-tool="Glob"] svg.lucide-folder-search')).not.toBeNull();
    expect(f.q('[data-tool="Skill"] svg.lucide-sparkles')).not.toBeNull();
    expect(f.q('[data-tool="ExitPlanMode"] svg.lucide-clipboard-list')).not.toBeNull();
  });

  it("счёт правки: и когда строк не изменилось", async () => {
    const f = await feed([toolUse("a", "Edit", { file_path: "a", old_string: "x", new_string: "x" })]);
    expect(f.q('[data-tool="Edit"] .chat-count')!.textContent).toBe("+0 −0");
  });

  it("общий кусок из шести строк не свёрнут, из семи — свёрнут", async () => {
    const six = "1\n2\n3\n4\n5\n6\n";
    const seven = `${six}7\n`;
    const f = await feed([toolUse("a", "Edit", { file_path: "a", old_string: `${six}x\n`, new_string: `${six}y\n` })]);
    expect(f.q('[data-tool="Edit"] .chat-diff')!.textContent).not.toContain("без изменений");
    const g = await feed([toolUse("a", "Edit", { file_path: "a", old_string: `${seven}x\n`, new_string: `${seven}y\n` })]);
    expect(g.q('[data-tool="Edit"] .chat-diff')!.textContent).toContain("⋯ 3 без изменений");
  });

  it("задачи готовы — без значка состояния; отклонённое — нейтрально и по всем формам отказа", async () => {
    const f = await feed([toolUse("a", "TodoWrite", { todos: [] }), res("a"), toolUse("b", "Bash", { command: "x" }), res("b", "User rejected the call", true)]);
    expect(f.q('[data-tool="TodoWrite"] .tc-st')).toBeNull();
    const st = f.q('[data-tool="Bash"] .tc-st')!;
    expect(st.textContent).toBe("отклонено");
    expect(st.className).toBe("tc-st");
  });

  it("готово — подпись для чтения с экрана; план ждёт одобрения; пока нет итога — «ждём результата…» у любого вида с итогом", async () => {
    const f = await feed([toolUse("a", "Read", { file_path: "a" }), toolUse("b", "Grep", { pattern: "x" }), res("b")]);
    expect(f.q('[data-tool="Grep"] .tc-st')!.getAttribute("aria-label")).toBe("готово");
    await f.click(f.q('[data-tool="Read"] .tc-h'));
    expect(f.q('[data-tool="Read"] .tb-wait')!.textContent).toBe("ждём результата…");
    const relay = relayFor(roster());
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: "p1", kind: "perm", tool: "ExitPlanMode", input: { plan: "план" } }] });
    const g = await chat(ASKING, { relay });
    await g.events(ASKING, [say([{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "план" } }])], 1);
    expect(g.$('[data-tool="ExitPlanMode"] .tc-st')!.textContent).toBe("ждёт одобрения");
  });

  it("ведомый тул без своего вида и остановка задачи — вход и итог; поиск — только итог; пустой вывод — прочерк", async () => {
    const f = await feed([toolUse("a", "TaskStop", { task_id: "t" }), res("a", "стоп"), toolUse("b", "Grep", { pattern: "x" }), res("b", "нашёл"), toolUse("c", "mcp__s__t", { x: "y" }), res("c", "итог")]);
    await f.click(f.q('[data-tool="TaskStop"] .tc-h'));
    await f.click(f.q('[data-tool="Grep"] .tc-h'));
    expect(f.q('[data-tool="TaskStop"] .tb-pre.muted')!.textContent).toContain('"task_id": "t"');
    expect(f.q('[data-tool="Grep"] .tb-pre.muted')).toBeNull();
  });

  it("итог инструмента объектом — JSON, числом вход Read — картинка с подписью", async () => {
    const f = await feed([toolUse("a", "Grep", { pattern: "x" }), res("a", { a: 1 }), toolUse("b", "Read", { file_path: "p.png" }), res("b", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }])]);
    await f.click(f.q('[data-tool="Grep"] .tc-h'));
    await f.click(f.q('[data-tool="Read"] .tc-h'));
    expect(f.q('[data-tool="Grep"] .tb-pre')!.textContent).toBe('{"a":1}');
    expect(f.q('[data-tool="Read"] .tb-img')!.getAttribute("alt")).toBe("картинка 1");
  });

  it("полоса задачи: время от начала задачи по журналу; у субагента сейчас и шаги, у команды — нет", async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const t = await feed([toolUse("a", "Agent", { description: "x" }), sys("task_started", { task_id: "t1", tool_use_id: "a", task_type: "local_agent", timestamp: at }), sys("task_progress", { task_id: "t1", last_tool_name: "Read", usage: { tool_uses: 3 } }), toolUse("b", "Bash", { command: "c" }), sys("task_started", { task_id: "t2", tool_use_id: "b", task_type: "local_bash", timestamp: at }), sys("task_progress", { task_id: "t2", summary: "сводка", usage: { tool_uses: 9 } })]);
    const agent = t.q('[data-tool="Agent"] .tc-bar span')!.textContent!;
    expect(agent).toMatch(/^идёт (59|60|61) с · сейчас: Read · шагов 3$/);
    const shell = t.q('[data-tool="Bash"] .tc-bar span')!.textContent!;
    expect(shell).toMatch(/^идёт (59|60|61) с$/);
  });

  it("В фон без задачи — только у команды", async () => {
    const f = await feed([toolUse("a", "Agent", { description: "x" }), toolUse("b", "Bash", { command: "c" })], BUSY);
    expect(f.q('[data-tool="Agent"] .tc-bar')).toBeNull();
    expect(f.q('[data-tool="Bash"] .tc-bar')!.textContent).toBe("В фон");
  });

  it("субагент: итог — результат инструмента, ушедший в фон — итог задачи", async () => {
    const f = await feed([toolUse("a", "Agent", { description: "x" }), res("a", "итог агента")]);
    await f.click(f.q('[data-tool="Agent"] .tc-h'));
    expect(f.q('[data-tool="Agent"] .tb-final')!.textContent).toBe("итог агента");
  });

  it("задача в фоне по журналу возвращается на передний план", async () => {
    const f = await feed([toolUse("a", "Bash", { command: "c" }), sys("task_started", { task_id: "t", tool_use_id: "a", task_type: "local_bash", is_backgrounded: true }), sys("task_updated", { task_id: "t", patch: { is_backgrounded: false } })], BUSY);
    expect(f.q('[data-tool="Bash"]')!.dataset.state).toBe("running");
  });
});

describe("свои сообщения", () => {
  const holding = () => {
    const relay = relayFor(roster());
    relay.handlers["session.prompt"] = () => undefined as never;
    return relay;
  };

  it("в пути — «отправляю…», в занятой сессии тоже; доставку шлёт обрезанный текст", async () => {
    const t = await chat(BUSY, { relay: holding() });
    await t.type("  привет  ");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me small")!.textContent).toBe("отправляю…");
    expect(t.$(".chat-me")!.getAttribute("data-state")).toBe("sending");
    expect(t.$(".chat-cancel")).toBeNull();
    expect(t.relay.sent("session.prompt")[0].text).toBe("привет");
  });

  it("обрыв: причина одной строкой, значок повтора", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "timeout" });
    const t = await chat(IDLE, { relay });
    await t.type("привет");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me small")!.textContent).toContain("связь оборвалась до ответа — не подтверждено · отправить ещё раз");
    expect(t.$(".chat-again svg.lucide-rotate-cw")).not.toBeNull();
  });

  it("отказ при занятом поле: прежние слова и обычный тост; вложения добавляются к набранным", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "stopped" });
    const t = await chat(IDLE, { relay });
    await t.type("первое");
    await t.pick(new File(["a"], "a.txt", { type: "text/plain" }));
    t.$<HTMLButtonElement>(".chat-send")!.click();
    await t.type("второе");
    await flush(5);
    expect(t.$(".sb-toast")!.textContent).toBe(`${IDLE}: не доставлено — сессия остановлена. В поле новый текст, отправленный текст не возвращён.`);
    expect(t.$(".chat-file")!.textContent).toContain("a.txt");
  });

  it("откат файлов: проба, отказ без причины, успех полной строкой; есть и у доставленного без эха", async () => {
    const relay = relayFor(roster());
    let probeId = "";
    relay.handlers["session.call"] = (f) => {
      if (!(f.args as unknown[])[1]) return { ok: true, result: {} } as never;
      probeId = String(f.id);
      return undefined as never;
    };
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("сообщение");
    await t.click(t.$(".chat-send"));
    await t.click(t.$(".chat-rw"));
    expect(t.$('.chat-rwc[role="status"]')!.textContent).toBe("Проба отката…");
    relay.reply(probeId, { ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } });
    await flush(5);
    expect(t.$$(".chat-rwc .chat-mini").map((b) => b.textContent)).toEqual(["Отмена", "Откатить"]);
    await t.click(t.$$(".chat-rwc .chat-mini")[1]);
    expect(t.$(".chat-rwc.ok")!.textContent).toBe("Файлы откачены к этому сообщению.");
    await t.click(t.$(".chat-rw"));
    relay.reply(probeId, { ok: true, result: { canRewind: false } });
    await flush(5);
    expect(t.$(".chat-rwc.bad")!.textContent).toBe("Откатить нельзя: canRewind: false");
  });
});

describe("ввод и вопросы сбоку", () => {
  it("команда /btw с подсказкой; полностью набранная остаётся в списке и Enter её шлёт; не больше 20", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.call"] = (f) => (f.method === "supportedCommands" ? ({ ok: true, result: Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` })) } as never) : ({ ok: true, result: { response: null } } as never));
    const t = await chat(IDLE, { relay });
    await t.type("/");
    await flush(5);
    expect(t.$$(".chat-sugi")).toHaveLength(20);
    await t.type("/b");
    await flush(5);
    expect(t.$(".chat-sugi")!.textContent).toBe("/btwВопрос сбоку, в разговор не попадёт");
    await t.type("/btw ");
    await flush(5);
    expect(t.$(".chat-sugi")).toBeNull();
    await t.type("/btw вопрос ");
    await t.key("Enter");
    await flush(5);
    expect(t.$(".chat-side-a")!.textContent).toBe("Claude не ответил");
    expect(t.$(".chat-side svg.lucide-message-square-quote")).not.toBeNull();
  });

  it("при вложении /btw уходит сообщением; вопрос сбоку — обрезанный текст", async () => {
    const t = await chat(IDLE);
    await t.pick(new File(["a"], "a.txt", { type: "text/plain" }));
    await t.type("/btw зачем");
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")[0].text).toBe("/btw зачем");
    expect(t.$(".chat-side")).toBeNull();
  });

  it("поле растёт по тексту; кнопка @ не склеивает со словом; режим неизвестный есть в списке", async () => {
    const t = await chat(IDLE);
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    Object.defineProperty(inp, "scrollHeight", { configurable: true, value: 120 });
    await t.type("строка");
    expect(inp.style.height).toBe("122px");
    await t.click(t.$('[aria-label="Файл папки"]'));
    expect(inp.value).toBe("строка @");
    expect(inp.getAttribute("aria-label")).toContain("Написать");
    const r = roster((x) => {
      x.sessions.find((s) => s.callsign === IDLE)!.mode = "новый";
    });
    const u = await chat(IDLE, { relay: relayFor(r) });
    expect([...u.$<HTMLSelectElement>(".chat-mode")!.options].some((o) => o.value === "новый")).toBe(true);
  });

  it("запасной авто-режим: модель по умолчанию из списка SDK", async () => {
    const relay = relayFor(
      roster((x) => {
        x.sessions.find((s) => s.callsign === IDLE)!.mode = "default";
      }),
    );
    relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? ({ ok: true, result: [{ value: "default", supportsAutoMode: true }] } as never) : ({ ok: true, result: [] } as never));
    const t = await chat(IDLE, { relay });
    await flush(5);
    expect([...t.$<HTMLSelectElement>(".chat-mode")!.options].some((o) => o.value === "auto")).toBe(true);
  });
});

describe("панель и док", () => {
  const panel = async (results: Record<string, unknown>) => {
    const relay = relayFor(roster());
    relay.handlers["session.call"] = (f) => (String(f.method) in results ? ({ ok: true, result: results[String(f.method)] } as never) : ({ ok: false, error: "unknown_method" } as never));
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.button(/контекст/));
    await flush(5);
    return t;
  };

  it("части контекста своими подписями, проценты целые, чтения — запросом чтения", async () => {
    const t = await panel({ getContextUsage: { totalTokens: 1000, maxTokens: 200000, percentage: 41.6, categories: [{ name: "Custom agents", tokens: 2000 }, { name: "Autocompact buffer", tokens: 3000 }] } });
    expect(t.$(".chat-panel")!.getAttribute("aria-label")).toBe("Контекст");
    expect(t.$(".chat-pn-h b")!.textContent).toBe("1 К из 200 К");
    expect(t.$(".chat-pn-h em")!.textContent).toBe("42%");
    expect(t.$$(".chat-pn-l dt").map((d) => d.textContent)).toEqual(["Свои агенты", "Запас на сжатие"]);
  });

  it("сведения Claude: все подписи, connected словом, скрыт только адрес; порядок — правила раньше хуков", async () => {
    const labels = ["Session name", "Session ID", "Session kind", "Organization", "Email", "MCP servers", "Setting sources", "Memory", "Peer address"];
    const t = await panel({
      getStatus: { sections: [{ title: "a", rows: labels.map((label) => ({ label, value: "connected" })) }] },
      listPermissionRules: { state: { rules: [{ behavior: "allow", source: "session", rule: "r" }] } },
      getHooksListing: { hooks: [{ event: "Stop" }] },
    });
    expect(t.$$('[data-sec="claude"] dt').map((d) => d.textContent)).toEqual(["Имя", "Номер", "Вид", "Организация", "Почта", "MCP", "Настройки", "Память"]);
    expect(t.$('[data-sec="claude"] dd')!.textContent).toBe("подключено");
    expect(t.$$(".chat-pn-s").map((s) => (s as HTMLElement).dataset.sec)).toEqual(["claude", "rules", "hooks"]);
  });

  it("вывод фоновой: пока нет ответа — «читаю…», пустой — «пока пусто», хвост с размером; задача без описания — номер, значок, сводка", async () => {
    const relay = relayFor(roster());
    let readId = "";
    relay.handlers["session.call"] = (f) => {
      readId = String(f.id);
      return undefined as never;
    };
    const t = await chat(BUSY, { relay });
    await t.events(BUSY, [sys("task_started", { task_id: "t1", task_type: "monitor", is_backgrounded: true }), sys("task_progress", { task_id: "t1", summary: "смотрю" })], 1);
    await t.click(t.$(".chat-bg .dis-h"));
    expect(t.$(".chat-bgr span")!.textContent).toBe("t1");
    expect(t.$(".chat-bgr em")!.textContent).toBe("смотрю");
    expect(t.$(".chat-bgr svg.lucide-terminal")).not.toBeNull();
    await t.click(t.button("Вывод"));
    expect(t.$(".chat-out pre")!.textContent).toBe("читаю…");
    relay.reply(readId, { ok: true, result: { output: "", total_bytes: 20480, truncated: true } });
    await flush(5);
    expect(t.$(".chat-out-h")!.textContent).toBe("последние 8 КБ из 20 КБ");
    expect(t.$(".chat-out pre")!.textContent).toBe("пока пусто");
  });

  it("док: вопрос под задачами; фон назван первой задачей", async () => {
    const t = await chat(BUSY);
    await t.events(BUSY, [sys("task_started", { task_id: "a", description: "первая", is_backgrounded: true }), sys("task_started", { task_id: "b", description: "вторая", is_backgrounded: true })], 1);
    expect(t.$(".chat-bg .dis-h span")!.textContent).toBe("первая");
    const dock = t.$(".chat-dock")!;
    expect(dock.lastElementChild!.classList.contains("chat-ask")).toBe(true);
  });
});

describe("экран", () => {
  it("широкий — свой класс; подпись кнопки вниз; фокус держится на разговор и только широко", async () => {
    const t = await chat(IDLE, { wide: true });
    expect(t.$(".chat")!.classList.contains("wide")).toBe(true);
    await t.click(t.button(/фокус/));
    await open(`#board`);
    await open(`#chat?callsign=${encodeURIComponent(IDLE)}`);
    expect(t.button(/фокус/)!.getAttribute("aria-pressed")).toBe("true");
  });

  it("сессии нет в roster: шапка «машина не на связи»", async () => {
    const t = await chat("нет@pc");
    expect(document.body.textContent).toContain("pc не на связи");
  });

  it("нет ленты: полная строка; отказ — под лентой", async () => {
    const r = roster((x) => {
      const m = x.machines.find((y) => y.machine === "pc")!;
      delete (m.contract as Record<string, unknown>)["session.watch"];
    });
    const t = await chat(IDLE, { relay: relayFor(r) });
    expect(t.$(".chat-note")!.textContent).toBe("pc не отдаёт ленту — только переписка и ввод");
  });

  it("фокус: шаги с размышлением, служебные строки отдельно, финал отделён от шагов того же ответа, итог хода последним", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.click(t.button(/фокус/));
    await t.events(
      IDLE,
      [
        human("вопрос"),
        say([{ type: "thinking", thinking: "думаю" }, { type: "tool_use", id: "a", name: "Bash", input: { command: "x" } }, { type: "text", text: "итоговый ответ" }]),
        sys("memory_recall", { memories: [{ path: "a.md" }] }),
        { type: "result", uuid: uid(), subtype: "success" },
        human("второй"),
        sys("informational", { content: "заметка" }),
      ],
      1,
    );
    const steps = t.$$(".chat-steps .dis-h").map((x) => x.textContent);
    expect(steps).toEqual(["1 шаг · Команда · размышлял", "служебные строки"]);
    expect(t.$(".chat-steps svg.lucide-list-collapse")).not.toBeNull();
    const col = t.$(".chat-col")!;
    const order = [...col.children].map((x) => x.className.split(" ")[0]);
    expect(order.slice(0, 4)).toEqual(["chat-me", "dis", "chat-reply", "chat-res"]);
    expect(t.$(".chat-reply .chat-txt")!.textContent).toBe("итоговый ответ");
  });

  it("выгрузка: шапка, инструменты, имя отправителя", async () => {
    const relay = relayFor(roster(), [human("<cross-session-message>привет</cross-session-message>", { uuid: "u1" }), toolUse("a", "Bash", { command: "x" })]);
    const t = await chat(IDLE, { relay, wide: true });
    const a = t.$<HTMLAnchorElement>(".chat-bar a")!;
    a.addEventListener("click", (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }));
    const md = decodeURIComponent(a.href);
    expect(md).toContain(`# ${IDLE}\n`);
    expect(md).toContain("## сессия → сессии");
    expect(md).toContain('- `Bash` {"command":"x"}');
  });
});

describe("экран вопроса", () => {
  const PERM = { question: "q1", kind: "perm", tool: "Bash", input: { command: "npm run deploy", description: "Выкладка" }, title: "Заголовок", description: "Заголовок", reason: "Причина", blockedPath: "~/dist", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm:*" }, { toolName: "Read" }], destination: "localSettings" }] };
  const PLAN = { question: "q2", kind: "perm", tool: "ExitPlanMode", input: { plan: "## План\n\nШаг один" } };
  const ASK = { question: "q3", kind: "ask", questions: [{ question: "База?", options: [{ label: "прод" }] }] };
  const FORM = { question: "q4", kind: "form", message: "Токен", schema: { properties: { n: { type: "number" } } }, server: "srv" };

  const asked = async (q: Msg, handlers: Record<string, unknown> = {}) => {
    const relay = relayFor(roster());
    relay.handlers["question.list"] = () => ({ ok: true, result: [q] });
    Object.assign(relay.handlers, handlers);
    const t = await stand(parts(), { relay });
    await open(`#ask?callsign=${encodeURIComponent(ASKING)}`);
    await flush(5);
    return { ...t, relay };
  };

  it("разрешение: порядок, весь вход, строка правил одной на предложение, кнопки вне карточки", async () => {
    const t = await asked(PERM);
    const q = t.$(".ask-q")!;
    expect(q.firstElementChild!.className).toBe("ask-qt");
    expect(q.querySelectorAll(".ask-note")).toHaveLength(2);
    expect(q.querySelector("code.ask-path")!.textContent).toBe("~/dist");
    expect(q.querySelector("details.ask-more summary")!.textContent).toBe("Весь вход");
    expect(q.querySelector("details.ask-more pre")!.textContent).toContain('"description": "Выкладка"');
    expect(q.querySelector(".ask-acts")).toBeNull();
    const after = [...t.$$(".ask > .ask-note")];
    expect(after.map((x) => x.textContent)).toEqual(["Bash(npm:*), Read · локально"]);
    expect(t.$(".ask .sb-cta")!.textContent).toBe("Разрешить");
    expect(t.$$(".ask .ask-decline").map((b) => b.textContent)).toEqual(["Разрешать всегда", "Отклонить"]);
  });

  it("отказ с причиной: поле с подсказкой, Назад; главная кнопка — отклонить", async () => {
    const t = await asked(PLAN);
    await t.click(t.button("Вернуть с замечаниями"));
    const area = t.$<HTMLTextAreaElement>(".ask textarea")!;
    expect(area.getAttribute("placeholder")).toBe("Замечания");
    expect(area.getAttribute("aria-label")).toBe("Замечания");
    expect(area.classList.contains("ask-own")).toBe(true);
    expect(t.$(".ask .sb-cta")!.textContent).toBe("Вернуть");
    expect(t.button("Назад")!.classList.contains("ask-decline")).toBe(true);
  });

  it("план: заголовок «План» не повторяется, чипа нет", async () => {
    const t = await asked(PLAN);
    expect(t.$(".ask-plan")!.textContent).toBe("Шаг один");
    expect(t.$(".ask-chip")).toBeNull();
  });

  it("вопрос: свой ответ с подсказкой, кнопка «Отправляю…» во время ответа", async () => {
    const t = await asked(ASK, { answer: () => undefined as never });
    await t.click(t.$$(".ask-opt")[1]);
    const own = t.$<HTMLInputElement>(".ask-own")!;
    expect(own.getAttribute("placeholder")).toBe("Ваш ответ");
    set(own, "свой");
    await flush();
    await t.click(t.$(".ask .sb-cta"));
    expect(t.$(".ask .sb-cta")!.textContent).toBe("Отправляю…");
  });

  it("свой ответ у вопроса с несколькими — обычная плитка «свой»", async () => {
    const t = await asked({ ...ASK, questions: [{ question: "База?", multiSelect: true, options: [{ label: "прод" }] }] });
    expect(t.$(".ask-opt.own")!.className).not.toContain("multi");
  });

  it("форма: сервер не чип, пустой вариант — прочерк, кнопки вне карточки, ответ без подписи", async () => {
    const t = await asked({ ...FORM, schema: { properties: { e: { enum: ["a"] } } } }, { answer: () => ({ ok: true }) });
    expect(t.$(".ask-chip")).toBeNull();
    expect(t.$<HTMLSelectElement>(".ask-field select")!.options[0].textContent).toBe("—");
    expect(t.$(".ask-q .sb-cta")).toBeNull();
    await t.click(t.$(".ask .sb-cta"));
    expect(t.$('.ask [role="status"]')!.textContent).toContain("Ответ принят.");
  });

  it("итоги — по две строки", async () => {
    const t = await asked(ASK, { answer: () => ({ ok: true }) });
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.$(".ask .sb-cta"));
    const ok = t.$('.ask [role="status"]')!;
    expect(ok.querySelector("b")!.textContent).toBe("Ответ «прод» принят.");
    expect(ok.querySelector("span")!.textContent).toBe(`${ASKING} продолжила работу.`);

    const late = await asked(ASK, { answer: () => ({ ok: false, error: "already_answered" }) });
    await late.click(late.$$(".ask-opt")[0]);
    await late.click(late.$(".ask .sb-cta"));
    expect(late.$('.ask [role="status"] b')!.textContent).toBe("Уже ответили.");
    expect(late.$('.ask [role="status"] span')!.textContent).toBe("Первый ответ выигрывает — ваш не отправлен повторно.");

    const bad = await asked(ASK, { answer: () => ({ ok: false, error: "сбой" }) });
    await bad.click(bad.$$(".ask-opt")[0]);
    await bad.click(bad.$(".ask .sb-cta"));
    expect(bad.$('[role="alert"] b')!.textContent).toBe("Не отправлено: сбой");
    expect(bad.$('[role="alert"] span')!.textContent).toBe("Ответ не дошёл — можно отправить ещё раз.");
  });

  it("снят и исчез — по две строки; чужой ответ без подробностей", async () => {
    const t = await asked(ASK);
    t.relay.push({ type: "answered", from: ASKING, question: "q3", cancelled: true });
    await flush();
    expect(t.$('.ask [role="status"] b')!.textContent).toBe("Вопрос снят.");
    expect(t.$('.ask [role="status"] span')!.textContent).toBe("Ход прервали — ответ больше не нужен.");
    const gone = await asked(ASK, { answer: () => ({ ok: false, error: "unknown_question" }) });
    await gone.click(gone.$$(".ask-opt")[0]);
    await gone.click(gone.$(".ask .sb-cta"));
    expect(gone.$('.ask [role="status"] b')!.textContent).toBe("Вопроса больше нет.");
    expect(gone.$('.ask [role="status"] span')!.textContent).toBe(`${ASKING} его не ждёт: unknown_question.`);
    const other = await asked(ASK);
    other.relay.push({ type: "answered", from: ASKING, question: "q3", by: "panel-desk", action: "allow" });
    await flush();
    expect(other.$('.ask [role="status"] b')!.textContent).toBe("Уже ответили с panel-desk.");
  });

  it("свой ответ, пока идёт: чужое «ответили» — не принято", async () => {
    const t = await asked(ASK, { answer: () => undefined as never });
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.$(".ask .sb-cta"));
    t.relay.push({ type: "answered", from: ASKING, question: "q3", by: "panel-desk", answers: { "База?": "прод" } });
    await flush();
    expect(t.$('.ask [role="status"] b')!.textContent).toBe("Уже ответили с panel-desk: «прод».");
  });

  it("видят: словами приложений и один — «вы»", async () => {
    const relay = relayFor(roster());
    const t = await stand(parts(), { relay });
    relay.push({ type: "question", from: ASKING, ...ASK, to: ["pult", "phone"], open: false });
    await flush();
    await open(`#ask?callsign=${encodeURIComponent(ASKING)}`);
    const hint = t.$(".ask-hint")!.textContent!;
    expect(hint).toMatch(/^Вопрос видят: вы и /);
    expect(hint).toContain("пульт");
  });

  it("список вопросов отказал — слово с именем запроса; экран в обёртке страницы", async () => {
    const relay = relayFor(roster());
    relay.handlers["question.list"] = () => ({ ok: false, error: "сбой" });
    const t = await stand(parts(), { relay });
    await open(`#ask?callsign=${encodeURIComponent(ASKING)}`);
    expect(t.$(".ask-empty")!.textContent).toBe("question.list: сбой");
  });

  it("шапка экрана: имя, строка времени, пометка уже ответили", async () => {
    const t = await asked(ASK);
    expect(document.body.textContent).toMatch(/вопрос сессии · \d\d:\d\d/);
    t.relay.push({ type: "answered", from: ASKING, question: "q3", by: "panel-desk" });
    await flush();
    expect(document.body.textContent).toContain("уже ответили");
  });

  it("метка строки: форма без текста и позывной без сводки; повтор кадра не открывает закрытый заново", async () => {
    const relay = relayFor(roster());
    const t = await stand(parts(), { relay });
    relay.push({ type: "question", from: ASKING, question: "q9", kind: "form", server: "srv", open: false });
    await flush();
    await open(`#chat?callsign=${encodeURIComponent(ASKING)}`);
    expect(t.$(".chat-askbar span")!.textContent).toBe("форма");
    relay.push({ type: "answered", from: ASKING, question: "q9", cancelled: true });
    await flush();
    relay.push({ type: "question", from: ASKING, question: "q9", kind: "form", server: "srv", open: false });
    await flush();
    expect(t.$(".chat-askbar")).toBeNull();
  });
});
