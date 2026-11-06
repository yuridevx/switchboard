// Леса разговора с сессией, сторона страницы: лента, ввод, действия и вопросы — настоящие модули на поддельном relay.
// Вход — экран и кадры контракта, исход — кадры relay, текст и якоря разметки. Источник свойства — номер старого эталона в имени; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInbox, manifest as inboxM } from "@switchboard/web-inbox";
import { memoryStore } from "@switchboard/web-core";
import { PULT, pultParts } from "@switchboard/pult";
import { fakeBrowser } from "../../alerts/stand/fakes.ts";
import { FakeRelay, flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";
import { asst, chat, open, parts, reconnect, relayFor, roster, set, user } from "./stand.ts";

const BUSY = "site@laptop";
const ASKING = "profiles@laptop";
const IDLE = "poe-bot@pc";
const STOPPED = "wiki@pc";

// настоящее приложение на каждый случай: прогон под параллельной нагрузкой идёт дольше предела по умолчанию
vi.setConfig({ testTimeout: 20_000 });

const pressIn = (scope: Element, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);

type Ui = Awaited<ReturnType<typeof chat>>;
type Msg = Record<string, unknown>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let n = 0;
const uid = () => `w${++n}`;
const say = (content: unknown[], x: Msg = {}, id = uid()): Msg => ({ type: "assistant", uuid: uid(), message: { id, model: "claude-opus-5-5", content }, ...x });
const text = (t: string, x: Msg = {}, id = uid()) => say([{ type: "text", text: t }], x, id);
const toolUse = (id: string, name: string, input: unknown = {}, x: Msg = {}) => say([{ type: "tool_use", id, name, input }], x);
const res = (id: string, content: unknown = "вывод", is_error = false, x: Msg = {}): Msg => ({ type: "user", uuid: uid(), message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, ...x });
const human = (content: unknown, x: Msg = {}): Msg => ({ type: "user", uuid: uid(), message: { content }, ...x });
const sys = (subtype: string, x: Msg = {}): Msg => ({ type: "system", subtype, uuid: uid(), ...x });
const start = (id: string, x: Msg = {}): Msg => ({ type: "stream_event", event: { type: "message_start", message: { id } }, ...x });
const delta = (d: Record<string, string>, x: Msg = {}): Msg => ({ type: "stream_event", event: { type: "content_block_delta", delta: d }, ...x });
const textD = (t: string, x: Msg = {}) => delta({ type: "text_delta", text: t }, x);
const thinkD = (t: string) => delta({ type: "thinking_delta", thinking: t });
const PIC = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }];
const SUMMARY = (s: string) => `This session is being continued from a previous conversation.\nSummary:\n${s}`;

/** Лента на настоящем экране: пачки подряд, раскрыть, что на экране. */
function feedUi(t: Ui, seq = { n: 0 }) {
  const feedEl = () => t.$(".chat-feed")!;
  return {
    t,
    more: (msgs: Msg[]) => t.events(IDLE, msgs, ++seq.n),
    el: feedEl,
    text: () => feedEl().textContent ?? "",
    q: (s: string) => feedEl().querySelector<HTMLElement>(s),
    qq: (s: string) => [...feedEl().querySelectorAll<HTMLElement>(s)],
    empty: () => t.$$(".chat-note").some((x) => x.textContent === "Сообщений пока нет"),
    head: (tool: string) => feedEl().querySelector<HTMLElement>(`[data-tool="${tool}"] .tc-h`)!,
    body: (tool: string) => feedEl().querySelector<HTMLElement>(`[data-tool="${tool}"] .tc-b`),
    open: (s: string) => t.click(feedEl().querySelector(s)),
    openTool: (tool: string) => t.click(feedEl().querySelector(`[data-tool="${tool}"] .tc-h`)),
    label: (tool: string) => {
      const h = feedEl().querySelector<HTMLElement>(`[data-tool="${tool}"] .tc-h`)!;
      return [h.querySelector("b")!.textContent, h.querySelector(".tc-sum")!.textContent];
    },
  };
}
type Feed = ReturnType<typeof feedUi>;

/** Открыть простаивающую сессию и показать ей первую пачку. */
async function feed(msgs: Msg[], o: { wide?: boolean } = {}) {
  const t = await chat(IDLE, { wide: o.wide ?? true });
  const f = feedUi(t);
  await f.more(msgs);
  return f;
}

// ───────────── таблица «сообщение SDK → строка ленты» ─────────────

