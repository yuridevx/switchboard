// Разметка, которую нашла сверка деревьев старого и нового кода: снимки и тексты её не видят. Источник свойств — поведение кода до сноса (чьё: код).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, stand } from "../../core/stand/app.ts";
import { chat, open, parts, relayFor, roster, set } from "./stand.ts";

const BUSY = "site@laptop";
const ASKING = "profiles@laptop";
const IDLE = "poe-bot@pc";
const STOPPED = "wiki@pc";

vi.setConfig({ testTimeout: 20_000 });

type Msg = Record<string, unknown>;
let n = 0;
const uid = () => `x${++n}`;
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

async function feed(msgs: Msg[], cs = IDLE, wide = true) {
  const t = await chat(cs, { wide });
  await t.events(cs, msgs, 1);
  return { ...t, q: (s: string) => t.$(".chat-feed")!.querySelector<HTMLElement>(s), qq: (s: string) => [...t.$(".chat-feed")!.querySelectorAll<HTMLElement>(s)] };
}
const icon = (el: Element | null, name: string, size: number) => {
  const svg = el?.querySelector(`svg.lucide-${name}`);
  expect(svg, name).not.toBeNull();
  expect(svg!.getAttribute("width"), name).toBe(String(size));
};

describe("ввод", () => {
  const live = () => roster((x) => x.sessions.forEach((s) => void ((s as unknown as Msg).mode = "default")));

  it("форма набора: кнопки и поля набора страницы, файл — скрытым полем в конце формы", async () => {
    const t = await chat(BUSY, { relay: relayFor(live()), wide: true });
    const form = t.$("form.chat-comp")!;
    expect(form.lastElementChild!.getAttribute("type")).toBe("file");
    expect(form.lastElementChild!.hasAttribute("hidden")).toBe(true);
    expect(t.$("textarea.sb-in.chat-inp")).not.toBeNull();
    expect(t.$('button.sb-ic.chat-send[type="submit"]')).not.toBeNull();
    for (const label of ["Вложить файл", "Файл папки", "Команда"]) expect(t.$(`button.sb-ic.chat-tb[title="${label}"]`), label).not.toBeNull();
    expect(t.$('button.sb-b.chat-mode[title="Режим разрешений: нажатие — следующий"]')).not.toBeNull();
    expect(t.$("button.sb-b.bad.chat-stop")).not.toBeNull();
    icon(t.$(".chat-stop"), "square", 11);
    for (const [b, name] of [["Контекст", "gauge"], ["Фокус", "focus"], ["Выгрузить .md", "download"]]) icon(t.$(`[aria-label="${b}"]`), name, 16);
  });

  it("режима нет у неживой; модель — только из ленты: «Авто» без сведений не предлагается", async () => {
    const stopped = await chat(STOPPED, { relay: relayFor(live()), wide: true });
    expect(stopped.$(".chat-mode")).toBeNull();
    const relay = relayFor(live());
    relay.handlers["session.call"] = (f) => (f.method === "supportedModels" ? ({ ok: true, result: [{ value: "sonnet", supportsAutoMode: true }] } as never) : ({ ok: true, result: [] } as never));
    const t = await chat(IDLE, { relay, wide: true });
    await flush(5);
    expect(t.$<HTMLButtonElement>(".chat-mode")!.dataset.modes).not.toContain("auto");
  });

  it("подсказки и вложения: вид списка, строка набора, значок файла", async () => {
    const relay = relayFor();
    relay.handlers["session.files"] = () => ({ ok: true, result: ["a.ts"] });
    relay.handlers["session.call"] = () => ({ ok: true, result: [{ name: "compact" }] }) as never;
    const t = await chat(IDLE, { relay, wide: true });
    await t.type("/");
    expect(t.$('.chat-sug[data-kind="cmd"] .sb-rw.chat-sugi')).not.toBeNull();
    await t.type("@");
    await flush(5);
    expect(t.$('.chat-sug[data-kind="file"] .sb-rw.chat-sugi svg.lucide-file-text')).not.toBeNull();
    await t.pick(new File(["x"], "a.txt", { type: "text/plain" }));
    icon(t.$(".chat-file"), "file-text", 13);
    expect(t.$(".chat-file button.sb-ic")).not.toBeNull();
    await t.events(IDLE, [{ type: "prompt_suggestion", suggestion: "Дальше" }], 1);
    await t.type("");
    expect(t.$(".sb-b.chat-hint svg.lucide-lightbulb")).not.toBeNull();
  });
});

