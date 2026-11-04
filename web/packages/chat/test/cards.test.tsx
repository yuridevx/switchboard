// Карточки инструментов: сообщение SDK → шапка и тело. Свёртка и компоненты настоящие, соседей нет.
import { AppCtx } from "@switchboard/web-ui";
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ItemView } from "../src/cards/ItemView.tsx";
import { CardsCtx, type CardsView } from "../src/context.ts";
import { applyEvents, emptyFeed } from "../src/state/feed.ts";
import type { Feed } from "../src/state/types.ts";
import type { ToolInput, WireMessage } from "../src/state/wire.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function draw(node: ReactNode) {
  document.body.innerHTML = '<div id="r"></div>';
  const el = document.getElementById("r")!;
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

const view = (feed: Feed, more: Partial<CardsView> = {}): CardsView => ({ feed: () => feed, asking: () => false, name: "site@laptop", wide: true, ...more });
function Cards({ feed, more }: { feed: Feed; more?: Partial<CardsView> }) {
  return (
    <AppCtx.Provider value={{ use: (f: () => unknown) => f() } as never}><CardsCtx.Provider value={view(feed, more)}>
      {feed.items.map((it) => (
        <ItemView key={it.id} it={it} />
      ))}
    </CardsCtx.Provider></AppCtx.Provider>
  );
}
const call = (id: string, name: string, input: ToolInput = {}): WireMessage => ({ type: "assistant", uuid: `a-${id}`, message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown = "ok", is_error = false): WireMessage => ({ type: "user", uuid: `r-${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
const cards = (...msgs: WireMessage[]) => <Cards feed={applyEvents(emptyFeed(), msgs)} />;
const head = (el: Element, tool: string) => el.querySelector(`[data-tool="${tool}"] .tc-h`)!;
const open = async (el: Element, tool: string) => act(async () => (head(el, tool) as HTMLElement).click());
const bodyOf = (el: Element, tool: string) => el.querySelector(`[data-tool="${tool}"] .tc-b`);
const label = (el: Element, tool: string) => [head(el, tool).querySelector("b")!.textContent, head(el, tool).querySelector(".tc-sum")!.textContent];
const PIC = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }];

describe("шапка", () => {
  it("6700 · каждый инструмент — своя подпись и суть одной строкой", async () => {
    const shapes: Array<[string, ToolInput, string, string]> = [
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
    ];
    const el = await draw(cards(...shapes.map(([name, input], i) => call(`t${i}`, name, input))));
    for (const [name, , word, sum] of shapes) expect(label(el, name), name).toEqual([word, sum]);
  });

  it("6706 · остальные инструменты: своя подпись, а не имя как есть", async () => {
    const shapes: Array<[string, ToolInput, string, string]> = [
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
    const el = await draw(cards(...shapes.map(([name, input], i) => call(`t${i}`, name, input))));
    for (const [name, , word, sum] of shapes) expect(label(el, name), name).toEqual([word, sum]);
  });

  it("6701 · инструмент MCP и незнакомый: «сервер · инструмент» или имя как есть; тело — вход JSON и вывод", async () => {
    const el = await draw(cards(call("m", "mcp__github__create_issue", { title: "Таймаут" }), result("m", "вывод"), call("x", "Незнакомый", { a: "b" })));
    expect(label(el, "mcp__github__create_issue")).toEqual(["github · create_issue", "Таймаут"]);
    expect(label(el, "Незнакомый")).toEqual(["Незнакомый", "b"]);
    await open(el, "mcp__github__create_issue");
    const pres = bodyOf(el, "mcp__github__create_issue")!.querySelectorAll("pre");
    expect(JSON.parse(pres[0].textContent!)).toEqual({ title: "Таймаут" });
    expect(pres[1].textContent).toBe("вывод");
  });
});

describe("тело", () => {
  it("6702 · дифф правки: раскрыт сразу, «+N −M», строки по видам, длинный общий кусок свёрнут", async () => {
    const same = Array.from({ length: 10 }, (_, i) => `общая ${i}`).join("\n");
    const el = await draw(cards(call("e", "Edit", { file_path: "a.ts", old_string: `старая\n${same}\n`, new_string: `новая 1\nновая 2\n${same}\n` })));
    expect(el.querySelector(".chat-count")!.textContent).toBe("+2 −1");
    expect(el.querySelectorAll(".chat-diff .del")).toHaveLength(1);
    expect(el.querySelectorAll(".chat-diff .add")).toHaveLength(2);
    const shown = [...el.querySelectorAll(".chat-diff .same")].map((x) => x.textContent);
    expect(shown).toHaveLength(5);
    expect(shown[2]).toContain("⋯ 6 без изменений");
  });

  it("6703 · файл с подсветкой по расширению", async () => {
    const el = await draw(cards(call("r", "Read", { file_path: "a.ts" }), result("r", "const a = 1;")));
    await open(el, "Read");
    expect(bodyOf(el, "Read")!.querySelector(".hljs-keyword")!.textContent).toBe("const");
  });

  it("6704 · вопрос с вариантами или ответом; план разметкой", async () => {
    const q = { question: "Базу?", options: [{ label: "стенд" }, { label: "прод" }] };
    const el = await draw(cards(call("a", "AskUserQuestion", { questions: [q] }), call("p", "ExitPlanMode", { plan: "## План\n\n1. раз" })));
    expect(bodyOf(el, "AskUserQuestion")!.textContent).toBe("Базу?стенд · прод");
    expect(bodyOf(el, "ExitPlanMode")!.querySelector("h2")!.textContent).toBe("План");
    await act(async () => root?.unmount());
    const answered = await draw(cards(call("b", "AskUserQuestion", { questions: [q], answers: { "Базу?": "прод" } })));
    expect(bodyOf(answered, "AskUserQuestion")!.textContent).toBe("Базу?прод");
  });

  it("6707 · команда и страница: описание, «$» или «PS>», «ждём результата…», «без вывода», картинка без пустого текста, prompt", async () => {
    const el = await draw(
      cards(
        call("b", "Bash", { command: "ls", description: "Список" }),
        call("p", "PowerShell", { command: "dir" }),
        result("p", ""),
        call("w", "WebFetch", { url: "https://a", prompt: "Что там?" }),
        result("w", "текст страницы"),
        call("g", "Grep", { pattern: "x" }),
        result("g", PIC),
      ),
    );
    for (const t of ["Bash", "PowerShell", "WebFetch", "Grep"]) await open(el, t);
    expect(bodyOf(el, "Bash")!.querySelector(".tb-hint")!.textContent).toBe("Список");
    expect(bodyOf(el, "Bash")!.querySelector(".tb-pre")!.textContent).toBe("$ ls");
    expect(bodyOf(el, "Bash")!.querySelector(".tb-wait")!.textContent).toBe("ждём результата…");
    expect([...bodyOf(el, "PowerShell")!.querySelectorAll(".tb-pre")].map((x) => x.textContent)).toEqual(["PS> dir", "без вывода"]);
    expect(bodyOf(el, "WebFetch")!.querySelector(".tb-hint")!.textContent).toBe("Что там?");
    expect(bodyOf(el, "WebFetch")!.querySelector(".tb-pre")!.textContent).toBe("текст страницы");
    expect(bodyOf(el, "Grep")!.querySelector("pre")).toBeNull();
    expect(bodyOf(el, "Grep")!.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("6708 · что раскрыто сразу: правки, задачи, вопрос и план; субагент — пока нет итога; команда — по нажатию и остаётся раскрытой", async () => {
    const opened = await draw(cards(call("e", "Edit", {}), call("m", "MultiEdit", {}), call("t", "TodoWrite", {}), call("q", "AskUserQuestion", {}), call("p", "ExitPlanMode", {}), call("a", "Agent", {}), call("c", "Bash", { command: "x" })));
    for (const t of ["Edit", "MultiEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Agent"]) expect(bodyOf(opened, t), t).not.toBeNull();
    expect(bodyOf(opened, "Bash")).toBeNull();
    await act(async () => root?.unmount());

    const agent = await draw(cards(call("a", "Agent", {}), result("a", "итог")));
    expect(bodyOf(agent, "Agent")).toBeNull();
    await act(async () => root?.unmount());

    let feed = applyEvents(emptyFeed(), [call("c", "Bash", { command: "x" })]);
    const el = await draw(<Cards feed={feed} />);
    await open(el, "Bash");
    feed = applyEvents(feed, [result("c", "вывод")]);
    await act(async () => root!.render(<Cards feed={feed} />));
    expect(bodyOf(el, "Bash")!.textContent).toContain("вывод");
    await act(async () => (head(el, "Bash") as HTMLElement).click());
    expect(bodyOf(el, "Bash")).toBeNull();
  });

  it("6709 · «все вхождения»; ячейка блокнота и запись — все строки добавленными", async () => {
    const el = await draw(cards(call("e", "Edit", { old_string: "a", new_string: "b", replace_all: true }), call("n", "NotebookEdit", { cell_id: "c3", new_source: "print(1)" }), call("w", "Write", { content: "x\ny\n" })));
    expect(bodyOf(el, "Edit")!.querySelector(".tb-hint")!.textContent).toBe("все вхождения");
    await open(el, "NotebookEdit");
    await open(el, "Write");
    expect(bodyOf(el, "NotebookEdit")!.querySelector(".tb-hint")!.textContent).toBe("ячейка c3");
    expect(bodyOf(el, "NotebookEdit")!.querySelectorAll(".add")).toHaveLength(1);
    expect(bodyOf(el, "Write")!.querySelectorAll(".add")).toHaveLength(2);
  });

  it("6710 · правка не прошла: «ошибка» в шапке, дифф и текст ошибки", async () => {
    const el = await draw(cards(call("e", "Edit", { old_string: "a", new_string: "b" }), result("e", "не нашёл строку", true), call("m", "MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] }), result("m", "нет файла", true), call("w", "Write", { content: "x" }), result("w", "нет прав", true)));
    await open(el, "Write");
    for (const [t, why] of [["Edit", "не нашёл строку"], ["MultiEdit", "нет файла"], ["Write", "нет прав"]]) {
      expect(head(el, t).textContent, t).toContain("ошибка");
      expect(bodyOf(el, t)!.querySelector(".chat-diff"), t).not.toBeNull();
      expect(bodyOf(el, t)!.querySelector(".tb-pre.bad")!.textContent, t).toBe(why);
    }
  });

  it("6711 · ошибка инструмента со своим телом видна словами: блокнот, задачи, план, вопрос", async () => {
    const el = await draw(
      cards(
        call("n", "NotebookEdit", { new_source: "x" }),
        result("n", "ячейка не найдена", true),
        call("t", "TodoWrite", { todos: [] }),
        result("t", "список не принят", true),
        call("p", "ExitPlanMode", { plan: "п" }),
        result("p", "план не принят", true),
        call("q", "AskUserQuestion", { questions: [] }),
        result("q", "вопрос не задан", true),
      ),
    );
    await open(el, "NotebookEdit");
    for (const [t, why] of [["NotebookEdit", "ячейка не найдена"], ["TodoWrite", "список не принят"], ["ExitPlanMode", "план не принят"], ["AskUserQuestion", "вопрос не задан"]]) {
      expect(head(el, t).textContent, t).toContain("ошибка");
      expect(bodyOf(el, t)!.querySelector(".tb-pre.bad")?.textContent, t).toBe(why);
    }
  });

  it("6712 · чтение: ошибка красным без подсветки, картинка, пустой файл — «без вывода»", async () => {
    const el = await draw(cards(call("e", "Read", { file_path: "a.ts" }), result("e", "const нет", true)));
    await open(el, "Read");
    expect(bodyOf(el, "Read")!.querySelector(".tb-pre.bad")!.textContent).toBe("const нет");
    expect(bodyOf(el, "Read")!.querySelector("[class^=hljs-]")).toBeNull();
    await act(async () => root?.unmount());
    const pic = await draw(cards(call("p", "Read", { file_path: "a.png" }), result("p", PIC)));
    await open(pic, "Read");
    expect(bodyOf(pic, "Read")!.querySelector("img")).not.toBeNull();
    await act(async () => root?.unmount());
    const empty = await draw(cards(call("z", "Read", { file_path: "a.ts" }), result("z", "")));
    await open(empty, "Read");
    expect(bodyOf(empty, "Read")!.querySelector(".tb-pre")!.textContent).toBe("без вывода");
  });

  it("6713 · расширение не из списка: вывод текстом, экран живой, в том числе a.constructor и __proto__", async () => {
    for (const file_path of ["a.xyz", "Makefile", "a.constructor", "a.__proto__", "a.toString"]) {
      const el = await draw(cards(call("r", "Read", { file_path }), result("r", "const a")));
      await open(el, "Read");
      expect(bodyOf(el, "Read")!.querySelector(".tb-pre")!.textContent, file_path).toBe("const a");
      expect(bodyOf(el, "Read")!.querySelector("[class^=hljs-]"), file_path).toBeNull();
      await act(async () => root?.unmount());
    }
  });

  it("6714 · вывод и поля инструмента только текстом: виден как написан, элементов нет", async () => {
    const evil = "<img src=x onerror=a()><script>a()</script>";
    const el = await draw(
      cards(
        call("b", "Bash", { command: evil, description: evil }),
        result("b", evil),
        call("r", "Read", { file_path: "a.html" }),
        result("r", evil),
        call("e", "Edit", { file_path: evil, old_string: evil, new_string: "x" }),
        call("t", "TodoWrite", { todos: [{ content: evil, status: "pending" }] }),
        call("q", "AskUserQuestion", { questions: [{ question: evil, options: [{ label: evil }] }] }),
        call("a", "Agent", { prompt: evil }),
        call("m", "mcp__x__y", { q: evil }),
        result("m", evil),
        { type: "assistant", uuid: "z", error: evil, message: { id: "z", content: [] } },
      ),
    );
    for (const t of ["Bash", "Read", "mcp__x__y"]) await open(el, t);
    await act(async () => el.querySelector<HTMLElement>('[data-tool="Agent"] .dis-h')!.click());
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent!.split("<script>a()</script>").length).toBeGreaterThan(8);
  });
});

describe("фон и задачи", () => {
  it("6705 · в фоне: метка у команды с run_in_background и у итога «Command running in background» без задачи", async () => {
    const el = await draw(cards(call("a", "Bash", { command: "x", run_in_background: true }), result("a", "ок"), call("b", "PowerShell", { command: "y" }), result("b", "Command running in background")));
    expect(head(el, "Bash").querySelector(".tc-chip")!.textContent).toBe("в фоне");
    expect(head(el, "PowerShell").querySelector(".tc-chip")!.textContent).toBe("в фоне");
  });

  it("6715 · субагент в фоне: «запущен» итогом не показан; после конца итог — summary задачи разметкой", async () => {
    const started: WireMessage[] = [
      call("a", "Agent", { prompt: "p" }),
      { type: "system", subtype: "task_started", uuid: "k1", task_id: "k", tool_use_id: "a", task_type: "local_agent", description: "д", is_backgrounded: true },
      result("a", "Async agent launched"),
    ];
    let feed = applyEvents(emptyFeed(), started);
    const el = await draw(<Cards feed={feed} />);
    await open(el, "Agent");
    expect(bodyOf(el, "Agent")!.querySelector(".tb-final")).toBeNull();
    feed = applyEvents(feed, [{ type: "system", subtype: "task_notification", uuid: "k2", task_id: "k", status: "completed", summary: "**итог** задачи" }]);
    await act(async () => root!.render(<Cards feed={feed} />));
    expect(bodyOf(el, "Agent")!.querySelector(".tb-final strong")!.textContent).toBe("итог");
    expect(el.textContent).not.toContain("Async agent launched");
  });

  it("6716 · состояние от задачи: «в фоне» без второй метки и без «В фон»; stopped и killed — «остановлено»", async () => {
    const task = (id: string, extra: Partial<WireMessage>): WireMessage => ({ type: "system", subtype: "task_started", uuid: `k-${id}`, task_id: `k${id}`, tool_use_id: id, description: "д", ...extra });
    const bg = await draw(<Cards feed={applyEvents(emptyFeed(), [call("a", "Bash", { command: "x" }), task("a", { is_backgrounded: true })])} more={{ background: () => {} }} />);
    const h = head(bg, "Bash");
    expect(h.querySelector(".tc-st")!.textContent).toBe("в фоне");
    expect(h.querySelector(".tc-chip")).toBeNull();
    expect([...bg.querySelectorAll("button")].some((b) => b.textContent === "В фон")).toBe(false);
    await act(async () => root?.unmount());
    for (const status of ["stopped", "killed"]) {
      const feed = applyEvents(emptyFeed(), [call("b", "Bash", { command: "x" }), task("b", {}), { type: "system", subtype: "task_updated", uuid: `u-${status}`, task_id: "kb", patch: { status } }]);
      const el = await draw(<Cards feed={feed} />);
      expect(head(el, "Bash").querySelector(".tc-st")!.textContent, status).toBe("остановлено");
      await act(async () => root?.unmount());
    }
  });
});