const SDK: Array<[string, Msg[], (f: Feed) => Promise<void> | void]> = [
  ["6200 блоки одного сообщения — одна карточка; повтор по uuid не задваивает", (() => { const a = text("раз", {}, "m1"); return [a, a, text("два", {}, "m1")]; })(), (f) => {
    expect(f.qq(".chat-reply")).toHaveLength(1);
    expect(f.qq(".chat-txt").map((x) => x.textContent)).toEqual(["раз", "два"]);
  }],
  ["6201 6600 текст растёт кусочками с кареткой", [start("m1"), textD("Сбор"), textD("ка")], (f) => {
    expect(f.qq(".chat-txt")).toHaveLength(1);
    expect(f.q(".chat-txt")!.textContent).toBe("Сборка");
    expect(f.q(".md.caret")).not.toBeNull();
  }],
  ["6604 размышление, затем текст одного сообщения: каретки нет", [start("m1"), thinkD("ду"), say([{ type: "thinking", thinking: "думал" }], {}, "m1"), textD("отв"), say([{ type: "text", text: "ответ" }], {}, "m1")], (f) => {
    expect(f.qq(".chat-reply")).toHaveLength(1);
    expect(f.q(".chat-txt")!.textContent).toBe("ответ");
    expect(f.q(".caret")).toBeNull();
  }],
  ["6605 размышление скрыто: не раскрыть, текст виден", [say([{ type: "redacted_thinking" }, { type: "text", text: "ответ" }])], (f) => {
    expect(f.text()).toContain("Размышлял");
    expect(f.q(".chat-think .dis-h")).toBeNull();
    expect(f.q(".chat-txt")!.textContent).toBe("ответ");
  }],
  ["6607 кусочки входа инструмента не рисуются", [start("m1"), delta({ type: "input_json_delta", partial_json: "{" }), delta({ type: "signature_delta", signature: "x" })], (f) => void expect(f.empty()).toBe(true)],
  ["6608 ход кончился без готового блока: каретки и «Размышляет» нет, текст виден", [start("m1"), thinkD("ду"), textD("начал"), { type: "result", uuid: uid(), subtype: "success" }], (f) => {
    expect(f.text()).not.toContain("Размышляет");
    expect(f.q(".caret")).toBeNull();
    expect(f.text()).toContain("начал");
  }],
  ["6203 6609 итог с картинкой: текст и картинка порознь в карточке", [toolUse("t1", "Grep", { pattern: "x" }), res("t1", [{ type: "text", text: "снимок" }, ...PIC])], async (f) => {
    await f.openTool("Grep");
    expect(f.q(".tb-pre")!.textContent).toBe("снимок");
    expect(f.q(".tb-img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(f.q(".chat-me")).toBeNull();
  }],
  ["6610 ошибка инструмента", [toolUse("t1", "Bash", { command: "npm run gate" }), res("t1", "нет зависимости", true)], async (f) => {
    expect(f.q(".chat-tool")!.getAttribute("data-state")).toBe("error");
    expect(f.q(".tc-st")!.textContent).toBe("ошибка");
    await f.openTool("Bash");
    expect(f.q(".tb-pre.bad")!.textContent).toBe("нет зависимости");
  }],
  ["6611 отказ человека — «отклонено», а не ошибка", [toolUse("t1", "Bash"), res("t1", "The user doesn't want to proceed with this tool use.", true)], (f) => {
    expect(f.q(".chat-tool")!.getAttribute("data-state")).toBe("denied");
    expect(f.q(".tc-st")!.textContent).toBe("отклонено");
  }],
  ["6613 сводка шагов в карточке", [toolUse("t1", "Read"), { type: "tool_use_summary", uuid: uid(), summary: "Прочитал конфиг", preceding_tool_use_ids: ["t1"] }], (f) => void expect(f.q(".tc-note")!.textContent).toBe("Прочитал конфиг")],
  ["6614 итог раньше вызова", [res("t1", "вывод"), toolUse("t1", "Bash")], (f) => void expect(f.q(".chat-tool")!.getAttribute("data-state")).toBe("ok")],
  ["6618 инструмент сервера", [say([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "react" } }])], (f) => void expect(f.q(".tc-h b")!.textContent).toBe("web_search")],
  ["6619 реплика с картинкой", [human([...PIC, { type: "text", text: "снимок" }])], (f) => {
    expect(f.q(".chat-me img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(f.q(".chat-me")!.textContent).toContain("снимок");
  }],
  ["6214 6620 сообщение другой сессии и субагента: откуда видно, тега нет", [human('<fleet-message from="poe-bot@pc">\nСобрано\n</fleet-message>'), human('<agent-message from-name="Explore">\nНашёл\n</agent-message>')], (f) => {
    const [a, b] = f.qq(".chat-in");
    expect(a.textContent).toContain("сессия Claude · poe-bot@pc");
    expect(a.textContent).toContain("Собрано");
    expect(a.textContent).not.toContain("fleet-message");
    expect(b.textContent).toContain("субагент · Explore");
  }],
  ["6214 6620 peer и длинное сообщение: свёрнуто, «ещё» раскрывает", [human("слово ".repeat(200), { origin: { kind: "peer", name: "a@b" } })], async (f) => {
    expect(f.q(".chat-in")!.textContent).toContain("a@b");
    expect(f.q(".chat-clamp")).not.toBeNull();
    await f.open(".chat-more");
    expect(f.q(".chat-clamp")).toBeNull();
  }],
  ["6622 служебное скрыто", [human("<system-reminder>x</system-reminder>"), human("Caveat: x"), human("синтетика", { isSynthetic: true }), human("мета", { isMeta: true }), human("задание", { parent_tool_use_id: "t" })], (f) => void expect(f.empty()).toBe(true)],
  ["6623 своя слэш-команда — строка, а не пузырь", [human("/compact"), human("<command-name>/compact</command-name>")], (f) => {
    expect(f.q(".chat-me")).toBeNull();
    expect(f.qq(".chat-cmd")).toHaveLength(1);
  }],
  ["6205 команда с выводом — одна строка, прерывание, напоминание скрыто", [human("<command-name>/context</command-name><command-args>--full</command-args>"), human("<local-command-stdout>42%</local-command-stdout>"), human("[Request interrupted by user]"), human("<system-reminder>скрыто</system-reminder>")], (f) => {
    expect(f.qq(".chat-cmd")).toHaveLength(1);
    expect(f.q(".chat-cmd")!.textContent).toContain("/context");
    expect(f.q(".chat-cmd")!.textContent).toContain("--full");
    expect(f.q(".chat-cmd")!.textContent).toContain("42%");
    expect(f.q(".chat-sys.wait")!.textContent).toContain("прервано");
    expect(f.text()).not.toContain("скрыто");
    expect(f.q(".chat-me")).toBeNull();
  }],
  ["6625 служебное от другой сессии показано", [human('<agent-message from-name="Explore">\nНашёл\n</agent-message>', { isSynthetic: true }), human('<fleet-message from="a@b">\nПривет\n</fleet-message>', { isSynthetic: true })], (f) => void expect(f.qq(".chat-in")).toHaveLength(2)],
  ["6626 итог хода", [{ type: "result", uuid: uid(), subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41, usage: { input_tokens: 1000, cache_read_input_tokens: 45_000 } }], (f) => void expect(f.q(".chat-res")!.textContent).toBe("ход закончен · 2 мин 14 с · 6 шагов · $0,41 · 46 К в контексте")],
  ["6627 ход оборвался: errors", [{ type: "result", uuid: uid(), subtype: "error_during_execution", is_error: true, errors: ["процесс упал"] }], (f) => {
    expect(f.q(".chat-res.err")!.textContent).toContain("ход оборвался: сбой при выполнении");
    expect(f.q(".chat-res.err p")!.textContent).toBe("процесс упал");
  }],
  ["6627 ход оборвался: result", [{ type: "result", uuid: uid(), subtype: "success", is_error: true, result: "API упал" }], (f) => void expect(f.q(".chat-res.err p")!.textContent).toBe("API упал")],
  ["6207 стоимость накопительная: строка хода — разница", [{ type: "result", uuid: uid(), subtype: "success", total_cost_usd: 0.5 }, { type: "result", uuid: uid(), subtype: "success", total_cost_usd: 0.75 }], (f) => void expect(f.qq(".chat-res").map((x) => x.textContent)).toEqual(["ход закончен · $0,50", "ход закончен · $0,25"])],
  ["6207 прерванный ход без строки ошибки", [human("[Request interrupted by user]"), { type: "result", uuid: uid(), subtype: "error_during_execution", is_error: true }], (f) => {
    expect(f.q(".chat-sys.wait")!.textContent).toContain("прервано");
    expect(f.q(".chat-res")).toBeNull();
  }],
  ["6628 лимит: предупреждение и исчерпан; allowed — без строки", [{ type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000 } }, { type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }, { type: "rate_limit_event", uuid: uid(), rate_limit_info: { status: "allowed" } }], (f) => {
    const bans = f.qq(".chat-ban");
    expect(bans).toHaveLength(2);
    expect(bans[0].textContent).toContain("Лимит подписки скоро кончится");
    expect(bans[0].textContent).toContain("5 ч, сброс в");
    expect(bans[1].textContent).toContain("Лимит подписки исчерпаннеделя");
  }],
  ["6208 6629 отказ модели с заменой: начатый ответ отозван", (() => { const a = text("начал"); return [a, sys("model_refusal_fallback", { retracted_message_uuids: [a.uuid], original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", api_refusal_category: "cyber" })]; })(), (f) => {
    expect(f.text()).not.toContain("начал");
    expect(f.q(".chat-ban.wait")!.textContent).toContain("Fable 5.1 отказалась — ответ переписан моделью Opus 5.5");
    expect(f.text()).toContain("Дальше сессия идёт на Opus 5.5");
  }],
  ["6208 6629 отказ модели только на этот ответ", [sys("model_refusal_fallback", { original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", scope: "local" })], (f) => void expect(f.text()).toContain("Только этот ответ: модель сессии прежняя")],
  ["6630 запасная модель и смена модели", [sys("model_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", trigger: "overloaded" }), text("x"), sys("init", { model: "claude-sonnet-5-5" })], (f) => {
    expect(f.q(".chat-ban.wait")!.textContent).toBe("Opus 5.5 перегружена — этот ход отвечает Sonnet 5.5");
    expect(f.q(".chat-sys")!.textContent).toBe("модель: Opus 5.5 → Sonnet 5.5");
  }],
  ["6630 та же модель с другой записью — строки нет", [sys("init", { model: "claude-x" }), text("x"), sys("init", { model: "claude-opus-5-5[1m]" })], (f) => void expect(f.q(".chat-sys")).toBeNull()],
  ["6631 хук упал: одна строка; успешный — без строки", [sys("hook_response", { hook_name: "fmt", exit_code: 2, stderr: "не найден" }), sys("hook_response", { hook_name: "ok", exit_code: 0 })], (f) => void expect(f.q(".chat-line.wait")!.textContent).toBe("Хук fmt не сработал (код 2): не найден")],
  ["6632 прочие строки", [sys("memory_recall", { memories: [{ path: "m/backlog.md" }] }), sys("informational", { content: "заметка" }), sys("notification", { text: "вход истекает", priority: "high" }), sys("permission_denied", { tool_name: "Bash", message: "запрещено" }), sys("files_persisted", { files: [{ filename: "a.pdf" }], failed: [] }), { type: "conversation_reset", uuid: uid() }], (f) => {
    expect(f.text()).toContain("Из памяти: backlog.md");
    expect(f.text()).toContain("заметка");
    expect(f.q(".chat-ban.wait")!.textContent).toBe("вход истекает");
    expect(f.text()).toContain("Отклонено правилами: Bash — запрещено");
    expect(f.text()).toContain("Файлы сохранены: a.pdf");
    expect(f.text()).toContain("разговор начат заново");
  }],
  ["6633 ошибка ответа claude", [say([], { error: "overloaded" }), say([], { error: "oauth_org_not_allowed" }), { type: "auth_status", uuid: uid(), error: "вход истёк" }, sys("mirror_error", { error: "зеркало упало" }), sys("plugin_install", { status: "failed", name: "p", error: "нет сети" })], (f) => void expect(f.qq(".chat-ban.bad").map((x) => x.textContent)).toEqual(["ОшибкаСерверы Anthropic перегружены", "Ошибкаoauth_org_not_allowed", "Ошибкавход истёк", "Ошибказеркало упало", "ОшибкаПлагин не установился (p): нет сети"])],
  ["6634 незнакомое сообщение не рисуется", [{ type: "из будущего", uuid: uid() }, sys("commands_changed"), sys("hook_started"), sys("worker_shutting_down"), sys("plugin_install", { status: "installed" })], (f) => void expect(f.empty()).toBe(true)],
  ["6206 сводка сжатия — на строке границы, текста обёртки не видно", [human("до"), sys("compact_boundary", { compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } }), human(SUMMARY("таймаут поднят"), { isCompactSummary: true }), human("после")], async (f) => {
    expect(f.qq(".chat-me")).toHaveLength(2);
    expect(f.q(".chat-sum")!.textContent).toContain("контекст сжат · 90 К → 8 К");
    expect(f.text()).not.toContain("This session is being continued");
    await f.open(".chat-sum .dis-h");
    expect(f.q(".chat-sum")!.textContent).toContain("таймаут поднят");
  }],
  ["6206 сводка в истории без границы — своя строка", [human(SUMMARY("суть"), { isCompactSummary: true })], async (f) => {
    expect(f.q(".chat-me")).toBeNull();
    expect(f.q(".chat-sum")).not.toBeNull();
    expect(f.text()).not.toContain("This session is being continued");
  }],
  ["6636 стоимость после перезапуска процесса — счёт с начала", [{ type: "result", uuid: uid(), subtype: "success", total_cost_usd: 7 }, { type: "result", uuid: uid(), subtype: "success", total_cost_usd: 1 }, { type: "result", uuid: uid(), subtype: "success", total_cost_usd: 1.5 }], (f) => void expect(f.qq(".chat-res").map((x) => x.textContent)).toEqual(["ход закончен · $7,00", "ход закончен · $1,00", "ход закончен · $0,50"])],
  ["6638 файлы сохранились не все", [sys("files_persisted", { files: [{ filename: "a.pdf" }], failed: [{ filename: "b.pdf", error: "нет места" }] })], (f) => void expect(f.q(".chat-line.bad")!.textContent).toBe("Файлы сохранены: a.pdf · Не сохранились: b.pdf: нет места")],
  ["6210 повтор API подряд — одна строка с последней попыткой", [sys("api_retry", { attempt: 1, max_retries: 10 }), sys("api_retry", { attempt: 2, max_retries: 10 })], (f) => {
    expect(f.qq(".chat-sys").map((x) => x.textContent)).toEqual(["повтор запроса к API · 2 из 10"]);
  }],
  ["6641 задача без вызова", [sys("task_started", { task_id: "k", description: "ищет", task_type: "local_agent" }), sys("task_progress", { task_id: "k", usage: { tool_uses: 2 } })], (f) => void expect(f.q(".chat-line.run")!.textContent).toBe("ищет2 шагаСтоп")],
  ["6642 задача у вызова кончилась: полосы нет, карточка одна", [toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1" }), sys("task_notification", { task_id: "k", status: "completed" }), res("t1", "ok")], (f) => {
    expect(f.q(".tc-bar")).toBeNull();
    expect(f.qq(".chat-tool")).toHaveLength(1);
  }],
  ["6209 6643 задача без вызова кончилась: одна строка; повтор конца не задваивает", [sys("task_started", { task_id: "k", description: "ищет" }), sys("task_notification", { task_id: "k", status: "completed" }), sys("task_notification", { task_id: "k", status: "completed" })], (f) => {
    expect(f.qq(".chat-line.ok").map((x) => x.textContent)).toEqual(["Задача завершена · ищет"]);
    expect(f.text()).not.toContain("Стоп");
  }],
  ["6644 фоновая упала или остановлена", [toolUse("t1", "Bash"), sys("task_started", { task_id: "a", tool_use_id: "t1", description: "a", is_backgrounded: true }), sys("task_notification", { task_id: "a", status: "failed" }), toolUse("t2", "Bash"), sys("task_started", { task_id: "b", tool_use_id: "t2", description: "b", is_backgrounded: true }), sys("task_notification", { task_id: "b", status: "stopped" })], (f) => {
    expect(f.q(".chat-line.bad")!.textContent).toBe("Задача упала · a");
    expect(f.q(".chat-line.wait")!.textContent).toBe("Задача остановлена · b");
    expect(f.q('[data-state="stopped"] .tc-st')!.textContent).toBe("остановлено");
  }],
  ["6215 6645 конец задачи текстом разговора — строка, а не пузырь", [human("<task-notification><task-id>k</task-id><status>failed</status><summary>сборка упала</summary></task-notification>")], (f) => {
    expect(f.q(".chat-me")).toBeNull();
    expect(f.q(".chat-line.bad")!.textContent).toBe("Задача упала · сборка упала");
  }],
  ["6645 тот же конец задачи вторым каналом не задваивается", [sys("task_started", { task_id: "k", tool_use_id: "x", is_backgrounded: true }), sys("task_notification", { task_id: "k", status: "failed" }), human("<task-notification><task-id>k</task-id><status>failed</status></task-notification>")], (f) => void expect(f.qq(".chat-line.bad")).toHaveLength(1)],
  ["6705 метка «в фоне» у команды с run_in_background и у итога без задачи", [toolUse("a", "Bash", { command: "x", run_in_background: true }), res("a", "ок"), toolUse("b", "PowerShell", { command: "y" }), res("b", "Command running in background")], (f) => {
    expect(f.head("Bash").querySelector(".tc-chip")!.textContent).toBe("в фоне");
    expect(f.head("PowerShell").querySelector(".tc-chip")!.textContent).toBe("в фоне");
  }],
  ["6716 состояние от задачи: «в фоне» без второй метки и без «В фон»", [toolUse("a", "Bash", { command: "x" }), sys("task_started", { task_id: "ka", tool_use_id: "a", description: "д", is_backgrounded: true })], (f) => {
    expect(f.head("Bash").querySelector(".tc-st")!.textContent).toBe("в фоне");
    expect(f.head("Bash").querySelector(".tc-chip")).toBeNull();
    expect(f.qq("button").some((b) => b.textContent === "В фон")).toBe(false);
  }],
  ["6716 задача остановлена: stopped", [toolUse("b", "Bash", { command: "x" }), sys("task_started", { task_id: "kb", tool_use_id: "b", description: "д" }), sys("task_updated", { task_id: "kb", patch: { status: "stopped" } })], (f) => void expect(f.head("Bash").querySelector(".tc-st")!.textContent).toBe("остановлено")],
  ["6716 задача остановлена: killed", [toolUse("b", "Bash", { command: "x" }), sys("task_started", { task_id: "kb", tool_use_id: "b", description: "д" }), sys("task_updated", { task_id: "kb", patch: { status: "killed" } })], (f) => void expect(f.head("Bash").querySelector(".tc-st")!.textContent).toBe("остановлено")],
  ["6637 ошибка и отказ субагента — в его карточке, плашки ленты нет", [toolUse("t1", "Agent"), text("шаг упал", { parent_tool_use_id: "t1", error: "overloaded" }), { type: "assistant", uuid: uid(), parent_tool_use_id: "t1", isApiErrorMessage: true, error: "x", message: { stop_reason: "refusal", content: [] } }], (f) => {
    expect(f.q(".chat-ban")).toBeNull();
    expect(f.q(".tb-steps .chat-txt")!.textContent).toBe("шаг упал");
  }],
  ["6204 6615 шаг субагента и его итог — в карточке, пузыря нет", [toolUse("t1", "Agent"), toolUse("t2", "Bash", {}, { parent_tool_use_id: "t1" }), res("t2", "ok", false, { parent_tool_use_id: "t1" })], (f) => {
    expect(f.qq(".chat-tool")).toHaveLength(2);
    expect(f.qq(".tb-steps .chat-tool")).toHaveLength(1);
    expect(f.q(".tb-steps .chat-tool")!.getAttribute("data-state")).toBe("ok");
    expect(f.q(".chat-me")).toBeNull();
  }],
];

describe("сообщение SDK → строка ленты", () => {
  it.each(SDK)("%s", async (_name, msgs, check) => {
    await check(await feed(msgs));
  });

  it("6601 размышление идёт и заканчивается: свёрнуто, раскрывается разметкой", async () => {
    const f = await feed([start("m1"), thinkD("думаю о таймауте")]);
    expect(f.text()).toContain("Размышляет…");
    expect(f.text()).toContain("думаю о таймауте");
    await f.more([say([{ type: "thinking", thinking: "весь **текст**" }], {}, "m1")]);
    expect(f.text()).toContain("Размышлял");
    expect(f.text()).not.toContain("Размышляет");
    expect(f.text()).not.toContain("весь");
    await f.open(".chat-think .dis-h");
    expect(f.q(".chat-think strong")!.textContent).toBe("текст");
  });

  it("6201 6603 готовый блок сменяет кусочки; второе сообщение хода — своя карточка", async () => {
    const f = await feed([start("m1"), textD("Сбор"), textD("ка")]);
    await f.more([say([{ type: "text", text: "Сборка зелёная" }], {}, "m1")]);
    expect(f.qq(".chat-reply")).toHaveLength(1);
    expect(f.q(".chat-txt")!.textContent).toBe("Сборка зелёная");
    await f.more([start("m2"), textD("дальше")]);
    expect(f.qq(".chat-reply")).toHaveLength(2);
    expect(f.q(".md.caret")!.textContent).toBe("дальше");
  });

  it("6606 кусочки субагента — в его карточке", async () => {
    const x = { parent_tool_use_id: "t1" };
    const f = await feed([toolUse("t1", "Agent", { prompt: "ищи" }), start("m2", x), textD("шаг идёт", x)]);
    expect(f.q(".tb-steps .md.caret")!.textContent).toBe("шаг идёт");
    await f.more([say([{ type: "text", text: "шаг готов" }], x, "m2")]);
    expect(f.q(".tb-steps .chat-txt")!.textContent).toBe("шаг готов");
    expect(f.q(".caret")).toBeNull();
  });

  it("6612 шаги субагента: задание свёрнуто, итог разметкой", async () => {
    const x = { parent_tool_use_id: "t1" };
    const f = await feed([toolUse("t1", "Agent", { description: "ищет", prompt: "найди таймауты" }), toolUse("t2", "Grep", { pattern: "timeout" }, x)]);
    expect(f.q(".tb-steps .chat-tool")!.getAttribute("data-tool")).toBe("Grep");
    expect(f.text()).not.toContain("найди таймауты");
    await f.open(".tb-agent .dis-h");
    expect(f.text()).toContain("найди таймауты");
    await f.more([res("t1", "Нашёл **три**")]);
    await f.openTool("Agent");
    expect(f.q(".tb-final strong")!.textContent).toBe("три");
  });

  it("6616 6715 субагент ушёл в фон: «запущен» итогом не показан; после конца итог — summary разметкой", async () => {
    const f = await feed([toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1", task_type: "local_agent", is_backgrounded: true }), res("t1", "Async agent launched")]);
    expect(f.q(".chat-tool")!.getAttribute("data-state")).toBe("bg");
    expect(f.text()).not.toContain("launched");
    await f.more([sys("task_notification", { task_id: "k", status: "completed", summary: "**итог** задачи" })]);
    await f.openTool("Agent");
    expect(f.q(".tb-final strong")!.textContent).toBe("итог");
    expect(f.text()).not.toContain("launched");
  });

  it("6635 сжатие идёт и не вышло", async () => {
    const f = await feed([sys("status", { status: "compacting" })]);
    expect(f.t.$(".chat-work")!.textContent).toBe("Сжимаю контекст…");
    await f.more([sys("status", { status: null, compact_result: "failed", compact_error: "нет места" })]);
    expect(f.t.$(".chat-work")?.textContent ?? "").not.toContain("Сжимаю");
    expect(f.q(".chat-ban.bad")!.textContent).toBe("ОшибкаСжать контекст не вышло: нет места");
  });

  it("6640 задача у вызова: идёт, время растёт, сводка и шаги в полосе", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: 1_000_000 });
    try {
      const f = await feed([toolUse("t1", "Agent"), sys("task_started", { task_id: "k", tool_use_id: "t1", task_type: "local_agent" }), sys("task_progress", { task_id: "k", summary: "читает README", usage: { tool_uses: 3 } })]);
      expect(f.q(".tc-bar")!.textContent).toContain("идёт 0 с · читает README · шагов 3");
      vi.advanceTimersByTime(2000);
      await flush();
      expect(f.q(".tc-bar")!.textContent).toContain("идёт 2 с");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────── карточка инструмента ─────────────

const SHAPES: Array<[string, Msg, string, string]> = [
  ["Bash", { command: "npm test\nвторая" }, "Команда", "npm test"],
  ["PowerShell", { command: "Get-Service" }, "PowerShell", "Get-Service"],
  ["Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "Правка", "a.ts"],
  ["MultiEdit", { file_path: "b.ts", edits: [] }, "Правки", "b.ts"],
  ["Write", { file_path: "c.md", content: "x" }, "Запись файла", "c.md"],
  ["NotebookEdit", { notebook_path: "n.ipynb" }, "Ячейка блокнота", "n.ipynb"],
  ["Read", { file_path: "d.ts", offset: 10, limit: 40 }, "Чтение", "d.ts · с 10 · 40 строк"],
  ["Grep", { pattern: "p", path: "web", glob: "*.ts" }, "Поиск", "p · web · *.ts"],
  ["Glob", { pattern: "**/*.ts", path: "web" }, "Файлы по маске", "**/*.ts · web"],
  ["WebFetch", { url: "https://a.b" }, "Страница", "https://a.b"],
  ["WebSearch", { query: "q" }, "Поиск в сети", "q"],
  ["TodoWrite", { todos: [{ status: "completed" }, { status: "pending" }] }, "Задачи", "1 из 2 готово"],
  ["Agent", { description: "ищет" }, "Субагент", "ищет"],
  ["Skill", { skill: "deliver" }, "Скил", "deliver"],
  ["AskUserQuestion", { questions: [{ question: "Базу?" }] }, "Вопрос", "Базу?"],
  ["ExitPlanMode", { plan: "p" }, "План", ""],
  ["Monitor", { description: "следит" }, "Наблюдение", "следит"],
  ["TaskStop", { task_id: "k1" }, "Остановка задачи", "k1"],
  ["ScheduleWakeup", { reason: "ждёт CI" }, "Расписание", "ждёт CI"],
  ["PushNotification", { message: "готово" }, "Уведомление", "готово"],
  ["EnterWorktree", { name: "w" }, "Ворктри", "w"],
  ["Task", { description: "d" }, "Субагент", "d"],
  ["EnterPlanMode", {}, "Режим плана", ""],
  ["KillShell", { shell_id: "s1" }, "Остановка задачи", "s1"],
  ["TaskOutput", { task_id: "k" }, "Вывод задачи", "k"],
  ["BashOutput", { bash_id: "b" }, "Вывод задачи", "b"],
  ["TaskCreate", { subject: "s" }, "Задачи", "s"],
  ["TaskUpdate", { taskId: "7" }, "Задачи", "7"],
  ["TaskGet", { taskId: "8" }, "Задачи", "8"],
  ["TaskList", {}, "Задачи", ""],
  ["CronCreate", { prompt: "p" }, "Расписание", "p"],
  ["CronDelete", { cron: "c" }, "Расписание", "c"],
  ["CronList", {}, "Расписание", ""],
  ["ExitWorktree", { action: "keep" }, "Ворктри", "keep"],
];

describe("карточка инструмента", () => {
  it.each(SHAPES)("6700 6706 шапка %s", async (name, input, word, sum) => {
    const f = await feed([toolUse("t", name, input)]);
    expect(f.label(name)).toEqual([word, sum]);
  });

  it("6701 MCP и незнакомый: «сервер · инструмент» или имя как есть; тело — вход JSON и вывод", async () => {
    const f = await feed([toolUse("m", "mcp__github__create_issue", { title: "Таймаут" }), res("m", "вывод"), toolUse("x", "Незнакомый", { a: "b" })]);
    expect(f.label("mcp__github__create_issue")).toEqual(["github · create_issue", "Таймаут"]);
    expect(f.label("Незнакомый")).toEqual(["Незнакомый", "b"]);
    await f.openTool("mcp__github__create_issue");
    const pres = f.body("mcp__github__create_issue")!.querySelectorAll("pre");
    expect(JSON.parse(pres[0].textContent!)).toEqual({ title: "Таймаут" });
    expect(pres[1].textContent).toBe("вывод");
  });

  it("6702 дифф правки: «+N −M», строки по видам, длинный общий кусок свёрнут", async () => {
    const same = Array.from({ length: 10 }, (_, i) => `общая ${i}`).join("\n");
    const f = await feed([toolUse("e", "Edit", { file_path: "a.ts", old_string: `старая\n${same}\n`, new_string: `новая 1\nновая 2\n${same}\n` })]);
    expect(f.q(".chat-count")!.textContent).toBe("+2 −1");
    expect(f.qq(".chat-diff .del")).toHaveLength(1);
    expect(f.qq(".chat-diff .add")).toHaveLength(2);
    const shown = f.qq(".chat-diff .same").map((x) => x.textContent);
    expect(shown).toHaveLength(5);
    expect(shown[2]).toContain("⋯ 6 без изменений");
  });

  it("6703 файл с подсветкой по расширению; 6712 ошибка без подсветки, картинка, пустой файл", async () => {
    const f = await feed([toolUse("r", "Read", { file_path: "a.ts" }), res("r", "const a = 1;")]);
    await f.openTool("Read");
    expect(f.body("Read")!.querySelector(".hljs-keyword")!.textContent).toBe("const");
    const e = await feed([toolUse("e", "Read", { file_path: "a.ts" }), res("e", "const нет", true)]);
    await e.openTool("Read");
    expect(e.body("Read")!.querySelector(".tb-pre.bad")!.textContent).toBe("const нет");
    expect(e.body("Read")!.querySelector("[class^=hljs-]")).toBeNull();
    const pic = await feed([toolUse("p", "Read", { file_path: "a.png" }), res("p", PIC)]);
    await pic.openTool("Read");
    expect(pic.body("Read")!.querySelector("img")).not.toBeNull();
    const empty = await feed([toolUse("z", "Read", { file_path: "a.ts" }), res("z", "")]);
    await empty.openTool("Read");
    expect(empty.body("Read")!.querySelector(".tb-pre")!.textContent).toBe("без вывода");
  });

  it("6704 вопрос с вариантами или ответом; план разметкой", async () => {
    const q = { question: "Базу?", options: [{ label: "стенд" }, { label: "прод" }] };
    const f = await feed([toolUse("a", "AskUserQuestion", { questions: [q] }), toolUse("p", "ExitPlanMode", { plan: "## План\n\n1. раз" })]);
    expect(f.body("AskUserQuestion")!.textContent).toBe("Базу?стенд · прод");
    expect(f.body("ExitPlanMode")!.querySelector("h2")!.textContent).toBe("План");
    const a = await feed([toolUse("b", "AskUserQuestion", { questions: [q], answers: { "Базу?": "прод" } })]);
    expect(a.body("AskUserQuestion")!.textContent).toBe("Базу?прод");
  });

  it("6707 команда и страница: описание, «$» или «PS>», «ждём результата…», «без вывода», картинка, prompt", async () => {
    const f = await feed([toolUse("b", "Bash", { command: "ls", description: "Список" }), toolUse("p", "PowerShell", { command: "dir" }), res("p", ""), toolUse("w", "WebFetch", { url: "https://a", prompt: "Что там?" }), res("w", "текст страницы"), toolUse("g", "Grep", { pattern: "x" }), res("g", PIC)]);
    for (const x of ["Bash", "PowerShell", "WebFetch", "Grep"]) await f.openTool(x);
    expect(f.body("Bash")!.querySelector(".tb-hint")!.textContent).toBe("Список");
    expect(f.body("Bash")!.querySelector(".tb-pre")!.textContent).toBe("$ ls");
    expect(f.body("Bash")!.querySelector(".tb-wait")!.textContent).toBe("ждём результата…");
    expect([...f.body("PowerShell")!.querySelectorAll(".tb-pre")].map((x) => x.textContent)).toEqual(["PS> dir", "без вывода"]);
    expect(f.body("WebFetch")!.querySelector(".tb-hint")!.textContent).toBe("Что там?");
    expect(f.body("WebFetch")!.querySelector(".tb-pre")!.textContent).toBe("текст страницы");
    expect(f.body("Grep")!.querySelector("pre")).toBeNull();
    expect(f.body("Grep")!.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("6708 что раскрыто сразу: правки, задачи, вопрос и план; субагент — пока нет итога; команда — по нажатию и остаётся", async () => {
    const f = await feed(["Edit", "MultiEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Agent"].map((name, i) => toolUse(`t${i}`, name)).concat(toolUse("c", "Bash", { command: "x" })));
    for (const x of ["Edit", "MultiEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Agent"]) expect(f.body(x), x).not.toBeNull();
    expect(f.body("Bash")).toBeNull();
    const a = await feed([toolUse("a", "Agent"), res("a", "итог")]);
    expect(a.body("Agent")).toBeNull();
    const b = await feed([toolUse("c", "Bash", { command: "x" })]);
    await b.openTool("Bash");
    await b.more([res("c", "вывод")]);
    expect(b.body("Bash")!.textContent).toContain("вывод");
    await b.openTool("Bash");
    expect(b.body("Bash")).toBeNull();
  });

  it("6709 «все вхождения»; ячейка блокнота и запись — все строки добавленными", async () => {
    const f = await feed([toolUse("e", "Edit", { old_string: "a", new_string: "b", replace_all: true }), toolUse("n", "NotebookEdit", { cell_id: "c3", new_source: "print(1)" }), toolUse("w", "Write", { content: "x\ny\n" })]);
    expect(f.body("Edit")!.querySelector(".tb-hint")!.textContent).toBe("все вхождения");
    await f.openTool("NotebookEdit");
    await f.openTool("Write");
    expect(f.body("NotebookEdit")!.querySelector(".tb-hint")!.textContent).toBe("ячейка c3");
    expect(f.body("NotebookEdit")!.querySelectorAll(".add")).toHaveLength(1);
    expect(f.body("Write")!.querySelectorAll(".add")).toHaveLength(2);
  });

  it("6710 6711 ошибка инструмента со своим телом видна словами", async () => {
    const f = await feed([toolUse("e", "Edit", { old_string: "a", new_string: "b" }), res("e", "не нашёл строку", true), toolUse("m", "MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] }), res("m", "нет файла", true), toolUse("w", "Write", { content: "x" }), res("w", "нет прав", true), toolUse("n", "NotebookEdit", { new_source: "x" }), res("n", "ячейка не найдена", true), toolUse("t", "TodoWrite", { todos: [] }), res("t", "список не принят", true), toolUse("p", "ExitPlanMode", { plan: "п" }), res("p", "план не принят", true), toolUse("q", "AskUserQuestion", { questions: [] }), res("q", "вопрос не задан", true)]);
    await f.openTool("Write");
    await f.openTool("NotebookEdit");
    for (const [x, why] of [["Edit", "не нашёл строку"], ["MultiEdit", "нет файла"], ["Write", "нет прав"], ["NotebookEdit", "ячейка не найдена"], ["TodoWrite", "список не принят"], ["ExitPlanMode", "план не принят"], ["AskUserQuestion", "вопрос не задан"]]) {
      expect(f.head(x).textContent, x).toContain("ошибка");
      expect(f.body(x)!.querySelector(".tb-pre.bad")!.textContent, x).toBe(why);
    }
    for (const x of ["Edit", "MultiEdit", "Write"]) expect(f.body(x)!.querySelector(".chat-diff"), x).not.toBeNull();
  });

  it("6714 вывод и поля инструмента только текстом: виден как написан, элементов нет", async () => {
    const evil = "<img src=x onerror=a()><script>a()</script>";
    const f = await feed([toolUse("b", "Bash", { command: evil, description: evil }), res("b", evil), toolUse("r", "Read", { file_path: "a.html" }), res("r", evil), toolUse("e", "Edit", { file_path: evil, old_string: evil, new_string: "x" }), toolUse("t", "TodoWrite", { todos: [{ content: evil, status: "pending" }] }), toolUse("q", "AskUserQuestion", { questions: [{ question: evil, options: [{ label: evil }] }] }), toolUse("a", "Agent", { prompt: evil }), toolUse("m", "mcp__x__y", { q: evil }), res("m", evil), { type: "assistant", uuid: uid(), error: evil, message: { id: uid(), content: [] } }]);
    for (const x of ["Bash", "Read", "mcp__x__y"]) await f.openTool(x);
    await f.open('[data-tool="Agent"] .dis-h');
    expect(f.q("img")).toBeNull();
    expect(f.q("script")).toBeNull();
    expect(f.text().split("<script>a()</script>").length).toBeGreaterThan(8);
  });
});

// ───────────── таблица санитайзера: разметка в ответе сессии ─────────────

type Md = { el: HTMLElement; mds: HTMLElement[]; html: string };
const SANITIZE: Array<[string, string, (m: Md) => void]> = [
  ["6220 заголовки, списки, таблица в прокрутке, задачи, цитата и код", "## Итог\n\n- [x] готово\n\n> цитата\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`код`", ({ el }) => {
    expect(el.querySelector("h2")!.textContent).toBe("Итог");
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".md-table table td")!.textContent).toBe("1");
    expect(el.querySelector("p code")!.textContent).toBe("код");
  }],
  ["6221 ссылка — в новой вкладке без доступа к странице; картинка без реферера; data:image показан", '[журнал](https://example.com/ci)\n\n![x](https://example.com/a.png)\n\n<img src="data:image/png;base64,AAA" alt="d">', ({ el }) => {
    const a = el.querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    const [x, d] = el.querySelectorAll("img");
    expect(x.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(d.getAttribute("src")).toBe("data:image/png;base64,AAA");
  }],
  ["6728 сырой pre без code: блок показывает этот текст", "<pre>сырой текст</pre>\n\n<pre><b>жирный</b> текст</pre>", ({ el }) => {
    const pres = el.querySelectorAll("pre");
    expect(pres[0].textContent).toBe("сырой текст");
    expect(pres[1].textContent).toBe("жирный текст");
  }],
  ["6224 разрешённая разметка рисуется элементами", "<kbd>K</kbd> <mark>метка</mark> H<sub>2</sub>O\n\n<details><summary>Ещё</summary>\n\nтекст\n\n</details>", ({ el }) => {
    for (const x of ["kbd", "mark", "sub", "details", "summary"]) expect(el.querySelector(x), x).not.toBeNull();
  }],
  ["6225 скрипты, обработчики, стили, iframe и опасные адреса вырезаны; текст остаётся", '<script>window.x=1</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><img src="x" onerror="window.x=1" alt="a"><a href="javascript:alert(1)" onclick="window.x=1">b</a><div style="position:fixed" onmouseover="window.x=1">c</div><form action="https://evil.example"><input name="k"></form>', ({ el, html }) => {
    for (const bad of ["<script", "<style", "<iframe", "onerror", "onclick", "onmouseover", "javascript:", "position:fixed", "<form", "evil.example", "window.x"]) expect(html, bad).not.toContain(bad);
    expect(el.querySelector("img")!.getAttribute("alt")).toBe("a");
    expect(el.textContent).toContain("c");
  }],
  ["6720 опасный адрес ссылки: нет href, текст виден", [...["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java&#9;script:alert(1)", "vbscript:x", "data:text/html,x", "blob:https://a/b", "file:///etc/passwd"].map((u, i) => `<a href="${u}">r${i}</a>`), "[m](javascript:alert(1))", "[r][1]", "", "[1]: javascript:alert(1)"].join("\n"), ({ el }) => {
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual([...Array.from({ length: 8 }, (_, i) => `r${i}`), "m", "r"]);
    for (const a of links) expect(a.hasAttribute("href"), a.textContent ?? "").toBe(false);
  }],
  ["6721 ссылка не задаёт себе окно и реферер: target и rel наши, ping и download нет", '<a href="https://example.com" target="_self" rel="opener" ping="https://evil.example" download>x</a>', ({ el }) => {
    const a = el.querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.hasAttribute("ping")).toBe(false);
    expect(a.hasAttribute("download")).toBe(false);
  }],
  ["6722 ссылка-приглашение и адрес этой страницы с #: без href, текст виден", (() => {
    const number = "ab12.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
    return [`#invite=${number}`, `#invite%3D${number}`, `#%69nvite=${number}`, `/#invite=${number}`, `?x=1#invite=${number}`, `https://pult.example/#invite=${number}`, "#card?callsign=site%40laptop", `${location.origin}${location.pathname}#settings`].map((u, i) => `[r${i}](${u})`).join("\n\n");
  })(), ({ el }) => {
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(Array.from({ length: 8 }, (_, i) => `r${i}`));
    for (const a of links) expect(a.hasAttribute("href"), a.textContent ?? "").toBe(false);
  }],
  ["6723 опасный адрес картинки: без src, подпись остаётся; referrerpolicy наш, crossorigin нет", '<img src="javascript:alert(1)" alt="a"> <img src="data:text/html,x" alt="b"> ![c](javascript:alert(1)) <img src="https://example.com/x.png" referrerpolicy="unsafe-url" crossorigin="use-credentials" alt="d">', ({ el }) => {
    const [a, b, c, d] = el.querySelectorAll("img");
    for (const x of [a, b, c]) expect(x.hasAttribute("src"), x.alt).toBe(false);
    expect([a.alt, b.alt, c.alt]).toEqual(["a", "b", "c"]);
    expect(d.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(d.hasAttribute("crossorigin")).toBe(false);
  }],
  ["6724 подделка интерфейса: классы, стиль, data и фокус сняты; поля и кнопки вырезаны, текст остаётся", '<div class="chat-ban bad" style="position:fixed" data-act="wipe" contenteditable autofocus>шапка</div><input type="password" name="p"><button>Войти</button><textarea>текст</textarea><select><option>o</option></select>', ({ el, mds }) => {
    const div = [...mds[0].querySelectorAll("div")].find((d) => d.textContent?.startsWith("шапка"))!;
    for (const attr of ["class", "style", "data-act", "contenteditable", "autofocus"]) expect(div.hasAttribute(attr), attr).toBe(false);
    for (const x of ["button", "textarea", "select"]) expect(mds[0].querySelector(x), x).toBeNull();
    expect(el.textContent).toContain("Войти");
    expect(el.textContent).toContain("текст");
    for (const i of mds[0].querySelectorAll("input")) {
      expect(i.getAttribute("type")).toBe("checkbox");
      expect(i.disabled).toBe(true);
    }
  }],
  ["6725 подмена имён страницы: id и name с приставкой", '<a id="location" name="key" href="https://example.com">a</a> <img id="body" name="cookie" alt="b">', ({ el }) => {
    expect(el.querySelector("a")!.id).toBe("user-content-location");
    expect(el.querySelector("a")!.getAttribute("name")).toBe("user-content-key");
    expect(el.querySelector("img")!.id).toBe("user-content-body");
    expect(document.body.tagName).toBe("BODY");
  }],
  ["6726 код не разбирается как HTML: виден как написан, элементов нет", "`<script>a()</script>`\n\n```html\n<script>a()</script><b>x</b>\n```\n\n&lt;script&gt;b()&lt;/script&gt; \\<b\\>c\\</b\\>", ({ el }) => {
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("p code")!.textContent).toBe("<script>a()</script>");
    expect(el.querySelector(".cb pre code")!.textContent).toBe("<script>a()</script><b>x</b>");
    expect(el.textContent).toContain("<script>b()</script>");
    expect(el.textContent).toContain("<b>c</b>");
  }],
  ["6727 язык блока не выходит в разметку: чужой класс снят, негодный язык без подписи", '```x"><img/src=x/onerror=a()>\nraw\n```\n\n<pre><code class="language-html x" onclick="a()">h</code></pre>\n\n<pre><code class="language-ts chat-ban">t</code></pre>', ({ el, html }) => {
    expect(el.querySelector("img")).toBeNull();
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("chat-ban");
    const [neg, ht, ts] = el.querySelectorAll(".cb");
    expect(neg.querySelector(".cb-l")!.textContent).toBe("");
    expect(neg.querySelector("pre code")!.textContent).toBe("raw");
    expect(ht.querySelector(".cb-l")!.textContent).toBe("html");
    expect(ts.querySelector(".cb-l")!.textContent).toBe("ts");
  }],
  ["6229 блок другого языка просмотра не предлагает", "```xml\n<a/>\n```\n\n```js\nconst s = '<script>';\n```", ({ el }) => {
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Просмотр")).toBe(false);
    expect(el.querySelector("iframe")).toBeNull();
  }],
];

describe("разметка в ответе", () => {
  it.each(SANITIZE)("%s", async (_name, md, check) => {
    const f = await feed([text(md)]);
    const el = f.q(".chat-reply")!;
    check({ el, mds: [...el.querySelectorAll<HTMLElement>(".md")], html: el.innerHTML });
  });

  it("6222 блок кода: язык, подсветка, текст без потерь, «копировать»; неизвестный язык без подсветки", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const f = await feed([text("```ts\nconst a = 1;\n```\n\n```brainfuck\n+++\n```")]);
    const [ts, bf] = f.qq(".cb");
    expect(ts.querySelector(".cb-l")!.textContent).toBe("ts");
    expect(ts.querySelector("pre code")!.textContent).toBe("const a = 1;");
    expect(ts.querySelector(".hljs-keyword")!.textContent).toBe("const");
    expect(bf.querySelector("pre code")!.textContent).toBe("+++");
    expect(bf.querySelector("[class^=hljs-]")).toBeNull();
    await f.t.click(ts.querySelector('[aria-label="Копировать"]'));
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("6729 сноска ведёт к тексту этой же страницы; новой вкладки и смены адреса нет", async () => {
    const f = await feed([text("x[^1]\n\n[^1]: текст сноски")]);
    const before = location.hash;
    const ref = f.q("sup a") as HTMLAnchorElement;
    const id = ref.getAttribute("href")!.slice(1);
    expect(ref.target).not.toBe("_blank");
    const target = f.q(`[id="${id}"]`)!;
    expect(target.textContent).toContain("текст сноски");
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    ref.dispatchEvent(click);
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(location.hash).toBe(before);
  });

  it("6734 копировать ответ: тексты через пустую строку; пишущийся и без текста — кнопки нет", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const f = await feed([say([{ type: "text", text: "раз" }, { type: "tool_use", id: "t1", name: "Read", input: {} }, { type: "text", text: "два" }])]);
    await f.open(".chat-acts button");
    expect(writeText).toHaveBeenCalledWith("раз\n\nдва");
    expect(f.q(".chat-acts")!.textContent).toBe("скопировано");
    expect((await feed([start("m"), textD("пишется")])).q(".chat-acts")).toBeNull();
    expect((await feed([toolUse("t2", "Read")])).q(".chat-acts")).toBeNull();
  });

  it("6730 теги не выходят за свой блок: соседние карточки целы", async () => {
    const f = await feed([text("до"), text("</div></div></div><div>выход</div></details><p>x"), text("после")]);
    const mds = f.qq(".md");
    expect(mds).toHaveLength(3);
    expect(mds[1].textContent).toContain("выход");
    expect(mds[0].textContent).toBe("до");
    expect(mds[2].textContent).toBe("после");
    expect(f.qq(".chat-reply")).toHaveLength(3);
  });

  it("6731 каждый вход разметки — через санитайзер: ответ, размышление, план, итог субагента, чужая сессия, сессия владельцу, сводка", async () => {
    const evil = '<script>window.x=1</script><img src=x onerror="window.x=1"><a href="javascript:alert(1)">z</a>';
    const t = await chat(IDLE, { wide: true });
    t.relay.push({ type: "message", from: IDLE, to: "phone", text: evil });
    await flush();
    const f = feedUi(t);
    await f.more([say([{ type: "thinking", thinking: evil }, { type: "text", text: evil }]), toolUse("p", "ExitPlanMode", { plan: evil }), toolUse("s", "Agent", { description: "d", prompt: "p" }), res("s", evil), human(`<fleet-message from="a@b">\n${evil}\n</fleet-message>`), sys("compact_boundary", { compact_metadata: { pre_tokens: 9000 } }), human(SUMMARY(evil), { isCompactSummary: true })]);
    for (const b of f.qq('[aria-expanded="false"]')) await t.click(b);
    expect(f.qq(".md").length).toBeGreaterThanOrEqual(6);
    const html = f.el().innerHTML;
    for (const bad of ["<script", "onerror", "javascript:", "window.x"]) expect(html, bad).not.toContain(bad);
  });

  it("6732 опасное приходит кусочками: ни на одном шаге нет обработчика и script", async () => {
    const f = await feed([start("m")]);
    for (const piece of ["<img src=x onerr", 'or="a()">', "<script>a(", ")</script>"]) {
      await f.more([textD(piece)]);
      expect(f.el().innerHTML).not.toContain("onerror=");
      expect(f.q("script")).toBeNull();
    }
  });

  it("6227 6228 6737 блок html и svg: сначала код; «Просмотр» — песочница allow-scripts с CSP; «Код» — обратно", async () => {
    for (const lang of ["html", "svg", "HTML"]) {
      const f = await feed([text(`\`\`\`${lang}\n<h1>Отчёт</h1>\n\`\`\``)]);
      const cb = f.q(".cb")!;
      expect(cb.querySelector("iframe"), lang).toBeNull();
      await f.t.click(pressIn(cb, "Просмотр")!);
      const frame = f.q(".cb iframe")!;
      expect(frame.getAttribute("sandbox"), lang).toBe("allow-scripts");
      const doc = frame.getAttribute("srcdoc")!;
      expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>"));
      expect(doc).toContain("default-src 'none'");
      expect(doc).toContain("webrtc 'block'");
      expect(doc).not.toMatch(/connect-src|https?:/);
      await f.t.click(pressIn(f.q(".cb")!, "Код")!);
      expect(f.q(".cb iframe"), lang).toBeNull();
    }
  });

  it("6735 ответ — целый документ: готовый — блок с просмотром; пишущийся — как текст", async () => {
    const doc = "<!doctype html><html><body><h1>д</h1></body></html>";
    const ready = await feed([text(doc)]);
    expect(pressIn(ready.el(), "Просмотр")).toBeDefined();
    const going = await feed([start("m"), textD(doc)]);
    expect(pressIn(going.el(), "Просмотр")).toBeUndefined();
    expect(going.q(".chat-txt")).not.toBeNull();
  });

  it("6736 6739 запись файла HTML: .html .svg .htm и doctype — страница и дифф; .md — только дифф", async () => {
    const f = await feed([toolUse("w1", "Write", { file_path: "a.html", content: "<b>x</b>" }), toolUse("w2", "Write", { file_path: "a.svg", content: "<svg></svg>" }), toolUse("w3", "Write", { file_path: "a.md", content: "# x" }), toolUse("w4", "Write", { file_path: "a.htm", content: "<b>x</b>" }), toolUse("w5", "Write", { file_path: "a.txt", content: "<!doctype html><p>д</p>" })]);
    // рамка без знака от документа снимается по таймеру: смотрим сразу после раскрытия
    const seen: Array<[boolean, boolean]> = [];
    for (const c of f.qq('[data-tool="Write"]')) {
      await f.t.click(c.querySelector(".tc-h"));
      seen.push([!!c.querySelector("iframe"), !!c.querySelector(".chat-diff")]);
    }
    expect(seen).toEqual([[true, true], [true, true], [false, true], [true, true], [true, true]]);
  });

  it("6738 документ сам не запускается: рамки нет, пока человек не нажал или не раскрыл", async () => {
    const doc = "<!doctype html><script>a()</script>";
    const f = await feed([text(doc), text("```html\n<script>a()</script>\n```"), toolUse("w", "Write", { file_path: "a.html", content: doc })]);
    expect(f.q("iframe")).toBeNull();
    await f.open('[data-tool="Write"] .tc-h');
    expect(f.qq("iframe")).toHaveLength(1);
  });

  it("6740 документ в сообщении другой сессии и сессии владельцу: только разметка, рамки и «Просмотр» нет", async () => {
    const doc = '<!doctype html><html><body onload="a()"><script>a()</script><h1>д</h1>';
    const t = await chat(IDLE, { wide: true });
    t.relay.push({ type: "message", from: IDLE, to: "phone", text: doc });
    await flush();
    const f = feedUi(t);
    await f.more([human(`<fleet-message from="a@b">\n${doc}\n</fleet-message>`)]);
    expect(f.q("iframe")).toBeNull();
    expect(pressIn(f.el(), "Просмотр")).toBeUndefined();
    expect(f.qq("h1")).toHaveLength(2);
    expect(f.q("script")).toBeNull();
    expect(f.el().innerHTML).not.toContain("onload");
  });
});

// ───────────── лента: подписка, история, связь ─────────────

/** Экран с историей, которую можно подменить: следующая пачка с разрывом seq запросит её заново. */
async function withRefetch(o: { first?: unknown[] } = {}) {
  let page: unknown[] = o.first ?? [];
  const relay = relayFor();
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: page, more: false } });
  const t = await chat(IDLE, { relay, wide: true });
  let seq = 1;
  const f = feedUi(t, { n: 0 });
  const live = (msgs: Msg[]) => t.events(IDLE, msgs, seq++);
  const refetch = async (messages: unknown[]) => {
    page = messages;
    seq += 2;
    await t.events(IDLE, [], seq++);
  };
  return { t, f, relay, live, refetch };
}

describe("лента", () => {
  it("открытие: session.watch, потом session.history; события рисуются; одно по uuid; итог инструмента (чьё: код)", async () => {
    const relay = relayFor(homeRoster(), [user("u1", "Почини сборку на CI — падает с утра"), asst("a1", [{ type: "text", text: "Смотрю лог CI." }])]);
    const t = await stand(parts(), { relay, url: `/#card?callsign=${encodeURIComponent(BUSY)}` });
    const own = relay.got.filter((x) => x.type.startsWith("session.") && x.callsign === BUSY);
    expect(own.map((x) => x.type)).toEqual(["session.watch", "session.history"]);
    expect(own[1]).toMatchObject({ v: 1, before: null, limit: 50 });
    relay.push({ type: "session.events", from: BUSY, seq: 42, events: [asst("a1", [{ type: "text", text: "Смотрю лог CI." }]), asst("a2", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]), { type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", elapsed_time_seconds: 18 }, { type: "stream_event", event: {} }] });
    await flush();
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["Смотрю лог CI."]);
    expect(t.$(".chat-tool")!.textContent).toBe("Командаnpm test18 с");
    relay.push({ type: "session.events", from: BUSY, seq: 43, events: [{ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }, { type: "result", uuid: "z1", subtype: "success", duration_ms: 134_000 }] });
    await flush();
    expect(t.$(".chat-tool")!.textContent).toBe("Командаnpm test");
    expect(t.$(".chat-res")!.textContent).toBe("ход закончен · 2 мин 14 с");
    expect(relay.sent("session.history")).toHaveLength(1);
  });

  it("6654 6653 первая пачка без истории; разрыв seq — история заново, подписка та же", async () => {
    const t = await chat(IDLE);
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "раз" }])], 40);
    expect(t.$(".chat-txt")!.textContent).toBe("раз");
    expect(t.relay.sent("session.history")).toHaveLength(1);
    await t.events(IDLE, [asst("a2", [{ type: "text", text: "два" }])], 42);
    expect(t.relay.sent("session.history")).toHaveLength(2);
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["раз", "два"]);
    await t.events(IDLE, [], 1);
    expect(t.relay.sent("session.history")).toHaveLength(3);
    expect(t.relay.sent("session.watch")).toHaveLength(1);
  });

  it("6655 6212 «Раньше»: страница перед текущими, итог, ждавший вызова, — в его карточке", async () => {
    const relay = relayFor();
    relay.handlers["session.history"] = (x) => (x.before ? { ok: true, result: { messages: [user("u1", "раньше"), asst("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }])], more: false } } : { ok: true, result: { messages: [{ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "вывод" }] } }, user("u2", "потом")], more: true } });
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.$(".chat-older"));
    expect(relay.sent("session.history").at(-1)).toMatchObject({ before: "r1" });
    expect(t.$$(".chat-me").map((x) => x.textContent)).toEqual([expect.stringContaining("раньше"), expect.stringContaining("потом")]);
    expect(t.$(".chat-older")).toBeNull();
    expect(t.$('[data-tool="Bash"]')!.getAttribute("data-state")).toBe("ok");
  });

  it("6656 «Раньше» отказал: тост словом, кнопка и лента на месте", async () => {
    const relay = relayFor();
    relay.handlers["session.history"] = (x) => (x.before ? { ok: false, error: "offline" } : { ok: true, result: { messages: [user("u2", "потом")], more: true } });
    const t = await chat(IDLE, { relay });
    await t.click(t.$(".chat-older"));
    expect(t.$(".sb-toast")!.textContent).toBe(`${IDLE}: session.history — offline`);
    expect(t.$(".chat-older")).not.toBeNull();
    expect(t.$(".chat-me")).not.toBeNull();
  });

  it("6646 6647 6648 6652 повторная история: команда одна, шаги субагента целы, порядок прежний, сводка одна", async () => {
    const cmd = user("c1", "<command-name>/context</command-name>");
    const out = user("c2", "<local-command-stdout>42%</local-command-stdout>");
    const call = asst("a1", [{ type: "tool_use", id: "T", name: "Agent", input: {} }]);
    const step = { ...asst("a2", [{ type: "text", text: "шаг" }]), parent_tool_use_id: "T" };
    const sum = human(SUMMARY("суть"), { isCompactSummary: true });
    const a = await withRefetch();
    await a.live([cmd, out, call, step, { type: "tool_use_summary", uuid: "s1", summary: "сводка", preceding_tool_use_ids: ["T"] }, res("T", "итог из кадра"), sys("compact_boundary", { compact_metadata: { pre_tokens: 90_000 } }), sum]);
    await a.refetch([cmd, out, call, sum]);
    expect(a.t.$$(".chat-cmd")).toHaveLength(1);
    expect(a.t.$(".tb-steps .chat-txt, .tc-note")).not.toBeNull();
    expect(a.t.$(".tc-note")!.textContent).toBe("сводка");
    expect(a.t.$$(".chat-sum")).toHaveLength(1);
    expect(a.t.$(".chat-sum")!.textContent).toContain("контекст сжат · 90 К");
    const b = await withRefetch({ first: [user("u3", "в"), user("u4", "г")] });
    await b.refetch([user("u3", "в"), user("u4", "г")]);
    expect(b.t.$$(".chat-me").map((x) => x.textContent?.slice(0, 1))).toEqual(["в", "г"]);
  });

  it("6211 6649 история нашла свой пузырь — с его вложениями; неотвеченный и живое остаются следом", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => undefined;
    let page: unknown[] = [];
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: page, more: false } });
    const t = await chat(IDLE, { relay, wide: true });
    await t.pick(new File(["x"], "a.png", { type: "image/png" }));
    await t.type("Смотри");
    await t.click(t.$(".chat-send"));
    const id = String(relay.sent("session.prompt")[0].uuid);
    await t.type("второе");
    await t.click(t.$(".chat-send"));
    await t.events(IDLE, [asst("a9", [{ type: "text", text: "живое" }])], 1);
    page = [user(id, "Смотри"), asst("a1", [{ type: "text", text: "из истории" }])];
    await t.events(IDLE, [], 5);
    expect(t.$$(".chat-me")).toHaveLength(2);
    expect(t.$$(".chat-me")[0].querySelector("img")).not.toBeNull();
    expect(t.$$(".chat-me")[0].querySelector("small")!.textContent).toMatch(/✓✓$/);
    expect(t.$$(".chat-txt").map((x) => x.textContent)).toEqual(["из истории", "живое"]);
    expect(t.$$(".chat-me")[1].textContent).toContain("второе");
  });

  it("6699 сообщения сессии: метка на закрытом чате, пуш без нажатия; открытый — сразу; обрыв их не теряет; roster без смены аккаунта — строки нет", async () => {
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
    expect(t.$$(".chat-in")[0].textContent).toMatch(/^poe-bot → вампервое\d\d:\d\d$/);
    relay.push({ type: "message", from: IDLE, to: "phone", text: "третье" });
    await flush();
    expect(t.$$(".chat-in")).toHaveLength(3);
    relay.drop();
    await reconnect();
    expect(t.$$(".chat-in")).toHaveLength(3);
    relay.setRoster(roster());
    await flush();
    expect(t.$$(".chat-sys.swap")).toHaveLength(0);
    await t.click(t.button("‹"));
    expect(t.$(`[data-callsign="${IDLE}"] .sb-badge`)).toBeNull();
  });

  it("4104 сменился account сессии — строка «аккаунт: было → стало», кадров нет", async () => {
    const relay = relayFor(roster((x) => void (x.sessions[0].account = "infirex")));
    const t = await chat(BUSY, { relay, wide: true });
    const before = relay.got.length;
    relay.setRoster(roster((x) => void (x.sessions[0].account = "yurianrun")));
    await flush();
    expect(t.$(".chat-sys.swap")!.textContent).toBe("аккаунт: infirex → yurianrun");
    expect(relay.got.length).toBe(before);
  });

  it("6696 индикатор работы: занятая, размышляет, сжатие, простой; панели на узком нет", async () => {
    const narrow = await chat(BUSY);
    expect(narrow.$(".chat-bar")).toBeNull();
    expect(narrow.$(".chat-work i")).not.toBeNull();
    await narrow.events(BUSY, [{ type: "system", subtype: "thinking_tokens", uuid: "s1", estimated_tokens: 1500 }], 1);
    expect(narrow.$(".chat-work")!.textContent).toBe("размышляет · 1.5 К");
    await narrow.events(BUSY, [{ type: "system", subtype: "status", uuid: "s2", status: "compacting" }], 2);
    expect(narrow.$(".chat-work")!.textContent).toBe("Сжимаю контекст…");
    await narrow.events(BUSY, [{ type: "system", subtype: "compact_boundary", uuid: "s3", compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } }], 3);
    expect(narrow.$(".chat-work")!.textContent).not.toContain("Сжимаю");
    expect(narrow.$(".chat-sys")!.textContent).toBe("контекст сжат · 90 К → 8 К");
    const idle = await chat(IDLE);
    await idle.events(IDLE, [{ type: "system", subtype: "thinking_tokens", uuid: "s4", estimated_tokens: 1500 }, { type: "system", subtype: "session_state_changed", uuid: "s5", state: "idle" }], 1);
    expect(idle.$(".chat-work")).toBeNull();
  });

  it("6695 прокрутка: ушёл вверх — кнопка, нажатие возвращает вниз", async () => {
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

  it("6213 6697 фокус: на виду ошибка и прерывание; сводка шагов; вопрос и итоговый текст на виду; снят — всё по-прежнему", async () => {
    const relay = relayFor(roster(), [user("u1", "Почини"), asst("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }]), { type: "assistant", uuid: "a2", error: "overloaded", message: { id: "a2", content: [{ type: "text", text: "промежуточный" }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } }, user("i1", "[Request interrupted by user]")]);
    const t = await chat(IDLE, { relay, wide: true });
    const focus = t.btn(".chat-bar", "фокус")!;
    await t.click(focus);
    expect(t.$(".chat-col .chat-ban.bad")).not.toBeNull();
    expect(t.$(".chat-col > .chat-sys.wait")!.textContent).toContain("прервано");
    expect(t.$(".chat-steps")!.textContent).toContain("2 шага");
    expect(t.$(".chat-col > .chat-reply")).toBeNull();
    await t.click(focus);
    expect(focus.getAttribute("aria-pressed")).toBe("false");
    expect(t.$$(".chat-tool")).toHaveLength(2);
    expect(t.$(".chat-steps")).toBeNull();

    const b = relayFor(roster(), [user("u1", "Почини"), asst("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }]), asst("a3", [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: {} }]), asst("a4", [{ type: "text", text: "Готово" }]), { type: "result", uuid: "z1", subtype: "success" }]);
    const u = await chat(IDLE, { relay: b, wide: true });
    await u.click(u.btn(".chat-bar", "фокус"));
    expect(u.$(".chat-steps")!.textContent).toContain("Команда");
    expect(u.$('.chat-col [data-tool="AskUserQuestion"]')).not.toBeNull();
    expect(u.$(".chat-txt")!.textContent).toBe("Готово");
    expect(u.$(".chat-res")).not.toBeNull();
  });

  it("6698 выгрузка переписки .md: сообщения от других и сессии владельцу", async () => {
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

  it("6717 запись не той формы: «Лента выключена» с причиной, другие экраны работают", async () => {
    const relay = relayFor(roster(), [{ type: "assistant", uuid: "a", message: { id: "a", content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: "строка" } }] } }]);
    const t = await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent(BUSY)}` });
    await flush();
    expect(t.root.textContent).toContain("Лента выключена");
    expect(t.root.textContent).toContain("Перезапустить приложение");
    expect(t.run.failed["web-chat"]).toContain("экране chat");
    await t.go(`#ask?callsign=${encodeURIComponent(BUSY)}`);
    expect(t.run.failed["web-ask"]).toBeUndefined();
    expect(t.root.textContent).not.toContain("выключена");
  });
});

describe("подписка и связь", () => {
  it("4101 6660 подписка и история отказали: отказ словом, ввод работает; после новой связи отказ снят", async () => {
    const relay = relayFor();
    relay.handlers["session.watch"] = () => ({ ok: false, error: "stopped" });
    relay.handlers["session.history"] = () => ({ ok: false, error: "stopped" });
    const t = await chat(IDLE, { relay });
    expect(t.$('.chat-note[role="alert"]')!.textContent).toContain("session.watch: stopped");
    expect(t.$(".chat-feed")!.textContent).not.toContain("Сообщений пока нет");
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(relay.sent("session.prompt")).toHaveLength(1);
    expect(t.run.failed).toEqual({});
    relay.handlers["session.watch"] = () => ({ ok: true });
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
    relay.drop();
    await reconnect();
    expect(t.$('.chat-note[role="alert"]')).toBeNull();
  });

  it("6595 оборвалось соединение с машиной открытой сессии: session.watch и session.history заново", async () => {
    const relay = relayFor();
    const t = await chat(BUSY, { relay });
    expect(t.relay.sent("session.watch").filter((x) => x.callsign === BUSY)).toHaveLength(1);
    relay.open.find((s) => s.url.endsWith("/m/laptop"))!.serverClose(1006, "");
    await reconnect();
    expect(relay.open.some((s) => s.url.endsWith("/m/laptop"))).toBe(true);
    expect(relay.got.filter((x) => (x.type === "session.watch" || x.type === "session.history") && x.callsign === BUSY).slice(-2).map((x) => x.type)).toEqual(["session.watch", "session.history"]);
  });

  it("6657 Host поднялся заново — новый since: подписка и история заново, тот же roster не повторяет", async () => {
    const t = await chat(IDLE);
    expect(t.relay.sent("session.watch")).toHaveLength(1);
    const back = roster();
    back.machines[1].since = 2;
    t.relay.setRoster(back);
    await flush();
    expect(t.relay.sent("session.watch")).toHaveLength(2);
    expect(t.relay.got.filter((x) => x.type === "session.watch" || x.type === "session.history").slice(-2).map((x) => x.type)).toEqual(["session.watch", "session.history"]);
    t.relay.setRoster(back);
    await flush();
    expect(t.relay.sent("session.watch")).toHaveLength(2);
  });

  it("7217 вернулась другая машина: подписка открытой сессии и настройки не читаются заново", async () => {
    const relay = relayFor();
    await chat(BUSY, { relay });
    const other = relay.open.find((s) => !s.url.endsWith("/m/laptop"))!;
    const was = { watch: relay.sent("session.watch").length, prefs: relay.sent("prefs.get").length };
    expect(was.watch).toBe(1);
    other.serverClose(1006, "");
    await reconnect();
    expect(relay.open.some((s) => s.url === other.url)).toBe(true);
    expect(relay.sent("session.watch").length - was.watch).toBe(0);
    expect(relay.sent("prefs.get").length - was.prefs).toBe(0);
  });

  it("6658 машины нет в roster при открытии: подписка, когда машина появилась", async () => {
    const relay = relayFor();
    const t = await stand(parts(), { relay });
    const noPc = roster();
    noPc.machines = noPc.machines.filter((m) => m.machine !== "pc");
    noPc.sessions = noPc.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    relay.setRoster(noPc);
    await flush();
    await open(`/#chat?callsign=${encodeURIComponent(IDLE)}`);
    expect(relay.sent("session.watch").filter((x) => x.callsign === IDLE)).toHaveLength(0);
    relay.setRoster(roster());
    await flush();
    expect(relay.sent("session.watch").filter((x) => x.callsign === IDLE)).toHaveLength(1);
    expect(relay.sent("session.history").filter((x) => x.callsign === IDLE)).toHaveLength(1);
    expect(t.$(".chat-feed")).not.toBeNull();
  });

  it("6659 нет истории в contract: только подписка, живое рисуется, отказа нет", async () => {
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

  it("E6 подписка молчит: через 10 с слово, история спрошена и ждёт дальше 10 с (слово пользователя 4 нояб.)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const relay = new FakeRelay(homeRoster());
      relay.handlers["session.watch"] = () => undefined as never;
      relay.handlers["session.history"] = () => undefined as never;
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const t = await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent(BUSY)}` });
      await flush();
      expect(relay.sent("session.watch")).toHaveLength(1);
      expect(relay.sent("session.history")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_500);
      await flush();
      expect(relay.sent("session.history")).toHaveLength(1);
      expect(t.text()).toContain("session.watch: timeout");
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(t.text()).not.toContain("session.history: timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("уход с экрана — session.unwatch; штатная остановка снимает подписки и сохраняет черновики (6661)", async () => {
    const store = memoryStore({ key: KEY });
    const relay = relayFor();
    const t = await stand(parts(), { relay, store, url: `/#card?callsign=${encodeURIComponent(BUSY)}` });
    set(t.$<HTMLTextAreaElement>(".chat-inp")!, "недописанное");
    await t.click(t.button("‹"));
    expect(relay.sent("session.unwatch")[0]).toMatchObject({ callsign: BUSY });
    expect(store.data.drafts).toEqual({ [BUSY]: "недописанное" });
    await open(`/#chat?callsign=${encodeURIComponent(IDLE)}`);
    set(t.$<HTMLTextAreaElement>(".chat-inp")!, "второй");
    await t.run.hide();
    expect(relay.sent("session.unwatch").map((x) => x.callsign)).toEqual([BUSY, IDLE]);
    expect(store.data.drafts).toEqual({ [BUSY]: "недописанное", [IDLE]: "второй" });
  });

  it("6670 7022 7296 черновик переживает экран и запуск страницы; в хранилище только непустые", async () => {
    const store = memoryStore({ key: KEY, drafts: { "other@pc": "прежний" } });
    const t = await chat(BUSY, { store, wide: true });
    await t.type("недописанное");
    await t.go("#sessions");
    await flush();
    expect(store.data.drafts).toEqual({ "other@pc": "прежний", [BUSY]: "недописанное" });
    await t.go(`#chat?callsign=${encodeURIComponent(BUSY)}`);
    await flush();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("недописанное");
    await t.run.hide();
    const again = await chat(BUSY, { store, wide: true });
    expect(again.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("недописанное");
    await again.type("");
    await again.go("#sessions");
    await flush();
    expect(store.data.drafts).toEqual({ "other@pc": "прежний" });
  });
});

// ───────────── ввод ─────────────

const txt = (name: string, type = "text/plain", body = "x") => new File([body], name, { type });

describe("ввод", () => {
  it("6662 session.prompt с uuid → «доставлено»; поле пусто; Shift+Enter не шлёт (чьё: код)", async () => {
    const t = await chat(IDLE);
    await t.type("раз\nдва");
    await t.key("Enter", { shiftKey: true });
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    await t.click(t.$(".chat-send"));
    const p = t.relay.sent("session.prompt")[0];
    expect(p).toMatchObject({ v: 1, callsign: IDLE, text: "раз\nдва" });
    expect(typeof p.uuid).toBe("string");
    expect(t.$(".chat-me small")!.textContent).toMatch(/\d\d:\d\d · доставлено$/);
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
  });

  it("4103 пустое сообщение — кнопка недоступна, Enter ничего не шлёт", async () => {
    const t = await chat(BUSY);
    await t.type("   ");
    expect(t.$<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
    await t.key("Enter");
    expect(t.relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".chat-me")).toBeNull();
  });

  it("6663 эхо раньше ответа: ✓✓ остаётся после ответа", async () => {
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

  it.each([
    ["offline", `${IDLE}: не доставлено — pc не на связи. Черновик цел.`],
    ["stopped", `${IDLE}: не доставлено — сессия остановлена. Черновик цел.`],
  ])("отказ %s: пузыря нет, текст в поле, тост (6103)", async (error, toast) => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error });
    const t = await chat(IDLE, { relay });
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.focus();
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    await flush();
    expect(t.$(".chat-me")).toBeNull();
    expect(inp.value).toBe("Катим");
    expect(document.activeElement).toBe(inp);
    expect(t.$(".sb-toast")!.textContent).toBe(toast);
  });

  it("6243 6668 отказ возвращает вложения; поле не пусто — текст человека не затирается и тост это говорит", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "offline" });
    const t = await chat(IDLE, { relay, wide: true });
    await t.pick(txt("b.txt"));
    await t.type("смотри");
    await t.click(t.$(".chat-send"));
    await flush();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["b.txt"]);
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("смотри");

    const late = relayFor();
    late.handlers["session.prompt"] = () => undefined;
    const u = await chat(IDLE, { relay: late });
    await u.pick(txt("a.txt"));
    await u.type("первое");
    await u.click(u.$(".chat-send"));
    await u.type("новое");
    late.reply(String(late.sent("session.prompt")[0].id), { ok: false, error: "offline" });
    await flush();
    expect(u.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("новое");
    expect(u.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.txt"]);
    const toast = u.$(".sb-toast")!.textContent;
    expect(toast).toContain("не доставлено — pc не на связи");
    expect(toast).not.toContain("Черновик цел");
    expect(toast).toContain("текст не возвращён");
  });

  it("6669 отказ при закрытом чате: тост, текст — в черновике", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => undefined;
    const t = await chat(IDLE, { relay });
    await t.pick(txt("a.txt"));
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    await t.click(t.button("‹"));
    relay.reply(String(relay.sent("session.prompt")[0].id), { ok: false, error: "offline" });
    await flush();
    expect(document.querySelector(".sb-toast")!.textContent).toContain("Черновик цел, вложения не сохранены");
    await open(`/#chat?callsign=${encodeURIComponent(IDLE)}`);
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Катим");
    expect(t.$(".chat-me")).toBeNull();
  });

  it.each([["timeout"], ["disconnected"]])("6665 6666 %s — не отказ: пузырь «не подтверждено», поле пусто, тоста нет", async (error) => {
    // решение главной сессии 4 нояб.: сообщение могло дойти
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error });
    const t = await chat(IDLE, { relay });
    await t.type("Катим");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me.pend")).not.toBeNull();
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
    expect(t.$(".sb-toast")!.hidden).toBe(true);
  });

  it("6664 без связи: кадра нет, пузырь ждёт", async () => {
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

  it("6665 6667 «отправить ещё раз»: тот же uuid с вложениями; повтор получил отказ — текст в поле, тост", async () => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "disconnected" });
    const t = await chat(IDLE, { relay });
    await t.pick(txt("a.txt"));
    await t.type("Смотри");
    await t.click(t.$(".chat-send"));
    relay.handlers["session.prompt"] = (x) => ({ ok: true, result: { uuid: x.uuid } });
    await t.click(t.btn(".chat-me", "отправить ещё раз"));
    const [first, again] = relay.sent("session.prompt");
    expect(again.uuid).toBe(first.uuid);
    expect(again).toMatchObject({ text: "Смотри", attachments: [{ name: "a.txt", media_type: "text/plain" }] });

    const b = relayFor();
    b.handlers["session.prompt"] = () => ({ ok: false, error: "disconnected" });
    const u = await chat(IDLE, { relay: b });
    await u.type("Катим");
    await u.click(u.$(".chat-send"));
    b.handlers["session.prompt"] = () => ({ ok: false, error: "stopped" });
    await u.click(u.btn(".chat-me", "отправить ещё раз"));
    expect(u.$(".chat-me")).toBeNull();
    expect(u.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Катим");
    expect(u.$(".sb-toast")!.textContent).toBe(`${IDLE}: не доставлено — сессия остановлена. Черновик цел.`);
  });

  it("6671 4106 вложить и отправить: убранное не уходит; картинка видна, файл подписью, поле вложений пусто", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.pick(txt("a.txt"), txt("b.txt"), txt("c.png", "image/png"));
    expect(t.$(".chat-file img")).not.toBeNull();
    await t.click(t.$('[aria-label="убрать b.txt"]'));
    await t.type("смотри");
    await t.click(t.$(".chat-send"));
    const p = t.relay.sent("session.prompt")[0];
    expect((p.attachments as Array<{ name: string }>).map((a) => a.name)).toEqual(["a.txt", "c.png"]);
    expect(p.attachments).toMatchObject([{ name: "a.txt", media_type: "text/plain", data: "eA==" }, {}]);
    expect(t.$(".chat-me img")).not.toBeNull();
    expect(t.$(".chat-att")!.textContent).toBe("a.txt");
    expect(t.$(".chat-file")).toBeNull();
  });

  it("6672 вставка файла и перетаскивание", async () => {
    const t = await chat(IDLE);
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [txt("p.png", "image/png")] } });
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
    drag("drop", { types: ["Files"], files: [txt("d.txt")] });
    await flush(10);
    expect(t.$(".chat-comp.drag")).toBeNull();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["p.png", "d.txt"]);
  });

  it("6673 только вложения: кнопка доступна, текст пуст", async () => {
    const t = await chat(IDLE);
    await t.pick(txt("c.png", "image/png"));
    expect(t.$<HTMLButtonElement>(".chat-send")!.disabled).toBe(false);
    await t.click(t.$(".chat-send"));
    expect(t.relay.sent("session.prompt")[0]).toMatchObject({ text: "", attachments: [{ name: "c.png" }] });
    expect(t.$(".chat-me img")).not.toBeNull();
  });

  it.each([["bad_frame"], ["too_large"]])("6675 %s: вложение остаётся, пузыря нет, тост со словом", async (error) => {
    const relay = relayFor();
    relay.handlers["session.prompt"] = () => ({ ok: false, error });
    const t = await chat(IDLE, { relay });
    await t.pick(new File(["x"], "a.bin"));
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.bin"]);
    await t.click(t.$(".chat-send"));
    expect(relay.sent("session.prompt")[0]).toMatchObject({ attachments: [{ media_type: "application/octet-stream" }] });
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$$(".chat-file").map((x) => x.textContent)).toEqual(["a.bin"]);
    expect(t.$(".sb-toast")!.textContent).toContain(error);
  });
});

describe("подсказки ввода", () => {
  const withCommands = () => {
    const relay = relayFor();
    relay.handlers["session.call"] = (x) => (x.method === "supportedCommands" ? { ok: true, result: [{ name: "review", description: "ревью" }, { name: "reload" }] } : { ok: true, result: null });
    return relay;
  };

  it("6676 клавиши: стрелка, Tab, Esc, Enter; второй Enter шлёт", async () => {
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

  it("6677 кнопки над полем: файл папки и команда", async () => {
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
    expect(relay.sent("session.call").filter((x) => x.method === "supportedCommands")).toHaveLength(1);
  });

  it("6678 текст без подсказок: запросов нет", async () => {
    const t = await chat(IDLE, { relay: withCommands() });
    t.relay.handlers["session.files"] = () => ({ ok: true, result: ["a"] });
    await t.type("почта me@host и путь /tmp/x");
    expect(t.$(".chat-sug")).toBeNull();
    expect(t.relay.sent("session.files")).toHaveLength(0);
    expect(t.relay.sent("session.call")).toHaveLength(0);
  });

  it("6679 быстрый набор после @: поздний ответ на старый запрос не сбрасывает", async () => {
    const relay = relayFor();
    const asked: Array<{ id: string; query: string }> = [];
    relay.handlers["session.files"] = (x) => (asked.push({ id: String(x.id), query: String(x.query) }), undefined);
    const t = await chat(IDLE, { relay });
    await t.type("@w");
    await t.type("@wor");
    relay.reply(asked[1].id, { ok: true, result: ["worker.ts"] });
    await flush();
    relay.reply(asked[0].id, { ok: true, result: ["web.ts"] });
    await flush();
    expect(t.$$(".chat-sugi").map((x) => x.textContent)).toEqual(["worker.ts"]);
  });

  it("6680 4102 подсказка Claude: Tab в пустом поле — в поле; при тексте скрыта; следующий ход снимает; кадров нет", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [{ type: "prompt_suggestion", suggestion: "Запусти тесты" }], 1);
    expect(t.$(".chat-hint")!.textContent).toBe("Запусти тестыTab");
    const before = t.relay.got.length;
    await t.key("Tab");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Запусти тесты");
    expect(t.relay.got.length).toBe(before);

    const u = await chat(IDLE);
    await u.events(IDLE, [{ type: "prompt_suggestion", suggestion: "Запусти" }], 1);
    await u.type("свой");
    expect(u.$(".chat-hint")).toBeNull();
    await u.key("Tab");
    expect(u.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("свой");
    await u.type("");
    expect(u.$(".chat-hint")).not.toBeNull();
    await u.events(IDLE, [asst("a1", [{ type: "text", text: "ход" }])], 2);
    expect(u.$(".chat-hint")).toBeNull();
  });

  it("6681 метод подсказок отказал: списка нет, запрос один, Enter шлёт", async () => {
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

  it("6682 у неживой сессии кнопки команд нет, файл и вложение есть", async () => {
    const t = await chat(STOPPED);
    expect(t.$('[aria-label="Команда"]')).toBeNull();
    expect(t.$('[aria-label="Файл папки"]')).not.toBeNull();
    expect(t.$('[aria-label="Вложить файл"]')).not.toBeNull();
  });
});

const calls = (relay: FakeRelay, method: string) => relay.sent("session.call").filter((x) => x.method === method);
const answerWith = (relay: FakeRelay, table: Record<string, () => unknown>) => {
  relay.handlers["session.call"] = (x) => {
    const a = table[String(x.method)];
    return a ? (a() as never) : { ok: true, result: [] };
  };
};

describe("вопрос сбоку", () => {
  it("7010 7011 «/btw»: думает, затем ответ разметкой; в ленту и session.prompt не идёт; крестик закрывает один", async () => {
    const relay = relayFor();
    let replied = false;
    answerWith(relay, { askSideQuestion: () => (replied ? { ok: true, result: { response: "Ответ **сбоку**" } } : undefined) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("/btw первый?");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-side")!.getAttribute("data-state")).toBe("wait");
    expect(t.$(".chat-side")!.textContent).toContain("думает");
    replied = true;
    await t.type("/btw какая версия?");
    await t.click(t.$(".chat-send"));
    expect(t.$$(".chat-side").map((x) => x.getAttribute("data-state"))).toEqual(["wait", "done"]);
    expect(calls(relay, "askSideQuestion")[1]).toMatchObject({ callsign: IDLE, args: ["какая версия?"] });
    expect(relay.sent("session.prompt")).toHaveLength(0);
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$$(".chat-side")[1].textContent).toContain("какая версия?");
    expect(t.$$(".chat-side")[1].querySelector("strong")!.textContent).toBe("сбоку");
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("");
    await t.click(t.$(".chat-side [aria-label='Закрыть']"));
    expect(t.$$(".chat-side").map((x) => x.getAttribute("data-state"))).toEqual(["done"]);
  });

  it("7012 отказ метода — слово в карточке, тоста нет", async () => {
    const relay = relayFor();
    answerWith(relay, { askSideQuestion: () => ({ ok: false, error: "sdk_error" }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("/btw что?");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-side")!.getAttribute("data-state")).toBe("bad");
    expect(t.$(".chat-side")!.textContent).toContain("Claude отказал, причина в журнале машины");
    expect(t.$(".sb-toast")?.textContent ?? "").toBe("");
  });

  it("7013 «/b» — в подсказках «/btw»; нет session.call — ни подсказки, ни вопроса", async () => {
    const relay = relayFor();
    answerWith(relay, { supportedCommands: () => ({ ok: true, result: [{ name: "compact" }] }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("/b");
    expect(t.$$(".chat-sugi b").map((x) => x.textContent)).toEqual(["/btw"]);
    const r2 = roster((x) => {
      for (const m of x.machines) delete m.contract!["session.call"];
    });
    const relay2 = relayFor(r2);
    const u = await chat(IDLE, { relay: relay2, wide: true });
    await u.type("/btw что?");
    expect(u.$(".chat-sugi")).toBeNull();
    await u.click(u.$(".chat-send"));
    expect(relay2.sent("session.prompt")[0]).toMatchObject({ text: "/btw что?" });
    expect(u.$(".chat-side")).toBeNull();
  });
});

describe("очередь", () => {
  const busy = () => roster((x) => void (x.sessions.find((s) => s.callsign === IDLE)!.state = "busy"));

  it("7023 в занятую: «в очереди» и «отменить»; эхо — «доставлено», кнопки нет", async () => {
    const relay = relayFor(busy());
    const t = await chat(IDLE, { relay });
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me small")!.textContent).toBe("в очереди");
    expect(t.btn(".chat-me", "отменить")).not.toBeNull();
    await t.events(IDLE, [user(String(relay.sent("session.prompt")[0].uuid), "Потом")], 1);
    expect(t.$(".chat-me small")!.textContent).toMatch(/доставлено$/);
    expect(t.btn(".chat-me", "отменить")).toBeNull();
  });

  it("7016 «отменить» снято: пузыря нет, текст и вложение в поле", async () => {
    const relay = relayFor(busy());
    answerWith(relay, { cancelAsyncMessage: () => ({ ok: true, result: true }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.pick(txt("a.png", "image/png"));
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

  it("7017 уже взято: пузырь на месте, тост словами", async () => {
    const relay = relayFor(busy());
    answerWith(relay, { cancelAsyncMessage: () => ({ ok: true, result: false }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("Потом");
    await t.click(t.$(".chat-send"));
    await t.click(t.btn(".chat-me", "отменить"));
    expect(t.$(".chat-me")).not.toBeNull();
    expect(t.$(".sb-toast")!.textContent).toBe("Claude уже взял это сообщение");
  });

  it("7018 без очереди и без session.call кнопки нет", async () => {
    const a = await chat(IDLE, { wide: true });
    await a.type("Сразу");
    await a.click(a.$(".chat-send"));
    expect(a.btn(".chat-me", "отменить")).toBeNull();
    const r3 = busy();
    for (const m of r3.machines) delete m.contract!["session.call"];
    const b = await chat(IDLE, { relay: relayFor(r3), wide: true });
    await b.type("Потом");
    await b.click(b.$(".chat-send"));
    expect(b.btn(".chat-me", "отменить")).toBeNull();
  });
});

// ───────────── действия ─────────────

const toolAt = (uuid: string, id: string, name = "Bash", input: unknown = { command: "x" }) => asst(uuid, [{ type: "tool_use", id, name, input }]);
const bgStart = (id: string, tu?: string, description = "сборка") => ({ type: "system", subtype: "task_started", uuid: `k-${id}`, task_id: id, tool_use_id: tu, description, is_backgrounded: true });

describe("действия над ходом", () => {
  it("4083 7208 «Прервать»: interrupt; отказ — тост; waiting тоже, сообщение в очередь; у простаивающей кнопки нет", async () => {
    const r = roster((x) => void (x.sessions[0].state = "busy"));
    const relay = relayFor(r);
    relay.handlers["session.call"] = () => ({ ok: false, error: "not_running" });
    const t = await chat(BUSY, { relay, wide: true });
    await t.click(t.btn(".chat-under", "Прервать"));
    expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: BUSY, method: "interrupt", args: [] })]);
    expect(t.$(".sb-toast")!.textContent).toBe(`${BUSY}: interrupt — not_running`);
    relay.setRoster(roster((x) => void (x.sessions[0].state = "idle")));
    await flush();
    expect(t.btn(".chat-under", "Прервать")).toBeNull();

    // предел ожидания человека — «Прервать» и session.stop (решение 4 нояб.)
    const w = relayFor(roster((x) => void (x.sessions[0].state = "waiting")));
    w.handlers["session.call"] = () => ({ ok: true, result: null });
    const u = await chat(BUSY, { relay: w, wide: true });
    await u.click(u.$(".chat-stop"));
    expect(w.sent("session.call")[0]).toMatchObject({ method: "interrupt" });
    await u.type("ещё");
    await u.key("Enter");
    expect(u.$(".chat-me small")!.textContent).toContain("в очереди");
    expect(u.btn(".chat-me", "отменить")).not.toBeNull();
  });

  it("6683 неживая сессия: ни «Стоп», ни «В фон»", async () => {
    const stopped = await chat(STOPPED, { relay: relayFor(roster(), [toolAt("a1", "t1"), { type: "system", subtype: "task_started", uuid: "k1", task_id: "k", tool_use_id: "t1", description: "сборка" }]), wide: true });
    expect(stopped.$(".chat-feed")!.textContent).toContain("Команда");
    expect(stopped.btn(".chat-feed", "Стоп")).toBeNull();
    expect(stopped.btn(".chat-feed", "В фон")).toBeNull();
  });

  it("6684 «В фон» у команды без задачи: backgroundTasks; итог снимает кнопку", async () => {
    const relay = relayFor(roster(), [toolAt("a1", "t1")]);
    relay.handlers["session.call"] = () => ({ ok: true, result: null });
    const t = await chat(IDLE, { relay, wide: true });
    expect(t.btn(".chat-feed", "Стоп")).toBeNull();
    await t.click(t.btn(".chat-feed", "В фон"));
    expect(relay.sent("session.call")[0]).toMatchObject({ method: "backgroundTasks", args: ["t1"] });
    await t.events(IDLE, [{ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }], 1);
    expect(t.btn(".chat-feed", "В фон")).toBeNull();
  });

  it("6685 6686 задача в фоне: полоса, «Стоп» — stopTask; без session.call — только список", async () => {
    const relay = relayFor(roster(), [toolAt("a1", "t1"), bgStart("k", "t1")]);
    relay.handlers["session.call"] = () => ({ ok: true, result: null });
    const t = await chat(IDLE, { relay, wide: true });
    expect(t.btn(".chat-feed", "В фон")).toBeNull();
    expect(t.btn(".chat-feed", "Стоп")).not.toBeNull();
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 1");
    await t.click(t.$(".chat-bg .dis-h"));
    await t.click(t.btn(".chat-bg", "Стоп"));
    expect(relay.sent("session.call")[0]).toMatchObject({ method: "stopTask", args: ["k"] });

    const r = roster((x) => {
      for (const m of x.machines) delete (m.contract as Record<string, number>)["session.call"];
    });
    const u = await chat(IDLE, { relay: relayFor(r, [toolAt("a1", "t1"), bgStart("k", "t1")]), wide: true });
    await u.click(u.$(".chat-bg .dis-h"));
    expect(u.btn(".chat-bg", "Стоп")).toBeNull();
    expect(u.$(".chat-bgr")!.textContent).toContain("сборка");
  });

  it("4105 «Стоп» задачи в ленте: stopTask; отказ — тост «callsign: метод — слово»", async () => {
    const relay = relayFor(roster(), [{ type: "system", subtype: "task_started", uuid: "s1", task_id: "task1", description: "фоновая сборка" }]);
    relay.handlers["session.call"] = () => ({ ok: false, error: "no_task" });
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.btn(".chat-feed", "Стоп"));
    expect(relay.sent("session.call")).toEqual([expect.objectContaining({ callsign: IDLE, method: "stopTask", args: ["task1"] })]);
    expect(t.$(".sb-toast")!.textContent).toBe(`${IDLE}: stopTask — no_task`);
  });

  it("6209 6687 фоновая по набору: идёт, ушла — кончилась; конец — одна строка", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [{ type: "system", subtype: "background_tasks_changed", uuid: "s0", tasks: [{ task_id: "n", task_type: "local_bash", description: "из набора" }] }], 1);
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 1");
    expect(t.$(".chat-bg")!.textContent).toContain("из набора");
    await t.events(IDLE, [toolAt("a1", "t1"), bgStart("k", "t1"), { type: "system", subtype: "task_updated", uuid: "u1", task_id: "k", patch: { is_backgrounded: true } }], 2);
    expect(t.$(".chat-bg")!.textContent).toContain("В фоне: 2");
    await t.events(IDLE, [{ type: "system", subtype: "task_updated", uuid: "u2", task_id: "k", patch: { status: "killed", end_time: 5 } }, { type: "system", subtype: "task_notification", uuid: "e1", task_id: "n", status: "completed" }, { type: "system", subtype: "task_notification", uuid: "e2", task_id: "n", status: "completed" }], 3);
    expect(t.$(".chat-bg")).toBeNull();
    expect(t.$('[data-tool="Bash"] .tc-st')!.textContent).toBe("остановлено");
    expect(t.$$(".chat-line.ok").map((x) => x.textContent)).toEqual(["Задача завершена · из набора"]);
    const gone = await chat(IDLE, { wide: true });
    await gone.events(IDLE, [bgStart("t1", "x")], 1);
    expect(gone.$(".chat-bg")).not.toBeNull();
    await gone.events(IDLE, [{ type: "system", subtype: "background_tasks_changed", uuid: "k4", tasks: [] }], 2);
    expect(gone.$(".chat-bg")).toBeNull();
  });

  it("7014 «Вывод»: getTaskOutput, хвост и подпись; «Скрыть» снимает опрос", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const relay = relayFor(roster(), [{ type: "system", subtype: "task_started", uuid: "k1", task_id: "t1", task_type: "local_bash", tool_use_id: "x", description: "npm run dev", is_backgrounded: true }]);
      answerWith(relay, { getTaskOutput: () => ({ ok: true, result: { output: "listening 3000", total_bytes: 20480, truncated: true } }) });
      const t = await chat(IDLE, { relay, wide: true });
      await t.click(t.$(".chat-bg .dis-h"));
      await t.click(t.btn(".chat-bg", "Вывод"));
      expect(calls(relay, "getTaskOutput")[0]).toMatchObject({ args: ["t1"] });
      expect(t.$(".chat-out pre")!.textContent).toBe("listening 3000");
      expect(t.$(".chat-out")!.textContent).toContain("последние 8 КБ из 20 КБ");
      const n1 = calls(relay, "getTaskOutput").length;
      vi.advanceTimersByTime(2100);
      await flush();
      expect(calls(relay, "getTaskOutput").length).toBe(n1 + 1);
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

  it("7015 «Вывод» отказал — словом; у субагента кнопки нет", async () => {
    const hist = (type: string) => [{ type: "system", subtype: "task_started", uuid: "k1", task_id: "t1", task_type: type, tool_use_id: "x", description: "npm run dev", is_backgrounded: true }];
    const relay = relayFor(roster(), hist("local_bash"));
    answerWith(relay, { getTaskOutput: () => ({ ok: false, error: "no_task" }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.$(".chat-bg .dis-h"));
    await t.click(t.btn(".chat-bg", "Вывод"));
    expect(t.$(".chat-out")!.textContent).toContain("no_task");
    const u = await chat(IDLE, { relay: relayFor(roster(), hist("local_agent")), wide: true });
    await u.click(u.$(".chat-bg .dis-h"));
    expect(u.btn(".chat-bg", "Вывод")).toBeNull();
  });

  it("6688 список задач Claude: шапка и док; всё готово — дока нет; субагента — только в карточке", async () => {
    const todos = [{ content: "а", status: "completed" }, { content: "б", activeForm: "делаю б", status: "in_progress" }, { content: "в", status: "pending" }];
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [toolAt("a1", "t1", "TodoWrite", { todos })], 1);
    expect(t.$('[data-tool="TodoWrite"] .tc-sum')!.textContent).toBe("1 из 3 готово");
    expect(t.$(".chat-todo .dis-h")!.textContent).toBe("1 из 3делаю б");
    await t.events(IDLE, [toolAt("a2", "t2", "TodoWrite", { todos: todos.map((x) => ({ ...x, status: "completed" })) })], 2);
    expect(t.$(".chat-todo")).toBeNull();
    await t.events(IDLE, [toolAt("a3", "t3", "Agent"), { ...toolAt("a4", "t4", "TodoWrite", { todos }), parent_tool_use_id: "t3" }], 3);
    expect(t.$(".tb-steps .chat-todos")).not.toBeNull();
    expect(t.$(".chat-todo")).toBeNull();
  });

  it("6689 отказ модели, ход кончился: одна плашка; «Изменить сообщение» — текст в поле", async () => {
    const t = await chat(IDLE, { relay: relayFor(roster(), [user("u1", "сломай"), { type: "assistant", uuid: "a1", isApiErrorMessage: true, error: "x", message: { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] } }, { type: "system", subtype: "model_refusal_no_fallback", uuid: "x1", refused_user_message_uuid: "u1", api_refusal_explanation: "причина" }]) });
    expect(t.$$(".chat-ban.bad")).toHaveLength(1);
    expect(t.$(".chat-ban.bad")!.textContent).toContain("Opus 5.5 отказалась отвечать");
    expect(t.$(".chat-ban.bad")!.textContent).toContain("Область: биология и химия. причина");
    await t.click(t.btn(".chat-ban", "Изменить сообщение"));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("сломай");
  });
});

describe("откат файлов", () => {
  const rw = (fn: (x: { args?: unknown[] }) => { ok: true; result: unknown } | { ok: false; error: string }) => {
    const relay = relayFor(roster(), [user("m1", "Почини сборку")]);
    relay.handlers["session.call"] = (x) => fn(x as { args?: unknown[] });
    return relay;
  };

  it("6691 ссылка только у живой на широком; отправка своих не множит", async () => {
    const history = [user("m1", "раз")];
    const stopped = await chat(STOPPED, { relay: relayFor(roster(), history), wide: true });
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

  it("6690 проба: «сообщению? 1 файл»; «Отмена» убирает строку, второго запроса нет (4109)", async () => {
    const t = await chat(IDLE, { relay: rw(() => ({ ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } })), wide: true });
    await t.click(t.btn(".chat-feed", "откатить файлы"));
    expect(t.$(".chat-rwc")!.textContent).toContain("сообщению? 1 файл");
    await t.click(t.btn(".chat-rwc", "Отмена"));
    expect(t.$(".chat-rwc")).toBeNull();
    expect(t.relay.sent("session.call")).toHaveLength(1);
  });

  it.each([
    ["4107 canRewind false", () => ({ ok: true as const, result: { canRewind: false, error: "no checkpoint" } }), "Откатить нельзя: no checkpoint"],
    ["6690 проба отказала", () => ({ ok: false as const, error: "offline" }), "Откатить нельзя: pc не на связи"],
  ])("%s — слово, кнопки «Откатить» нет", async (_n, fn, word) => {
    const t = await chat(IDLE, { relay: rw(fn), wide: true });
    await t.click(t.btn(".chat-feed", "откатить файлы"));
    expect(t.$(".chat-rwc")!.textContent).toBe(word);
    expect(t.btn(".chat-rwc", "Откатить")).toBeNull();
    expect(t.relay.sent("session.call")).toHaveLength(1);
  });

  it("4108 откат отказал — «Не откатилось: слово»", async () => {
    const t = await chat(IDLE, { relay: rw((x) => ((x.args as unknown[]).length === 2 ? { ok: true, result: { canRewind: true, filesChanged: ["a"], insertions: 1, deletions: 0 } } : { ok: false, error: "offline" })), wide: true });
    await t.click(t.btn(".chat-feed", "откатить файлы"));
    await t.click(t.btn(".chat-rwc", "Откатить"));
    expect(t.$(".chat-rwc")!.textContent).toBe("Не откатилось: pc не на связи");
  });
});

describe("панель контекста", () => {
  const usage = { totalTokens: 84_200, maxTokens: 200_000, percentage: 42, categories: [{ name: "Messages", tokens: 51_200 }, { name: "Skills", tokens: 0 }] };
  const full = {
    getContextUsage: () => ({ ok: true, result: usage }),
    supportedAgents: () => ({ ok: true, result: [{ name: "Explore", description: "поиск" }] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => ({ ok: true, result: { session: { total_cost_usd: 1.84, total_api_duration_ms: 312000, total_lines_added: 148, total_lines_removed: 37 }, rate_limits: { five_hour: { utilization: 34, resets_at: "2026-11-04T15:00:00Z" }, seven_day: null } } }),
    getStatus: () => ({ ok: true, result: { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.310" }, { label: "Peer address", value: "скрыт" }] }] } }),
    getHooksListing: () => ({ ok: true, result: { hooks: [{ event: "PostToolUse", matcher: "Edit", source: "projectSettings", displayText: "cargo fmt" }] } }),
    listPermissionRules: () => ({ ok: true, result: { state: { rules: [{ behavior: "allow", source: "localSettings", rule: "Bash(npm test:*)" }, { behavior: "deny", source: "projectSettings", rule: "Read(.env)" }, { behavior: "ask", source: "userSettings", rule: "WebFetch" }] } } }),
  };
  const panel = async (table: Record<string, () => unknown>) => {
    const relay = relayFor();
    answerWith(relay, table);
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.btn(".chat-bar", "контекст"));
    await flush(10);
    return { t, relay };
  };

  it("6692 7019 7161 разделы: контекст без пустых, субагенты, расход, Claude, хуки, правила; «Сжать» шлёт /compact", async () => {
    const { t, relay } = await panel(full);
    const p = t.$(".chat-panel")!.textContent!;
    expect(p).toContain("84 К из 200 К");
    expect(p).toContain("Разговор");
    expect(p).not.toContain("Скилы");
    expect(p).toContain("Explore");
    expect(calls(relay, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET")[0]).toMatchObject({ args: [{ skipBehaviors: true }] });
    expect(p).toContain("$1,84");
    expect(p).toContain("+148");
    expect(p).toContain("−37");
    expect(t.$$(".chat-panel [data-window]").map((x) => x.getAttribute("data-window"))).toEqual(["five_hour"]);
    expect(t.$('.chat-panel [data-window="five_hour"]')!.textContent).toContain("34 %");
    expect(p).toContain("2.1.310");
    expect(p).not.toContain("скрыт");
    expect(p).toContain("PostToolUse");
    expect(p).toContain("cargo fmt");
    const sec = t.$('[data-sec="rules"]')!;
    expect(sec.querySelector("h4")!.textContent).toBe("Разрешения");
    expect([...sec.querySelectorAll(".chat-pn-r")].map((r) => r.textContent)).toEqual(["можноBash(npm test:*)локально", "нельзяRead(.env)проект", "спроситьWebFetchпользователь"]);
    await t.click(t.btn(".chat-panel", "Сжать контекст"));
    expect(relay.sent("session.prompt")[0]).toMatchObject({ text: "/compact" });
    expect(t.$(".chat-panel")).toBeNull();
  });

  it("6692 кадр ленты панель не спрашивает; новое открытие спрашивает снова", async () => {
    const { t, relay } = await panel(full);
    await t.click(t.btn(".chat-bar", "контекст"));
    const before = relay.sent("session.call").length;
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "ход" }])], 1);
    expect(relay.sent("session.call").length).toBe(before);
    await t.click(t.btn(".chat-bar", "контекст"));
    await flush(10);
    expect(relay.sent("session.call").length).toBe(before + 6);
  });

  it("6693 неживая — кнопки нет; отказ — слово в панели, панель открыта, тоста нет (7216)", async () => {
    const stopped = await chat(STOPPED, { wide: true });
    expect(stopped.btn(".chat-bar", "контекст")).toBeNull();
    const { t, relay } = await panel({ getContextUsage: () => ({ ok: false, error: "stopped" }), supportedAgents: () => ({ ok: false, error: "stopped" }) });
    expect(t.$(".chat-panel > .bad")!.textContent).toBe("сессия остановлена");
    expect(t.$(".chat-panel")).not.toBeNull();
    expect(t.$(".sb-toast")!.hidden).toBe(true);
    expect(calls(relay, "getContextUsage")).toHaveLength(1);
  });

  it.each([[75, "warn"], [95, "bad"]])("6694 контекст заполнен на %d: полоса %s", async (percentage, cls) => {
    const { t } = await panel({ ...full, getContextUsage: () => ({ ok: true, result: { percentage } }) });
    expect(t.$(`.chat-panel .sb-barw.${cls}`)).not.toBeNull();
  });

  it("7020 7162 метода нет — раздела нет; правил нет — раздела нет; другой отказ — слово в разделе", async () => {
    const { t } = await panel({ ...full, getStatus: () => ({ ok: false, error: "unknown_method" }), getHooksListing: () => ({ ok: false, error: "sdk_error" }), listPermissionRules: () => ({ ok: true, result: { state: { rules: [] } } }) });
    expect(t.$('[data-sec="claude"]')).toBeNull();
    expect(t.$('[data-sec="hooks"]')!.textContent).toContain("Claude отказал");
    expect(t.$('[data-sec="rules"]')).toBeNull();
    expect(t.$(".sb-toast")?.textContent ?? "").toBe("");
    const u = await panel({ ...full, listPermissionRules: () => ({ ok: false, error: "sdk_error" }) });
    expect(u.t.$('[data-sec="rules"] .bad')!.textContent).toBe("Claude отказал, причина в журнале машины");
  });

  it("7021 «Перечитать плагины»: reloadPlugins; следующий «/» спрашивает команды заново", async () => {
    const relay = relayFor();
    answerWith(relay, { ...full, reloadPlugins: () => ({ ok: true, result: {} }), supportedCommands: () => ({ ok: true, result: [{ name: "compact" }] }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("/");
    expect(calls(relay, "supportedCommands")).toHaveLength(1);
    await t.type("");
    await t.click(t.btn(".chat-bar", "контекст"));
    await flush();
    await t.click(t.btn(".chat-panel", "Перечитать плагины"));
    expect(calls(relay, "reloadPlugins")).toHaveLength(1);
    await t.type("/");
    expect(calls(relay, "supportedCommands")).toHaveLength(2);
  });
});

describe("режим разрешений", () => {
  const rosterOf = (o: { mode?: string; state?: string }) =>
    roster((r) => {
      const s = r.sessions.find((x) => x.callsign === BUSY) as unknown as Record<string, unknown>;
      if (o.mode) s.mode = o.mode;
      if (o.state) s.state = o.state;
    });
  const bench = (mode: string, answers: Record<string, unknown> = {}) => {
    const relay = relayFor(rosterOf({ mode }));
    const asked: Array<Record<string, unknown>> = [];
    relay.handlers["session.call"] = (x) => {
      asked.push(x);
      const a = answers[String(x.method)];
      return a === "refuse" ? { ok: false, error: "sdk_error" } : { ok: true, result: a ?? null };
    };
    return { relay, asked };
  };
  const select = (t: Ui) => t.$<HTMLSelectElement>('select[aria-label="Режим разрешений"]');
  const labels = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
  const pick = async (el: HTMLSelectElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  };

  it("7151 7155 режим из поля roster: четыре режима, нынешний выбран; на узком тоже", async () => {
    const t = await chat(BUSY, { relay: bench("default").relay, wide: true });
    const el = select(t)!;
    expect(el.value).toBe("default");
    expect(labels(el)).toEqual(["Без вопросов", "Спрашивать", "Правки сами", "План"]);
    expect([...el.options].map((o) => o.value)).toEqual(["bypassPermissions", "default", "acceptEdits", "plan"]);
    const u = await chat(BUSY, { relay: bench("acceptEdits").relay });
    expect(u.$(".chat-bar")).toBeNull();
    expect(select(u)!.value).toBe("acceptEdits");
  });

  it("7152 «Авто» — только если модель сессии умеет", async () => {
    const a = bench("default", { supportedModels: [{ value: "haiku" }, { value: "opus", supportsAutoMode: true }] });
    const t = await chat(BUSY, { relay: a.relay, wide: true });
    await t.events(BUSY, [{ type: "system", subtype: "init", model: "claude-opus-5-5", permissionMode: "default", uuid: "i1" }]);
    expect(labels(select(t)!)).toContain("Авто");
    const b = bench("default", { supportedModels: [{ value: "opus", supportsAutoMode: true }] });
    const u = await chat(BUSY, { relay: b.relay, wide: true });
    await u.events(BUSY, [{ type: "system", subtype: "init", model: "claude-haiku-5-5", permissionMode: "default", uuid: "i1" }]);
    expect(labels(select(u)!)).not.toContain("Авто");
  });

  it("7153 смена — setPermissionMode; значение меняет поле roster, а не клик и не кадр ленты", async () => {
    const { relay, asked } = bench("bypassPermissions");
    const t = await chat(BUSY, { relay, wide: true });
    await pick(select(t)!, "plan");
    expect(asked.filter((c) => c.method === "setPermissionMode")).toEqual([expect.objectContaining({ callsign: BUSY, args: ["plan"] })]);
    expect(select(t)!.value).toBe("bypassPermissions");
    await t.events(BUSY, [{ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "s1" }]);
    expect(select(t)!.value).toBe("bypassPermissions");
    relay.setRoster(rosterOf({ mode: "plan" }));
    await flush();
    expect(select(t)!.value).toBe("plan");
  });

  it("7154 отказ — тост словом, режим прежний", async () => {
    const t = await chat(BUSY, { relay: bench("bypassPermissions", { setPermissionMode: "refuse" }).relay, wide: true });
    await pick(select(t)!, "plan");
    expect(t.$(".sb-toast")!.textContent).toContain("Claude отказал");
    expect(select(t)!.value).toBe("bypassPermissions");
  });

  it("7156 Host не знает режима — выбора нет; session.spec чат не спрашивает", async () => {
    const relay = relayFor(roster((r) => r.machines.forEach((m) => void (m.contract = { ...m.contract, "session.spec": 1 }))));
    const asked: string[] = [];
    relay.handlers["session.spec"] = () => (asked.push("x"), { ok: true, result: { mode: "plan" } });
    const t = await chat(BUSY, { relay, wide: true });
    expect(t.$(".chat-inp")).not.toBeNull();
    expect(select(t)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("7291 7292 supportedModels: один запрос на разговор; отказ не запоминается", async () => {
    const asked = (a: Array<Record<string, unknown>>) => a.filter((x) => x.method === "supportedModels").length;
    const away = () => open("/#inbox");
    const back = () => open(`/#chat?callsign=${encodeURIComponent(BUSY)}`);
    const good = bench("default", { supportedModels: [{ value: "opus", supportsAutoMode: true }] });
    await chat(BUSY, { relay: good.relay, wide: true });
    expect(asked(good.asked)).toBe(1);
    await away();
    await back();
    expect(asked(good.asked)).toBe(1);
    const bad = bench("default", { supportedModels: "refuse" });
    await chat(BUSY, { relay: bad.relay, wide: true });
    expect(asked(bad.asked)).toBe(1);
    await away();
    await back();
    expect(asked(bad.asked)).toBe(2);
  });
});

// ───────────── вопросы ─────────────

const Q1 = { question: "Какую базу мигрировать первой?", header: "База", multiSelect: false, options: [{ label: "прод", description: "Боевая база, 2,1 млн строк. Окно — ночью, с 02:00." }, { label: "стенд", description: "Копия недельной давности. Можно сразу." }] };
const QS = { question: "База?", header: "База", multiSelect: false, options: [{ label: "прод" }, { label: "стенд" }] };
const pending = (id = "q1", q: unknown = QS) => ({ question: id, kind: "ask", questions: [q] });
const frame = (from: string, id = "q1", q: unknown = QS) => ({ type: "question", from, to: ["phone", "panel-desk"], ...pending(id, q) });
const bare = (f: Msg) => ({ ...f, type: undefined, from: undefined, to: undefined });
const relayList = (list: Record<string, unknown[]> = {}, r = homeRoster()) => {
  const relay = new FakeRelay(r);
  relay.handlers["question.list"] = (x) => ({ ok: true, result: list[String(x.callsign)] ?? [] });
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  return relay;
};
const rowOf = (t: Awaited<ReturnType<typeof stand>>, cs: string) => t.$(`[data-callsign="${cs}"]`)!;

/** Вопрос пришёл кадром и в question.list; экран открыт нажатием строки списка. */
async function asked(over: Msg = {}) {
  const t = await stand(parts());
  const q = { ...frame(ASKING, "toolu_01Hx", Q1), ...over };
  t.relay.handlers["question.list"] = () => ({ ok: true, result: [bare(q)] });
  t.relay.push(q);
  await flush();
  await t.click(t.$(`[data-callsign="${ASKING}"]`));
  return t;
}

describe("вопрос сессии: AskUserQuestion", () => {
  it("метка: в строке списка «?» и текст вопроса (чьё: код)", async () => {
    const t = await stand(parts());
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push(frame(ASKING, "toolu_01Hx", Q1));
    await flush();
    expect(rowOf(t, ASKING).textContent).toContain("Какую базу мигрировать первой?");
    expect(rowOf(t, ASKING).querySelector(".sb-badge")!.textContent).toBe("?");
  });

  it("экран: чип, варианты с описаниями, «Свой ответ»; ответ — answer текст вопроса → вариант (чьё: код)", async () => {
    const t = await asked();
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.$(".ask-chip")!.textContent).toBe("База");
    expect(t.$$(".ask-opt").map((b) => b.querySelector("b")!.textContent)).toEqual(["прод", "стенд", "Свой ответ"]);
    expect(t.text()).toContain("Копия недельной давности");
    expect(t.button("Ответить")!.disabled).toBe(true);
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    expect(t.relay.sent("answer")).toEqual([expect.objectContaining({ type: "answer", v: 1, callsign: ASKING, question: "toolu_01Hx", answers: { "Какую базу мигрировать первой?": "стенд" } })]);
    expect(t.text()).toContain("Ответ «стенд» принят.");
    expect(t.text()).toContain("Вопрос видят: вы и panel-desk");
  });

  it("несколько вопросов, галочки и свой ответ: через запятую; пока не на все — кнопка недоступна (чьё: код)", async () => {
    const Q2 = { question: "Что прогнать?", header: "Проверки", multiSelect: true, options: [{ label: "юнит" }, { label: "e2e" }] };
    const t = await asked({ questions: [Q1, Q2] });
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.$$(".ask-qn").map((x) => x.textContent)).toEqual(["вопрос 1 из 2", "вопрос 2 из 2"]);
    await t.click(t.$$(".ask-opt")[0]);
    expect(t.button("Ответить")!.disabled).toBe(true);
    await t.click(t.$$(".ask-opt")[3]);
    await t.click(t.$$(".ask-opt")[4]);
    await t.click(t.$$(".ask-opt")[5]);
    set(t.$<HTMLInputElement>("input.ask-own")!, "линт");
    await flush();
    await t.click(t.button("Ответить"));
    expect(t.relay.sent("answer")[0].answers).toEqual({ "Какую базу мигрировать первой?": "прод", "Что прогнать?": "юнит, e2e, линт" });
  });

  it("4052 свой ответ подтверждён кадром: «принят», шапка, метка снята", async () => {
    const relay = relayList({ [ASKING]: [pending()] });
    relay.handlers.answer = () => undefined;
    const t = await stand(parts(), { relay });
    await t.click(rowOf(t, ASKING));
    await t.click(t.$$(".ask-opt")[1]);
    await t.click(t.button("Ответить"));
    relay.push({ type: "answered", from: ASKING, question: "q1", by: "phone", answers: { "База?": "стенд" } });
    await flush();
    expect(t.text()).toContain("Ответ «стенд» принят.");
    expect(t.$(".sb-pill")!.textContent).toBe("ответ принят");
    t.button("‹")!.click();
    await flush();
    expect(rowOf(t, ASKING).querySelector(".sb-badge")).toBeNull();
  });

  it("4053 первый ответ выигрывает (12): ответили с другого места — варианты недоступны, answer нет", async () => {
    const relay = relayList({ [ASKING]: [pending()] });
    const t = await stand(parts(), { relay });
    await t.click(rowOf(t, ASKING));
    relay.push({ type: "answered", from: ASKING, question: "q1", by: "panel-desk", answers: { "База?": "стенд" } });
    await flush();
    expect(t.text()).toContain("Уже ответили с panel-desk: «стенд».");
    expect(t.$$<HTMLButtonElement>(".ask-opt").every((b) => b.disabled)).toBe(true);
    expect(t.button("Ответить")).toBeNull();
    expect(relay.sent("answer")).toHaveLength(0);
  });

  it("отказ сети: карточка со словом, можно отправить ещё раз (чьё: код)", async () => {
    const t = await asked();
    t.relay.handlers.answer = () => ({ ok: false, error: "offline" });
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.button("Ответить"));
    expect(t.text()).toContain("Не отправлено: offline");
    expect(t.button("Ответить")!.disabled).toBe(false);
  });

  it("4060 вопроса больше нет — unknown_question словом", async () => {
    const relay = relayList({ [ASKING]: [pending()] });
    relay.handlers.answer = () => ({ ok: false, error: "unknown_question" });
    const t = await stand(parts(), { relay });
    await t.click(rowOf(t, ASKING));
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.button("Ответить"));
    expect(t.text()).toContain("Вопроса больше нет.");
    expect(t.text()).toContain(`${ASKING} его не ждёт: unknown_question.`);
  });

  it("вопрос снят: answered с cancelled — «Вопрос снят», метка снята (чьё: код)", async () => {
    const t = await asked();
    t.relay.push({ type: "answered", from: ASKING, question: "toolu_01Hx", cancelled: true });
    await flush();
    expect(t.text()).toContain("Вопрос снят.");
    t.button("‹")!.click();
    await flush();
    expect(t.$(`[data-callsign="${ASKING}"] .sb-badge`)).toBeNull();
  });

  it("6102 4063 следующий вопрос той же сессии — с чистым выбором; следующая форма — с пустыми полями", async () => {
    const t = await asked();
    t.relay.handlers.answer = () => ({ ok: true });
    await t.click(t.$$(".ask-opt")[0]);
    await t.click(t.button("Ответить"));
    t.relay.push(frame(ASKING, "toolu_02", Q1));
    await flush();
    expect(t.$$(".ask-opt").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    const schema = { type: "object", properties: { project: { type: "string" } } };
    const f = await asked({ kind: "form", questions: undefined, message: "Первая", schema });
    f.relay.handlers.answer = () => ({ ok: true });
    set(f.$<HTMLInputElement>(".ask-field input")!, "WEB");
    await f.click(f.button("Отправить"));
    f.relay.push({ ...frame(ASKING, "toolu_02"), kind: "form", questions: undefined, message: "Вторая", schema });
    await flush();
    expect(f.text()).toContain("Вторая");
    expect(f.$<HTMLInputElement>(".ask-field input")!.value).toBe("");
    await f.click(f.button("Отправить"));
    expect(f.relay.sent("answer")[1].content).toEqual({});
  });

  it("7213 вопросы идут один за другим: на экране новый, а не итог прежнего; над вводом (4063)", async () => {
    const relay = relayFor(roster());
    const pf = (id: string) => ({ question: id, kind: "perm", tool: "Bash", input: { command: id } });
    let now = "";
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === BUSY && now ? [pf(now)] : [] });
    const t = await chat(BUSY, { relay, wide: true });
    for (const id of ["a", "b", "c"]) {
      now = id;
      relay.push({ type: "question", from: BUSY, to: ["phone"], ...pf(id) });
      await flush();
      expect(t.$(".chat-ask code")!.textContent).toBe(id);
      now = "";
      relay.push({ type: "answered", from: BUSY, question: id, by: "phone", action: "allow" });
      await flush();
    }
  });

  it("6900 карточка «Вам» и док чата: ответ в доке — карточка уходит, в доке «Ответ принят»", async () => {
    const relay = relayList({ [IDLE]: [pending()] });
    relay.handlers.answer = () => ({ ok: true });
    const t = await stand(pultParts(fakeBrowser("granted")), { relay, wide: true, options: PULT, url: "/#inbox" });
    relay.push(frame(IDLE));
    await flush();
    await t.go(`#chat?callsign=${encodeURIComponent(IDLE)}`);
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

  it("4100 7160 телефон: полоса над вводом открывает экран; широко — запрос над вводом", async () => {
    const perm = { type: "question", from: BUSY, to: ["phone"], question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test" }, title: "Claude хочет выполнить npm test" };
    const list = (x: { callsign?: unknown }) => ({ ok: true as const, result: x.callsign === BUSY ? [bare(perm)] : [] });
    const wide = relayFor();
    wide.handlers["question.list"] = list;
    const t = await chat(BUSY, { relay: wide, wide: true });
    wide.push(perm);
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("Claude просит разрешения");
    const narrow = relayFor();
    narrow.handlers["question.list"] = list;
    const u = await chat(BUSY, { relay: narrow });
    narrow.push(perm);
    await flush();
    expect(u.$(".chat-askbar")!.textContent).toContain("Claude хочет выполнить npm test");
    await u.click(u.$(".chat-askbar"));
    expect(location.hash).toBe(`#ask?callsign=${encodeURIComponent(BUSY)}`);
    expect(u.$(".ask")!.textContent).toContain("Claude просит разрешения");
    const relay = relayFor(roster());
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === ASKING ? [pending("q1", { question: "База?", options: [{ label: "a" }, { label: "b" }] })] : [] });
    const v = await chat(ASKING, { relay });
    expect(v.$(".chat-askbar")!.textContent).toBe("?База?Ответить");
  });
});

describe("вопрос сессии: связь и ждущие у Host", () => {
  it("4050 4055 вопрос из уведомления и ждущая при старте: question.list один раз, вопрос в строке", async () => {
    const relay = relayList({ [IDLE]: [pending()] });
    const store = memoryStore({ key: KEY, pushes: [{ id: "p1", type: "question", from: IDLE, notify: { title: `${IDLE} спрашивает`, body: "База?" }, at: 1 }] });
    const t = await stand(parts(), { relay, store });
    expect(relay.got.filter((x) => x.type === "question.list" && x.callsign === IDLE)).toHaveLength(1);
    expect(relay.hellos).toHaveLength(2);
    await t.expand();
    expect(rowOf(t, IDLE).textContent).toContain("База?");
    expect(rowOf(t, IDLE).querySelector(".sb-badge")!.textContent).toBe("?");

    for (const wide of [false, true]) {
      const r = relayList({ [ASKING]: [pending()] });
      const u = await stand(parts(), { relay: r, wide });
      r.setRoster(homeRoster());
      await flush(5);
      expect(r.sent("question.list").filter((x) => x.callsign === ASKING)).toHaveLength(1);
      expect(r.sent("question.list").find((x) => x.callsign === ASKING)).toMatchObject({ v: 1 });
      await u.expand();
      expect(rowOf(u, ASKING).textContent).toContain("База?");
    }
  });

  it("4051 нажатый пуш вопроса: открыт экран вопроса отправителя", async () => {
    const relay = relayList({ [IDLE]: [pending()] });
    const store = memoryStore({ key: KEY, pushes: [{ id: "p1", type: "question", from: IDLE, notify: { body: "База?" }, at: 1, clicked: true }] });
    const t = await stand(parts(), { relay, store });
    await flush();
    expect(location.hash).toBe(`#ask?callsign=${encodeURIComponent(IDLE)}`);
    expect(t.$(".ask-qt")!.textContent).toBe("База?");
  });

  it("4056 4058 ответили, пока связи не было: Host вопроса не знает — вопрос исчез", async () => {
    const relay = relayList({ [ASKING]: [pending()] });
    const t = await stand(parts(), { relay });
    expect(rowOf(t, ASKING).textContent).toContain("База?");
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    relay.drop();
    await reconnect();
    expect(relay.hellos).toHaveLength(4);
    expect(relay.sent("question.list").filter((x) => x.callsign === ASKING).length).toBeGreaterThanOrEqual(2);
    expect(rowOf(t, ASKING).textContent).not.toContain("База?");
  });

  it("4057 question.list отказал: вопрос не показан, на следующем roster снова спрашивает", async () => {
    const relay = relayList();
    relay.handlers["question.list"] = () => ({ ok: false, error: "offline" });
    const t = await stand(parts(), { relay });
    expect(relay.sent("question.list")).toHaveLength(1);
    expect(t.run.failed).toEqual({});
    relay.handlers["question.list"] = () => ({ ok: true, result: [pending()] });
    relay.setRoster(homeRoster());
    await flush();
    expect(relay.sent("question.list")).toHaveLength(2);
    expect(rowOf(t, ASKING).textContent).toContain("База?");
  });

  it("4059 вопрос задан во время разрыва: после hello берётся у Host", async () => {
    const r = homeRoster();
    r.sessions = r.sessions.map((s) => ({ ...s, state: s.state === "waiting" ? "idle" : s.state }));
    const relay = relayList({}, r);
    const t = await stand(parts(), { relay });
    expect(relay.sent("question.list")).toHaveLength(0);
    relay.drop();
    const r2 = homeRoster();
    r2.sessions = r2.sessions.map((s) => (s.callsign === BUSY ? { ...s, state: "waiting" } : { ...s, state: s.state === "waiting" ? "idle" : s.state }));
    relay.roster = r2;
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === BUSY ? [pending("q2")] : [] });
    await reconnect();
    expect(relay.sent("question.list")).toEqual([expect.objectContaining({ callsign: BUSY })]);
    await t.expand();
    expect(rowOf(t, BUSY).querySelector(".sb-badge")!.textContent).toBe("?");
  });

  it("6986 сверка после обрыва: A убран, B на месте без дубля, C добавлен", async () => {
    const q = (id: string) => ({ question: id, kind: "ask", questions: [{ question: `Вопрос ${id}?`, options: [{ label: "да" }] }] });
    const relay = relayList();
    relay.handlers.answer = () => ({ ok: true });
    let known = [q("A"), q("B")];
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === ASKING ? known : [] });
    const t = await stand(parts(), { relay, url: `/#ask?callsign=${encodeURIComponent(ASKING)}` });
    relay.push({ type: "question", from: ASKING, to: ["phone"], ...q("A") });
    relay.push({ type: "question", from: ASKING, to: ["phone"], ...q("B") });
    await flush(5);
    expect(t.text()).toContain("Вопрос A?");
    known = [q("B"), q("C")];
    relay.drop();
    await reconnect();
    expect(t.text()).not.toContain("Вопрос A?");
    expect(t.text()).toContain("Вопрос B?");
    await t.click(t.$(".ask-opt"));
    await t.click(t.button("Ответить"));
    await flush(5);
    relay.push({ type: "answered", from: ASKING, question: "B", by: "phone", answers: {} });
    await flush(5);
    expect(t.text()).toContain("Вопрос C?");
    expect(relay.sent("answer").map((x) => x.question)).toEqual(["B"]);
  });

  it("7293 7294 повторное открытие при живой связи без question.list; закрытый или вернувшаяся связь — спрашивает снова", async () => {
    const t = await asked();
    const listed = () => t.relay.sent("question.list").length;
    const visit = async () => {
      await open("/#inbox");
      await open(`/#ask?callsign=${encodeURIComponent(ASKING)}`);
    };
    const n1 = listed();
    await visit();
    await visit();
    expect(listed()).toBe(n1);
    t.relay.push({ type: "answered", from: ASKING, question: "toolu_01Hx", by: "other", answers: {} });
    await flush();
    await visit();
    expect(listed()).toBe(n1 + 1);
    t.relay.drop();
    await reconnect();
    expect(listed()).toBeGreaterThan(n1 + 1);
  });

  it("7209 ждала и перестала, ответа не видели: снято по question.list; следующее ожидание спрашивает снова; один запрос на ожидание", async () => {
    const rosterOf = (state: string, mode?: string) => roster((r) => {
      const s = r.sessions.find((x) => x.callsign === BUSY) as unknown as Record<string, unknown>;
      s.state = state;
      if (mode) s.mode = mode;
    });
    const q = { question: "toolu_w1", kind: "perm", tool: "Bash", input: { command: "ls" } };
    const relay = relayFor(rosterOf("waiting"));
    let list: unknown[] = [q];
    let n2 = 0;
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === BUSY ? (n2++, list) : [] });
    const t = await chat(BUSY, { relay, wide: true });
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("Claude просит разрешения");
    const opened = n2;
    relay.setRoster(rosterOf("waiting", "default"));
    await flush();
    expect(n2).toBe(opened);
    list = [];
    relay.setRoster(rosterOf("idle"));
    await flush(5);
    expect(t.$(".chat-ask .ask-acts")).toBeNull();
    expect(n2).toBe(opened + 1);
    list = [{ ...q, question: "toolu_w2" }];
    relay.setRoster(rosterOf("waiting"));
    await flush(5);
    expect(n2).toBe(opened + 2);
    expect(t.$(".chat-ask .ask-acts")).not.toBeNull();
  });

  it("4061 4062 экран без вопросов: «Загружаю…», потом «нет ждущих»; отказ виден словом", async () => {
    const relay = relayList();
    relay.handlers["question.list"] = () => undefined;
    const t = await stand(parts(), { relay });
    await open(`/#ask?callsign=${encodeURIComponent(IDLE)}`);
    expect(t.text()).toContain("Загружаю вопросы…");
    relay.reply(relay.sent("question.list").find((x) => x.callsign === IDLE)!.id!, { ok: true, result: [] });
    await flush();
    expect(t.text()).toContain(`У ${IDLE} нет ждущих вопросов.`);
    expect(t.button("Ответить")).toBeNull();
    const bad = relayList();
    bad.handlers["question.list"] = () => ({ ok: false, error: "offline" });
    const u = await stand(parts(), { relay: bad });
    await open(`/#ask?callsign=${encodeURIComponent(BUSY)}`);
    expect(u.root.textContent).toContain("offline");
    expect(u.text()).not.toContain("нет ждущих вопросов");
    expect(u.run.failed).toEqual({});
  });
});

describe("форма MCP", () => {
  const schema = { type: "object", properties: { project: { type: "string" } } };

  it("поля схемы → answer с content; «Отклонить» → decline без content (73)", async () => {
    const t = await asked({ kind: "form", questions: undefined, message: "Данные для новой задачи", schema });
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.text()).toContain("Данные для новой задачи");
    set(t.$<HTMLInputElement>(".ask-field input")!, "WEB");
    await flush();
    await t.click(t.button("Отправить"));
    expect(t.relay.sent("answer")[0]).toMatchObject({ question: "toolu_01Hx", action: "accept", content: { project: "WEB" } });
    const u = await asked({ kind: "form", questions: undefined, message: "Данные", schema });
    u.relay.handlers.answer = () => ({ ok: true });
    await u.click(u.button("Отклонить"));
    expect(u.relay.sent("answer")[0]).toMatchObject({ action: "decline" });
    expect(u.relay.sent("answer")[0]).not.toHaveProperty("content");
  });

  it("форма со ссылкой: «Перешёл» — accept без content (чьё: код)", async () => {
    const t = await asked({ kind: "form", questions: undefined, message: "Войдите в GitHub", url: "https://github.com/login/device" });
    t.relay.handlers.answer = () => ({ ok: true });
    expect(t.$<HTMLAnchorElement>(".ask-url")!.href).toBe("https://github.com/login/device");
    await t.click(t.button("Перешёл"));
    expect(t.relay.sent("answer")[0]).toMatchObject({ action: "accept" });
    expect(t.relay.sent("answer")[0]).not.toHaveProperty("content");
  });

  it("6985 число уходит числом, выбор — значением", async () => {
    const relay = relayList();
    relay.handlers.answer = () => ({ ok: true });
    const q = { question: "f1", kind: "form", message: "Данные", schema: { type: "object", properties: { points: { type: "integer" }, tag: { type: "string", enum: ["a", "b"] } } } };
    relay.handlers["question.list"] = () => ({ ok: true, result: [q] });
    const t = await stand(parts(), { relay, url: `/#ask?callsign=${encodeURIComponent(ASKING)}` });
    relay.push({ type: "question", from: ASKING, to: ["phone"], ...q });
    await flush(5);
    set(t.$<HTMLInputElement>('.ask-field input[type="number"]')!, "5");
    const sel = t.$<HTMLSelectElement>(".ask-field select");
    if (sel) {
      sel.value = "b";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } else await t.click(t.button("b"));
    await flush();
    await t.click(t.button("Отправить"));
    expect(relay.sent("answer")[0]).toMatchObject({ action: "accept", content: { points: 5, tag: "b" } });
  });
});

const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
const perm = (over: Msg = {}) => ({ type: "question", from: ASKING, to: ["phone", "panel-desk"], question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test", description: "Прогон" }, title: "Claude хочет выполнить npm test", suggestions: SUGGEST, ...over });
const plan = (over: Msg = {}) => perm({ question: "toolu_e1", tool: "ExitPlanMode", input: { plan: "## Шаги\n\n1. **Найти** формулу" }, title: undefined, suggestions: undefined, ...over });

async function permUi(q: Msg) {
  const t = await stand(parts());
  t.relay.handlers["question.list"] = () => ({ ok: true, result: [bare(q)] });
  const sent: Msg[] = [];
  t.relay.handlers.answer = (x) => (sent.push(x), { ok: true });
  t.relay.push(q);
  await flush();
  await t.click(t.$(`[data-callsign="${ASKING}"]`));
  const button = (label: string) => t.$$<HTMLButtonElement>(".ask button").find((b) => b.textContent === label);
  const press = async (label: string) => {
    await t.click(button(label)!);
    await flush();
  };
  const reason = async (value: string) => {
    set(t.$<HTMLTextAreaElement>(".ask textarea")!, value);
    await flush();
  };
  return { ...t, sent, button, press, reason };
}

describe("запрос разрешения", () => {
  it("7130 метка строки: «?» и заголовок; без заголовка — инструмент и суть", async () => {
    const t = await stand(parts());
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push(perm());
    await flush();
    expect(rowOf(t, ASKING).textContent).toContain("Claude хочет выполнить npm test");
    expect(rowOf(t, ASKING).querySelector(".sb-badge")!.textContent).toBe("?");
    const u = await stand(parts());
    u.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    u.relay.push(perm({ title: undefined }));
    await flush();
    expect(rowOf(u, ASKING).textContent).toContain("Bash: npm test");
  });

  it("7138 в «Вам»: экран запроса прямо в карточке", async () => {
    const t = await stand([...parts(), { manifest: inboxM, module: createInbox }]);
    t.relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === ASKING ? [bare(perm())] : [] });
    t.relay.push(perm());
    await flush();
    await t.go("#inbox");
    expect(t.$(`[data-kind="q"][data-callsign="${ASKING}"]`)!.textContent).toContain("Claude просит разрешения");
  });

  it("7131 7132 7214 заголовок, инструмент, суть, причина и путь; «Разрешать всегда» — только если предложил SDK", async () => {
    const t = await permUi(perm({ reason: "нет правила", blockedPath: "C:/x" }));
    const body = t.$(".ask")!.textContent!;
    expect(body).toContain("Claude просит разрешения");
    expect(t.$(".ask-chip")!.textContent).toBe("Bash");
    expect(t.$(".ask-subject")!.textContent).toBe("npm test");
    for (const s of ["Claude хочет выполнить npm test", "нет правила", "C:/x"]) expect(body).toContain(s);
    expect(t.$$(".ask button").map((b) => b.textContent)).toEqual(["Разрешить", "Разрешать всегда", "Отклонить"]);
    const u = await permUi(perm({ suggestions: [] }));
    expect(u.$$(".ask button").map((b) => b.textContent)).toEqual(["Разрешить", "Отклонить"]);
    expect(u.$(".ask")!.textContent).not.toContain("·");
  });

  it("7211 правило и куда ляжет видно до нажатия", async () => {
    const shown = async (suggestions: unknown[]) => {
      const relay = relayFor();
      const f = { type: "question", from: BUSY, to: ["phone"], question: "toolu_s", kind: "perm", tool: "Bash", input: { command: "npm test" }, suggestions };
      relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === BUSY ? [bare(f)] : [] });
      const t = await chat(BUSY, { relay, wide: true });
      relay.push(f);
      await flush();
      return t;
    };
    const t = await shown([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]);
    expect(t.$(".chat-ask")!.textContent).toContain("Bash(npm test:*) · локально");
    const u = await shown([{ type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addDirectories", directories: ["/tmp/a"], destination: "session" }]);
    expect(u.$(".chat-ask")!.textContent).toContain("Правки сами · сессия");
    expect(u.$(".chat-ask")!.textContent).toContain("/tmp/a · сессия");
  });

  it("7133 7134 «Разрешить» — allow; «Разрешать всегда» — allow с always; своих правил клиент не шлёт", async () => {
    const t = await permUi(perm());
    await t.press("Разрешить");
    expect(t.sent[0]).toMatchObject({ callsign: ASKING, question: "toolu_p1", action: "allow" });
    expect(t.sent[0].always).toBeUndefined();
    expect(t.$(".ask")!.textContent).toContain("Разрешить");
    expect(t.button("Разрешать всегда")).toBeUndefined();
    const u = await permUi(perm());
    await u.press("Разрешать всегда");
    expect(u.sent[0]).toMatchObject({ action: "allow", always: true });
    expect(u.sent[0].updatedPermissions).toBeUndefined();
  });

  it("7135 «Отклонить» открывает причину: с причиной — message, без — нет; «Назад» возвращает кнопки", async () => {
    const t = await permUi(perm());
    await t.press("Отклонить");
    expect(t.sent).toHaveLength(0);
    await t.press("Назад");
    expect(t.button("Разрешить")).toBeDefined();
    await t.press("Отклонить");
    await t.reason("не трогай");
    await t.press("Отклонить");
    expect(t.sent[0]).toMatchObject({ action: "deny", message: "не трогай" });
    const u = await permUi(perm());
    await u.press("Отклонить");
    await u.press("Отклонить");
    expect(u.sent[0]).toMatchObject({ action: "deny" });
    expect(u.sent[0].message).toBeUndefined();
  });

  it("7136 ответили с другого устройства — кнопок нет; ход прервали — вопрос снят", async () => {
    const t = await permUi(perm());
    t.relay.push({ type: "answered", from: ASKING, question: "toolu_p1", by: "phone", action: "allow" });
    await flush();
    expect(t.$(".ask")!.textContent).toContain("Уже ответили с phone");
    expect(t.button("Разрешить")).toBeUndefined();
    const u = await permUi(perm());
    u.relay.push({ type: "answered", from: ASKING, question: "toolu_p1", cancelled: true });
    await flush();
    expect(u.$(".ask")!.textContent).toContain("Вопрос снят");
  });

  it("7137 отказ сети: слово на экране, кнопки остаются", async () => {
    const t = await permUi(perm());
    t.relay.handlers.answer = () => ({ ok: false, error: "offline" });
    await t.press("Разрешить");
    expect(t.$(".ask")!.textContent).toContain("Не отправлено: offline");
    expect(t.button("Разрешить")).toBeDefined();
  });

  it("7140 план разметкой и три кнопки", async () => {
    const t = await permUi(plan());
    expect(t.$(".ask-plan h2")!.textContent).toBe("Шаги");
    expect(t.$(".ask-plan strong")!.textContent).toBe("Найти");
    expect(t.$$(".ask button").map((b) => b.textContent)).toEqual(["Одобрить", "Одобрить и разрешать правки", "Вернуть с замечаниями"]);
  });

  it("7141 «Одобрить» — allow; «и разрешать правки» — allow с always", async () => {
    const t = await permUi(plan());
    await t.press("Одобрить");
    expect(t.sent[0]).toMatchObject({ question: "toolu_e1", action: "allow" });
    expect(t.sent[0].always).toBeUndefined();
    const u = await permUi(plan());
    await u.press("Одобрить и разрешать правки");
    expect(u.sent[0]).toMatchObject({ action: "allow", always: true });
  });

  it("7142 «Вернуть с замечаниями» — поле и deny с замечаниями", async () => {
    const t = await permUi(plan());
    await t.press("Вернуть с замечаниями");
    await t.reason("добавь тест");
    await t.press("Вернуть");
    expect(t.sent[0]).toMatchObject({ action: "deny", message: "добавь тест" });
  });
});

describe("запрос разрешения в карточке инструмента", () => {
  const tool = asst("a1", [{ type: "tool_use", id: "toolu_p1", name: "Bash", input: { command: "npm test" } }]);
  const asking = { type: "question", from: BUSY, to: ["phone"], question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test" } };

  it("7157 7158 пока идёт запрос — «ждёт разрешения», «В фон» нет; ответили — снова идёт; чужой вопрос карточку не трогает", async () => {
    const relay = relayFor(roster(), [tool]);
    const t = await chat(BUSY, { relay, wide: true });
    relay.handlers["question.list"] = () => ({ ok: true, result: [bare(asking)] });
    relay.push(asking);
    await flush();
    const card = () => t.$('.chat-tool[data-tool="Bash"]')!;
    expect(card().getAttribute("data-state")).toBe("wait");
    expect(card().querySelector(".tc-st")!.textContent).toBe("ждёт разрешения");
    expect(t.text()).not.toContain("выполнится");
    expect(card().textContent).not.toContain("В фон");
    relay.push({ type: "answered", from: BUSY, question: "toolu_p1", by: "phone", action: "allow" });
    await flush();
    expect(card().getAttribute("data-state")).toBe("running");
    relay.push({ ...asking, question: "toolu_other", tool: "Read" });
    await flush();
    expect(card().getAttribute("data-state")).toBe("running");
  });

  it("7159 отклонённый человеком — «отклонено» и причина; и план, который вернули", async () => {
    const reply = (id: string, s: string) => ({ type: "user", uuid: `r${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: s, is_error: true }] } });
    const relay = relayFor(roster(), [tool, reply("toolu_p1", "The user doesn't want to proceed with this tool use. Reason: не трогай"), asst("a2", [{ type: "tool_use", id: "toolu_e", name: "ExitPlanMode", input: { plan: "1. шаг" } }]), reply("toolu_e", "The user doesn't want to proceed with this tool use. Reason: добавь тест")]);
    const t = await chat(BUSY, { relay, wide: true });
    for (const name of ["Bash", "ExitPlanMode"]) {
      const card = t.$(`.chat-tool[data-tool="${name}"]`)!;
      expect(card.getAttribute("data-state")).toBe("denied");
      expect(card.querySelector(".tc-st")!.textContent).toBe("отклонено");
    }
    await t.click(t.$('.chat-tool[data-tool="Bash"] .tc-h'));
    expect(t.$('.chat-tool[data-tool="Bash"] .tb-pre:not(.muted)')!.textContent).toBe("не трогай");
    expect(t.text()).not.toContain("doesn't want");
  });

  it("7212 пока план ждёт одобрения, в карточке свёрнут; ответили — раскрыт; правка Edit раскрыта и пока ждёт", async () => {
    const listOf = (get: () => unknown[]) => (x: { callsign?: unknown }) => ({ ok: true as const, result: x.callsign === BUSY ? get() : [] });
    const relay = relayFor(roster(), [asst("a1", [{ type: "tool_use", id: "toolu_pl", name: "ExitPlanMode", input: { plan: "## План один" } }])]);
    const pl = { question: "toolu_pl", kind: "perm", tool: "ExitPlanMode", input: { plan: "## План один" } };
    relay.handlers["question.list"] = listOf(() => [pl]);
    const t = await chat(BUSY, { relay, wide: true });
    relay.push({ type: "question", from: BUSY, to: ["phone"], ...pl });
    await flush();
    expect(t.$(".chat-ask")!.textContent).toContain("План один");
    expect(t.$('.chat-tool[data-tool="ExitPlanMode"] .tc-h')!.getAttribute("aria-expanded")).toBe("false");
    relay.push({ type: "answered", from: BUSY, question: "toolu_pl", by: "phone", action: "allow" });
    await flush();
    expect(t.$('.chat-tool[data-tool="ExitPlanMode"] .tc-h')!.getAttribute("aria-expanded")).toBe("true");
    const edit = { question: "toolu_ed", kind: "perm", tool: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } };
    const b = relayFor(roster(), [asst("a2", [{ type: "tool_use", id: "toolu_ed", name: "Edit", input: edit.input }])]);
    b.handlers["question.list"] = listOf(() => [edit]);
    const u = await chat(BUSY, { relay: b, wide: true });
    b.push({ type: "question", from: BUSY, to: ["phone"], ...edit });
    await flush();
    expect(u.$('.chat-tool[data-tool="Edit"] .tc-h')!.getAttribute("aria-expanded")).toBe("true");
  });
});

// Правила, что жили только в комментариях старого кода: сверка комментариев круга 3. Источник — чьё: код.
describe("правила из комментариев старого кода", () => {
  const sized = (el: HTMLElement, o: { height: number; top: number }) => {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => o.height });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => o.top, set: (v: number) => void (o.top = v) });
  };

  it("разрыв длиннее страницы: прежнее не встаёт после новой страницы", async () => {
    // намеренное расхождение: старый код ставил новое впереди прежнего; источник — правило «новое — у своего соседа», спорное место круга 3
    let page: unknown[] = [user("o1", "старое")];
    let more = false;
    const relay = relayFor();
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: page, more } });
    const t = await chat(IDLE, { relay, wide: true });
    await t.events(IDLE, [], 1);
    page = [user("n1", "новое")];
    more = true;
    await t.events(IDLE, [], 5);
    const shown = t.$$(".chat-me").map((x) => x.textContent).join(" ");
    expect(shown).toContain("новое");
    expect(shown).not.toMatch(/новое.*старое/);
  });

  it("«Раньше»: лента остаётся на том же сообщении", async () => {
    const o = { height: 1000, top: 900 };
    const relay = relayFor();
    relay.handlers["session.history"] = (x) => {
      if (!x.before) return { ok: true, result: { messages: [user("u2", "потом")], more: true } };
      o.height = 1500;
      return { ok: true, result: { messages: [user("u1", "раньше")], more: false } };
    };
    const t = await chat(IDLE, { relay, wide: true });
    sized(t.$<HTMLElement>(".chat-feed")!, o);
    await t.click(t.$(".chat-older"));
    await flush(5);
    expect(o.top).toBe(1400);
  });

  it("от низа уводит только прокрутка вверх: рост ленты стороной не считается", async () => {
    const o = { height: 1000, top: 900 };
    const t = await chat(IDLE, { wide: true });
    const f = t.$<HTMLElement>(".chat-feed")!;
    sized(f, o);
    f.dispatchEvent(new Event("scroll"));
    await flush();
    o.height = 2000;
    f.dispatchEvent(new Event("scroll"));
    await flush();
    expect(t.$(".chat-jump")).toBeNull();
  });

  it("подсказка — по тексту до каретки; выбор не трогает текст за ней", async () => {
    const relay = relayFor();
    relay.handlers["session.files"] = () => ({ ok: true, result: ["worker.ts"] });
    const t = await chat(IDLE, { relay });
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = "Сравни @w с этим";
    inp.selectionStart = inp.selectionEnd = 9;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(5);
    expect(relay.sent("session.files").at(-1)).toMatchObject({ query: "w" });
    await t.key("Enter");
    expect(inp.value).toContain("@worker.ts");
    expect(inp.value).toMatch(/с этим$/);
    expect(relay.sent("session.prompt")).toHaveLength(0);
  });

  it("«Авто»: модели сессии нет в списке — решает запись по умолчанию", async () => {
    const relay = relayFor(roster((x) => void (x.sessions.find((s) => s.callsign === BUSY)!.mode = "default")));
    relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? ({ ok: true, result: [{ value: "opus" }, { value: "default", supportsAutoMode: true }] } as never) : ({ ok: true, result: [] } as never));
    const t = await chat(BUSY, { relay, wide: true });
    await t.events(BUSY, [{ type: "system", subtype: "init", model: "claude-haiku-5-5", uuid: "i1" }]);
    expect([...t.$<HTMLSelectElement>(".chat-mode")!.options].map((o) => o.value)).toContain("auto");
  });

  it("ход прервал человек: строка ошибки не показывается и через служебную строку", async () => {
    const f = await feed([human("[Request interrupted by user]"), sys("informational", { content: "заметка" }), { type: "result", uuid: uid(), subtype: "error_during_execution", is_error: true }]);
    expect(f.q(".chat-res")).toBeNull();
  });
});

// Видимое, которое потеряла перепись и нашла сверка строк круга 3. Источник — чьё: код.
describe("видимое из сверки строк", () => {
  it("длинное сообщение сессии: «показать всё» раскрывает, «свернуть» сворачивает обратно", async () => {
    const f = await feed([human(`<fleet-message from="a@b">\n${"слово ".repeat(200)}\n</fleet-message>`)]);
    expect(f.q(".chat-more")!.textContent).toBe("показать всё");
    await f.open(".chat-more");
    expect(f.q(".chat-clamp")).toBeNull();
    expect(f.q(".chat-more")!.textContent).toBe("свернуть");
    expect(f.q(".chat-more")!.getAttribute("aria-expanded")).toBe("true");
    await f.open(".chat-more");
    expect(f.q(".chat-clamp")).not.toBeNull();
    expect(f.q(".chat-more")!.textContent).toBe("показать всё");
  });

  it("план на одобрение: так и назван в вопросе, в строке списка и над вводом", async () => {
    const pl = { question: "toolu_pl", kind: "perm", tool: "ExitPlanMode", input: { plan: "1. шаг" } };
    const relay = relayFor();
    relay.handlers["question.list"] = (x) => ({ ok: true, result: x.callsign === BUSY ? [pl] : [] });
    const t = await chat(BUSY, { relay, wide: true });
    relay.push({ type: "question", from: BUSY, to: ["phone"], ...pl });
    await flush();
    expect(t.$(".chat-ask .ask-qt")!.textContent).toBe("План на одобрение");
    const u = await chat(BUSY, { relay: (() => { const r = relayFor(); r.handlers["question.list"] = relay.handlers["question.list"]; return r; })() });
    u.relay.push({ type: "question", from: BUSY, to: ["phone"], ...pl });
    await flush();
    expect(u.$(".chat-askbar span")!.textContent).toBe("План на одобрение");
  });

  it("подписи и тексты кнопок экрана", async () => {
    const r = roster((x) => void (x.sessions.find((s) => s.callsign === BUSY)!.mode = "default"));
    const t = await chat(BUSY, { relay: relayFor(r, [user("u1", "раз")]), wide: true });
    const f = t.$<HTMLElement>(".chat-feed")!;
    let top = 900;
    Object.defineProperty(f, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(f, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(f, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
    f.dispatchEvent(new Event("scroll"));
    top = 100;
    f.dispatchEvent(new Event("scroll"));
    await flush();
    expect(t.$(".chat-jump")!.getAttribute("aria-label")).toBe("К последнему");
    expect(t.$(".chat-jump")!.classList.contains("sb-ic")).toBe(true);
    expect(t.$$(".chat-bar > *").map((x) => x.textContent)).toEqual(["контекст", "фокус", "выгрузить .md"]);
    expect(t.$$(".chat-tools [aria-label]").map((x) => x.getAttribute("aria-label"))).toEqual(["Вложить файл", "Файл папки", "Команда", "Режим разрешений", "Отправить"]);
    expect(t.$(".chat-stop")!.textContent).toBe("Прервать");
    expect(t.$(".chat-rw")!.textContent).toBe("откатить файлы");
    expect(t.$(".chat-inp")!.getAttribute("placeholder")).toMatch(/^В очередь /);
  });

  it("нет ленты у машины: история всё равно читается", async () => {
    const r = roster((x) => void delete (x.machines.find((y) => y.machine === "pc")!.contract as Record<string, unknown>)["session.watch"]);
    const t = await chat(IDLE, { relay: relayFor(r, [user("u1", "раньше")]) });
    expect(t.relay.sent("session.history")).toHaveLength(1);
    expect(t.$(".chat-me")!.textContent).toContain("раньше");
  });

  it("субагент внутри субагента: шаг и ход времени — в карточке своего родителя; ответ раньше плашки ошибки", async () => {
    const a = { parent_tool_use_id: "t1" };
    const b = { parent_tool_use_id: "t2" };
    const f = await feed([toolUse("t1", "Agent"), toolUse("t2", "Agent", {}, a), toolUse("t3", "Bash", { command: "x" }, b), { type: "tool_progress", tool_use_id: "t3", elapsed_time_seconds: 7 }, text("начало", { error: "overloaded" })]);
    expect(f.q('.tb-steps .tb-steps [data-tool="Bash"] .tc-st')!.textContent).toBe("7 с");
    expect([...f.q(".chat-col")!.children].slice(-2).map((x) => x.className)).toEqual(["chat-reply", "chat-ban bad"]);
  });

  it("итог ответа — карточкой итога; сообщение сессии — со временем записи", async () => {
    const f = await feed([human('<fleet-message from="a@b">\nx\n</fleet-message>', { timestamp: "2026-11-04T10:20:00" })]);
    expect(f.q(".chat-in.fleet small")!.textContent).toBe("10:20");
    const relay = relayFor();
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: "q", kind: "ask", questions: [{ question: "База?", options: [{ label: "да" }] }] }] });
    relay.handlers.answer = () => ({ ok: true });
    const t = await stand(parts(), { relay });
    await open(`#ask?callsign=${encodeURIComponent(ASKING)}`);
    await flush(5);
    await t.click(t.$(".ask-opt"));
    await t.click(t.button("Ответить"));
    expect(t.$('.sb-okc[role="status"] b')!.textContent).toBe("Ответ «да» принят.");
    expect(relay.sent("answer")[0]).not.toHaveProperty("label");
  });
});

// Сверка со старым кодом, второй проход: что потерялось на основном пути и в ожидаемых ветках. Чьё: код до сноса.
describe("сверка строк, второй проход", () => {
  const ordered = (t: Ui) => t.$$(".chat-me, .chat-reply").map((x) => (x.className.includes("chat-me") ? "я" : "claude"));
  const sent = async (t: Ui, body: string) => {
    await t.type(body);
    await t.click(t.$(".chat-send"));
  };

  it("своя отправка гасит подсказку", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.events(IDLE, [{ type: "prompt_suggestion", uuid: "h", suggestion: "дальше" }], 1);
    expect(t.$(".chat-hint")).not.toBeNull();
    await sent(t, "Катим");
    expect(t.$(".chat-hint")).toBeNull();
  });

  it("своё сообщение стоит там, где отправлено: SDK эха не шлёт, ответ — под ним, в выгрузке есть", async () => {
    const t = await chat(IDLE, { wide: true });
    await sent(t, "Катим");
    await t.events(IDLE, [asst("a1", [{ type: "text", text: "Ответ" }])], 1);
    expect(ordered(t)).toEqual(["я", "claude"]);
    const link = t.$$<HTMLAnchorElement>(".chat-bar a")[0];
    link.addEventListener("click", (e) => e.preventDefault());
    await t.click(link);
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain("## Вы\n\nКатим");
  });

  it("своя слэш-команда: строка команды сменяет пузырь и на живой ленте", async () => {
    const t = await chat(IDLE, { wide: true });
    await sent(t, "/compact");
    expect(t.$(".chat-me")).not.toBeNull();
    await t.events(IDLE, [user("c1", "<command-name>/compact</command-name>")], 1);
    expect(t.$(".chat-me")).toBeNull();
    expect(t.$$(".chat-cmd")).toHaveLength(1);
  });

  it("своя картинка не задваивается, когда запись пришла из разговора", async () => {
    const t = await chat(IDLE, { wide: true });
    await t.pick(txt("a.png", "image/png"));
    await sent(t, "Смотри");
    const p = t.relay.sent("session.prompt")[0];
    const { data } = (p.attachments as Array<{ data: string }>)[0];
    await t.events(IDLE, [{ type: "user", uuid: p.uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: "Смотри" }] } }], 1);
    expect(t.$$(".chat-me .chat-pics img")).toHaveLength(1);
  });

  it("«Сжать контекст» не трогает написанное в поле и вложения", async () => {
    const relay = relayFor();
    answerWith(relay, { getContextUsage: () => ({ ok: true, result: { totalTokens: 1, maxTokens: 2, percentage: 50 } }) });
    const t = await chat(IDLE, { relay, wide: true });
    await t.pick(txt("a.txt"));
    await t.type("черновик");
    await t.click(t.btn(".chat-bar", "контекст"));
    await flush(10);
    await t.click(t.btn(".chat-panel", "Сжать контекст"));
    expect(relay.sent("session.prompt")[0]).toMatchObject({ text: "/compact" });
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("черновик");
    expect(t.$$(".chat-file")).toHaveLength(1);
  });

  it("«Раньше» не трогает раскрытое: карточка остаётся открытой, чужая не открывается", async () => {
    const relay = relayFor();
    const tool = (id: string, word: string) => ({ type: "assistant", uuid: `a-${id}`, message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: word } }] } });
    relay.handlers["session.history"] = (x) => (x.before ? { ok: true, result: { messages: [tool("t0", "раньше")], more: false } } : { ok: true, result: { messages: [tool("t1", "потом")], more: true } });
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.$('[data-tool="Bash"] .tc-h'));
    expect(t.$('[data-tool="Bash"] .tc-b')!.textContent).toContain("потом");
    await t.click(t.$(".chat-older"));
    expect(t.$$('[data-tool="Bash"] .tc-b').map((x) => x.textContent)).toEqual([expect.stringContaining("потом")]);
  });

  it("чтение файла с картинкой: текст и картинка", async () => {
    const f = await feed([toolUse("t1", "Read", { file_path: "a.ipynb" }), res("t1", [{ type: "text", text: "ячейка" }, ...PIC])]);
    if (!f.q('[data-tool="Read"] .tc-b')) await f.openTool("Read");
    expect(f.q('[data-tool="Read"] .tb-pre')!.textContent).toContain("ячейка");
    expect(f.qq('[data-tool="Read"] .tb-img')).toHaveLength(1);
  });

  it("отказ с заменой модели — щитом", async () => {
    const f = await feed([sys("model_refusal_fallback", { original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5" })]);
    expect(f.q(".chat-ban.wait svg.lucide-shield-off")).not.toBeNull();
  });

  it("«Раньше» — кнопка набора: высота касания на телефоне", async () => {
    const relay = relayFor();
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [user("u", "x")], more: true } });
    const t = await chat(IDLE, { relay });
    expect(t.$("button.sb-b.chat-older")).not.toBeNull();
  });

  it("смена аккаунта, пока разговор не открывали: строка видна при открытии", async () => {
    const relay = relayFor(roster((x) => void (x.sessions[0].account = "infirex")));
    const t = await stand(parts(), { relay });
    relay.setRoster(roster((x) => void (x.sessions[0].account = "yurianrun")));
    await flush();
    await open(`/#chat?callsign=${encodeURIComponent(BUSY)}`);
    await flush(5);
    expect(t.$(".chat-sys.swap")?.textContent).toBe("аккаунт: infirex → yurianrun");
  });

  it("вопрос пришёл кадром: список у Host уже не спрашивается", async () => {
    const t = await stand(parts());
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push(frame(IDLE, "q1", Q1));
    await flush();
    await open(`/#ask?callsign=${encodeURIComponent(IDLE)}`);
    await flush(5);
    expect(t.relay.sent("question.list").filter((x) => x.callsign === IDLE)).toHaveLength(0);
  });
});