describe("строки ленты", () => {
  it("итог хода — части по одной; обрыв — значком; плашка ошибки — тревогой", async () => {
    const f = await feed([{ type: "result", uuid: uid(), subtype: "success", duration_ms: 2000, total_cost_usd: 1 }, { type: "result", uuid: uid(), subtype: "error_max_turns", is_error: true }, say([], { error: "overloaded" })]);
    expect([...f.q(".chat-res")!.children].map((x) => x.tagName + (x.firstElementChild?.className ?? ""))).toEqual(["SPANchat-nb", "SPANchat-nb", "SPANchat-nb"]);
    icon(f.q(".chat-res.err"), "triangle-alert", 13);
    expect(f.q('.chat-ban.bad[role="alert"]')).not.toBeNull();
    icon(f.q(".chat-ban.bad"), "x", 15);
  });

  it.each([
    ["лимит", { type: "rate_limit_event", uuid: "l", rate_limit_info: { status: "rejected" } }, ".chat-ban", "gauge", 15],
    ["запасная модель", sys("model_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5" }), ".chat-ban", "shuffle", 15],
    ["хук", sys("hook_response", { hook_name: "a", exit_code: 1 }), ".chat-line", "anchor", 13],
    ["память", sys("memory_recall", { memories: [{ path: "a.md" }] }), ".chat-line", "book-open", 13],
    ["запрет", sys("permission_denied", { tool_name: "a" }), ".chat-line", "ban", 13],
    ["файлы", sys("files_persisted", { files: [{ filename: "a" }] }), ".chat-line", "file-up", 13],
    ["сброс", { type: "conversation_reset", uuid: "c" }, ".chat-sys", "rotate-ccw", 13],
    ["прервано", human("[Request interrupted by user]"), ".chat-sys", "square", 11],
    ["команда", human("<command-name>/x</command-name>"), ".chat-cmd", "zap", 12],
  ])("значок строки: %s", async (_n, m, sel, name, size) => {
    icon((await feed([m as Msg])).q(sel), name as string, size as number);
  });

  it("смена модели — своим значком; команда с аргументами одной строкой; вывод — последней команде без вывода", async () => {
    const f = await feed([sys("init", { model: "claude-opus-5-5" }), sys("init", { model: "claude-sonnet-5-5" }), human("<command-name>/a</command-name><command-args>--b</command-args>"), sys("local_command_output", { content: "итог" })]);
    icon(f.q(".chat-sys"), "sparkles", 13);
    expect([...f.q(".chat-cmd > span")!.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent)).toEqual(["/a --b"]);
    expect(f.q(".chat-cmd pre")!.textContent).toBe("итог");
  });

  it("из истории у своего сообщения нет строки состояния; сообщение владельцу без data-from; строка отправителя без обёртки", async () => {
    const t = await chat(IDLE, { relay: relayFor(roster(), [human("раз", { timestamp: "2026-11-04T10:20:00" })]), wide: true });
    expect(t.$(".chat-me small")).toBeNull();
    t.relay.push({ type: "message", from: IDLE, to: "phone", text: "два" });
    await flush();
    expect(t.$(".chat-in")!.hasAttribute("data-from")).toBe(false);
    await t.events(IDLE, [human('<fleet-message from="a@b">\nx\n</fleet-message>')], 1);
    const from = t.$(".chat-in.fleet .chat-from")!;
    icon(from, "messages-square", 13);
    expect(from.querySelector("span")).toBeNull();
  });

  it("живой обрыв хода — со временем прихода; из истории — без него", async () => {
    const f = await feed([human("[Request interrupted by user]")]);
    expect(f.q(".chat-sys.wait")!.textContent).toMatch(/^прервано · \d\d:\d\d$/);
    const t = await chat(IDLE, { relay: relayFor(roster(), [human("[Request interrupted by user]")]) });
    expect(t.$(".chat-sys.wait")!.textContent).toBe("прервано");
  });

  it("отказ подряд — одна плашка; граница сжатия без чисел — словом, сводка раньше границы — на одной строке; повтор — код ошибки; размышление остаётся после конца хода", async () => {
    const refusal = () => say([], { isApiErrorMessage: true }, { stop_reason: "refusal" });
    const f = await feed([refusal(), refusal(), sys("compact_boundary", {}), sys("api_retry", { attempt: 1, max_retries: 3, error_status: 529 })]);
    expect(f.qq(".chat-ban")).toHaveLength(1);
    expect(f.qq(".chat-sys").map((x) => x.textContent)).toEqual(["контекст сжат", "повтор запроса к API · 1 из 3 · 529"]);
    const s = await feed([human("Summary:\nсуть", { isCompactSummary: true }), sys("compact_boundary", { compact_metadata: { pre_tokens: 9000 } })]);
    expect(s.qq(".chat-sys")).toHaveLength(0);
    expect(s.q(".chat-sum .dis-h")!.textContent).toBe("контекст сжат · 9 К");
    const g = await feed([{ type: "stream_event", event: { type: "message_start", message: { id: "m" } } }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "ду" } } }, { type: "result", uuid: uid(), subtype: "success" }]);
    expect(g.q(".chat-think .dis-h")!.textContent).toBe("Размышлял");
  });

  it("конец задачи: значок вида, слово и описание приглушённо; без описания — итог задачи", async () => {
    const f = await feed([sys("task_started", { task_id: "a", description: "сборка", task_type: "local_bash" }), sys("task_notification", { task_id: "a", status: "completed" }), sys("task_started", { task_id: "b", task_type: "local_agent" }), sys("task_notification", { task_id: "b", status: "failed", summary: "итог" })]);
    const [a, b] = f.qq(".chat-line");
    icon(a, "terminal", 13);
    expect(a.querySelector(".chat-dim")!.textContent).toBe(" · сборка");
    icon(b, "bot", 13);
    expect(b.querySelector(".chat-dim")!.textContent).toBe(" · итог");
  });

  it("документ из разговора не показывается вложением; своё вложение — показывается", async () => {
    const f = await feed([human([{ type: "document", title: "a.pdf", source: {} }, { type: "text", text: "текст" }])]);
    expect(f.q(".chat-me")!.textContent).toContain("текст");
    expect(f.q(".chat-att")).toBeNull();
  });
});

describe("задача от родителя", () => {
  // источник: опыт на настоящем SDK 5 нояб.: текст задачи с подсказкой приходит из истории как есть, строка показывалась своим пузырём с тегом
  const TASK = '<fleet-message from="lead@pc">\nОбнови README\n</fleet-message>\n(Задача от родителя lead@pc: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)';
  it.each([
    ["из истории", {}],
    ["из ленты", { origin: { kind: "peer", from: "lead@pc", name: "lead@pc" } }],
  ])("одна строка «сессия Claude · родитель», без тега и подсказки: %s", async (_n, x) => {
    const f = await feed([human(TASK, x)]);
    expect(f.q(".chat-me")).toBeNull();
    const row = f.q(".chat-in.fleet")!;
    expect(row.textContent).toContain("сессия Claude · lead@pc");
    expect(row.textContent).toContain("Обнови README");
    expect(row.textContent).not.toContain("fleet-message");
    expect(row.textContent).not.toContain("Задача от родителя");
  });
});

describe("карточка инструмента", () => {
  it("шапка и значки: заголовок раскрытия, размеры, подпись субагента, сводка задач", async () => {
    const f = await feed([toolUse("a", "Agent", { description: "x", subagent_type: "Explore" }), toolUse("b", "Bash", { command: "c" }), res("b", "нет", true), toolUse("g", "Grep", { pattern: "x" }), res("g"), toolUse("t", "TodoWrite", { todos: [{ content: "сделать", activeForm: "делаю", status: "in_progress" }] })], BUSY);
    expect(f.q('[data-tool="Agent"] .sb-ds.tc-h')).not.toBeNull();
    icon(f.q('[data-tool="Agent"] .tc-i'), "bot", 15);
    expect(f.q('[data-tool="Agent"] .tc-chip')!.textContent).toBe("Explore");
    icon(f.q('[data-tool="Agent"] .tc-st.run'), "loader-circle", 13);
    icon(f.q('[data-tool="Bash"] .tc-st.bad'), "x", 13);
    icon(f.q('[data-tool="Grep"] .tc-st.ok'), "check", 14);
    expect(f.q('[data-tool="TodoWrite"] .chat-todos span')!.textContent).toBe("делаю");
    icon(f.q(".chat-todos li"), "circle-dot", 14);
  });

  it("идущая задача: у любой карточки «В фон» и «Стоп» кнопками набора; вопрос — жирным", async () => {
    const f = await feed([toolUse("a", "Agent", { description: "x" }), sys("task_started", { task_id: "k", tool_use_id: "a", task_type: "local_agent" }), toolUse("q", "AskUserQuestion", { questions: [{ question: "Базу?", options: [{ label: "а" }] }] })], BUSY);
    const bar = f.q('[data-tool="Agent"] .tc-bar')!;
    expect([...bar.querySelectorAll("button.sb-b.chat-mini")].map((b) => b.textContent)).toEqual(["В фон", "Стоп"]);
    icon(bar, "arrow-down-to-line", 13);
    icon(bar, "square", 11);
    expect(f.q(".tb-md .tb-q b")!.textContent).toBe("Базу?");
  });

  it("фоновая задача кончилась: метка «в фоне»; упала — карточка без вывода идёт; остановлена — жёлтым", async () => {
    const f = await feed([toolUse("a", "Bash", { command: "x" }), sys("task_started", { task_id: "a1", tool_use_id: "a", is_backgrounded: true }), sys("task_notification", { task_id: "a1", status: "failed" }), toolUse("b", "PowerShell", { command: "y" }), sys("task_started", { task_id: "b1", tool_use_id: "b", is_backgrounded: true }), sys("task_notification", { task_id: "b1", status: "stopped" })], BUSY);
    expect(f.q('[data-tool="Bash"]')!.dataset.state).toBe("running");
    expect(f.q('[data-tool="Bash"] .tc-chip')!.textContent).toBe("в фоне");
    expect(f.q('[data-tool="PowerShell"] .tc-st.wait')!.textContent).toBe("остановлено");
    icon(f.q('[data-tool="PowerShell"] .tc-i'), "terminal", 15);
  });

  it("вывод задачи — вход и итог; страница записи — рамка с именем файла; ход, пришедший раньше вызова, времени не даёт", async () => {
    const f = await feed([toolUse("o", "TaskOutput", { task_id: "k" }), res("o"), toolUse("w", "Write", { file_path: "a.html", content: "<b>x</b>" }), { type: "tool_progress", tool_use_id: "n", elapsed_time_seconds: 18 }, toolUse("n", "Bash", { command: "c" })], BUSY);
    await f.click(f.q('[data-tool="TaskOutput"] .tc-h'));
    expect(f.q('[data-tool="TaskOutput"] .tb-pre.muted')!.textContent).toContain('"task_id": "k"');
    await f.click(f.q('[data-tool="Write"] .tc-h'));
    expect(f.q('[data-tool="Write"] iframe')!.getAttribute("title")).toBe("a.html");
    expect(f.q('[data-tool="Bash"] .tc-st')!.textContent).toBe("");
  });

  it("поиск в сети — значком поиска; сноска длинного сообщения — заголовком раскрытия; метка режима словом набора", async () => {
    const f = await feed([toolUse("s", "WebSearch", { query: "q" }), human(`<cross-session-message from-name="t" from-mode="plan">\n${"а".repeat(701)}\n</cross-session-message>`)]);
    icon(f.q('[data-tool="WebSearch"] .tc-i'), "search", 15);
    expect(f.q(".sb-ds.chat-more")).not.toBeNull();
    expect(f.q(".chat-tag")!.textContent).toBe("план");
  });
});

describe("панель и док", () => {
  it("панель: раздел страницы, значки, агенты после сведений; «подключено» и внутри строки", async () => {
    const relay = relayFor(roster());
    relay.handlers["session.call"] = (f) => {
      const table: Record<string, unknown> = { getContextUsage: { totalTokens: 1, maxTokens: 2, percentage: 1 }, supportedAgents: [{ name: "Explore", description: "поиск" }], getStatus: { sections: [{ rows: [{ label: "MCP servers", value: "2 connected" }] }] } };
      return (String(f.method) in table ? { ok: true, result: table[String(f.method)] } : { ok: false, error: "unknown_method" }) as never;
    };
    const t = await chat(IDLE, { relay, wide: true });
    await t.click(t.$('.chat-tb[aria-label="Контекст"]'));
    await flush(5);
    const p = t.$('section.chat-panel[aria-label="Контекст"]')!;
    icon(p.querySelector(".chat-pn-h"), "gauge", 14);
    icon(t.btn(".chat-panel", "Сжать контекст"), "archive", 13);
    icon(t.btn(".chat-panel", "Перечитать сессию"), "refresh-cw", 13);
    expect(p.querySelector("div.chat-pn-s dd")!.textContent).toBe("2 подключено");
    expect([...p.children].at(-2)!.className).toBe("chat-pn-a");
  });

  it("док: фон раньше задач, кнопки набора, строка вопроса — текстовой кнопкой; вывод и сторона значками", async () => {
    const relay = relayFor(roster((x) => void ((x.sessions.find((s) => s.callsign === ASKING) as unknown as Msg).state = "waiting")));
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: "q", kind: "ask", questions: [{ question: "База?" }] }] });
    relay.handlers["session.call"] = () => ({ ok: false, error: "sdk_error" });
    const t = await chat(ASKING, { relay });
    await t.events(ASKING, [sys("task_started", { task_id: "a", description: "д", task_type: "local_bash", is_backgrounded: true }), toolUse("t", "TodoWrite", { todos: [{ content: "а", status: "pending" }] })], 1);
    const dock = [...t.$(".chat-dock")!.children].map((x) => x.className);
    expect(dock).toEqual(["dis chat-bg", "dis chat-todo", "chat-ask"]);
    expect(t.$("button.sb-tx.chat-askbar")).not.toBeNull();
    icon(t.$(".chat-bg .dis-h"), "layers", 14);
    icon(t.$(".chat-todo .dis-h"), "list-checks", 14);
    await t.click(t.$(".chat-bg .dis-h"));
    icon(t.$(".chat-bgr"), "terminal", 14);
    expect(t.$(".chat-bgr span")!.getAttribute("title")).toBe("д");
    await t.type("/btw что?");
    await t.key("Enter");
    icon(t.$(".chat-side"), "message-square-quote", 14);
    expect(t.$("button.sb-ic.chat-side-x")).not.toBeNull();
    expect(t.$(".chat-side-w, .chat-side-e")!.textContent).toBeTruthy();
  });

  it("своё: обрыв — состояние ok после ответа, в очереди есть откат; кнопки сообщения — текстовые", async () => {
    const relay = relayFor(roster());
    const t = await chat(BUSY, { relay, wide: true });
    await t.type("в очередь");
    await t.click(t.$(".chat-send"));
    const me = t.$$(".chat-me").at(-1)!;
    expect(me.getAttribute("data-state")).toBe("ok");
    expect(me.querySelector("button.sb-tx.chat-again.chat-cancel")).not.toBeNull();
    expect(me.querySelector("button.sb-tx.chat-rw svg.lucide-rotate-ccw-clock")).not.toBeNull();
    relay.handlers["session.prompt"] = () => ({ ok: false, error: "timeout" });
    await t.type("обрыв");
    await t.click(t.$(".chat-send"));
    expect(t.$(".chat-me.pend .chat-nb")!.textContent).toBe("не подтверждено ·");
    expect(t.$(".chat-me.pend button.sb-tx.chat-again")).not.toBeNull();
  });
});

describe("экран вопроса", () => {
  const ASK = { question: "q3", kind: "ask", questions: [{ question: "База?", options: [{ label: "прод" }] }] };
  const asked = async (q: Msg, handlers: Record<string, unknown> = {}) => {
    const relay = relayFor(roster());
    relay.handlers["question.list"] = () => ({ ok: true, result: [q] });
    Object.assign(relay.handlers, handlers);
    const t = await stand(parts(), { relay });
    await open(`#ask?callsign=${encodeURIComponent(ASKING)}`);
    await flush(5);
    return { ...t, relay };
  };

  it("варианты — строками набора, свой ответ несёт текст вопроса; шапка: ждёт ответа, снят, уже ответили", async () => {
    const t = await asked(ASK);
    expect(t.$("button.sb-rw.ask-opt")).not.toBeNull();
    await t.click(t.$(".ask-opt.own"));
    expect(t.$('input.sb-in.ask-own[type="text"]')!.getAttribute("data-own")).toBe("База?");
    expect(t.$(".sb-pill")!.textContent).toBe("ждёт ответа");
    t.relay.push({ type: "answered", from: ASKING, question: "q3", by: "a~b@c", answers: { "База?": "прод" } });
    await flush();
    expect(t.$(".sb-pill")!.textContent).toBe("уже ответили");
    expect(t.$('.ask [role="status"] b')!.textContent).toBe("Уже ответили с a~b@c: «прод».");
    expect(t.$('.ask [role="status"] span')!.textContent).toBe("Первый ответ выигрывает — ваш не отправлен повторно.");
    const u = await asked(ASK);
    u.relay.push({ type: "answered", from: ASKING, question: "q3", cancelled: true });
    await flush();
    expect(u.$(".sb-pill")!.textContent).toBe("снят");
  });

  it("форма: подпись поля отдельно, поля и список в одном виде; кнопки прямо на экране; ссылка без лишнего rel", async () => {
    const t = await asked({ question: "f", kind: "form", message: "М", schema: { properties: { a: { type: "string" }, b: { enum: ["x"] } } } });
    expect(t.$(".ask-field > span")!.textContent).toBe("a");
    expect(t.$('input.sb-in.ask-own[type="text"]')).not.toBeNull();
    expect(t.$("select.sb-in.ask-own")).not.toBeNull();
    expect(t.$(".ask > button.sb-b.ask-decline")).not.toBeNull();
    const u = await asked({ question: "u", kind: "url", message: "М", url: "https://a.b/" });
    expect(u.$(".ask-url")!.getAttribute("rel")).toBe("noopener");
  });

  it("разрешение: причина в две строки, правила только над кнопками; пустой экран — без обёртки вопроса", async () => {
    const t = await asked({ question: "p", kind: "perm", tool: "Bash", input: { command: "c" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], destination: "session" }] });
    expect(t.$$(".ask > .ask-note")).toHaveLength(1);
    await t.click(t.$$(".ask .ask-decline").at(-1)!);
    expect(t.$(".ask textarea")!.getAttribute("rows")).toBe("2");
    expect(t.$$(".ask > .ask-note")).toHaveLength(0);
    set(t.$<HTMLTextAreaElement>(".ask textarea")!, "нет");
    const e = await stand(parts(), { relay: relayFor(roster()) });
    await open(`#ask?callsign=${encodeURIComponent(IDLE)}`);
    await flush(5);
    expect(e.$(".ask-empty")).not.toBeNull();
    expect(e.$(".ask")).toBeNull();
  });
});
