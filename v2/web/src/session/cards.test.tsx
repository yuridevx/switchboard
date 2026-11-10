// Оформление карточек ленты: правки, ошибки, автораскрытие, значки, тон строк, входящие, размышление, подсказки ввода.
import { fold } from "../chat/fold.ts";
import { clampSplit } from "../lib/Split.tsx";
import { askedOf } from "../chat/answers.ts";
import { runningOf, runTime, startedOf } from "./Dock.tsx";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Row, Task, Tool, View } from "../chat/fold.ts";
import { editsOf } from "./diff.ts";
import { FeedEnvProvider, Md, Rows, toolSecs } from "./Feed.tsx";
import { safeHref } from "./Markdown.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
afterEach(cleanup);

const tool = (t: Partial<Tool>): Tool => ({ id: "t1", steps: [], ...t });
const view = (tools: Tool[], tasks: Task[] = []): View => ({
  rows: [], tools: Object.fromEntries(tools.map((t) => [t.id, t])), tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), hint: "", compacting: false, thinking: null, cost: 0,
  interrupted: false, status: {}, stream: {}, replies: new Map(), sub: 0, n: 0,
});
/** Лента из одного ответа с вызовами инструментов. */
function feed(tools: Tool[], o: { tasks?: Task[]; waiting?: string } = {}) {
  const rows: Row[] = [{ k: "reply", key: "r", parts: tools.map((t) => ({ k: "tool" as const, id: t.id })) }];
  return render(<MantineProvider><FeedEnvProvider value={{ canAct: true, waiting: o.waiting }}><Rows rows={rows} view={view(tools, o.tasks)} /></FeedEnvProvider></MantineProvider>);
}
const rows = (list: Row[]) => render(<MantineProvider><Rows rows={list} view={view([])} /></MantineProvider>);
const line = () => screen.getAllByRole("button", { expanded: true })[0] ?? screen.getAllByRole("button")[0]!;

describe("правки", () => {
  it("ввод инструмента разбирается в правки: Edit — одна, MultiEdit — список, NotebookEdit и Write — новый текст", () => {
    expect(editsOf({ old_string: "a", new_string: "b" })).toEqual([{ before: "a", after: "b" }]);
    expect(editsOf({ edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })).toHaveLength(2);
    expect(editsOf({ new_source: "print(1)", cell_id: "c3" })).toEqual([{ before: null, after: "print(1)" }]);
    expect(editsOf({ content: "x" })).toEqual([{ before: null, after: "x" }]);
    expect(editsOf({})).toEqual([]);
  });
  it("MultiEdit раскрыт сам и показывает каждую правку; replace_all — подсказкой «все вхождения»", () => {
    feed([tool({ name: "MultiEdit", input: { file_path: "a.ts", replace_all: true, edits: [{ old_string: "один", new_string: "раз" }, { old_string: "два", new_string: "пара" }] }, result: { text: "ok", pics: [], error: false } })]);
    expect(document.querySelectorAll("pre.diff")).toHaveLength(2);
    expect(screen.getByText(/раз/)).toBeTruthy();
    expect(screen.getByText(/пара/)).toBeTruthy();
    expect(screen.getByText("все вхождения")).toBeTruthy();
  });
  it("NotebookEdit показывает новый текст ячейки и её номер", () => {
    feed([tool({ name: "NotebookEdit", input: { notebook_path: "n.ipynb", cell_id: "c3", new_source: "print(42)" } })]);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getByText("print(42)")).toBeTruthy();
    expect(screen.getByText("ячейка c3")).toBeTruthy();
  });
  it("ошибка правки видна текстом, а не одним словом; у списка дел — тоже", () => {
    feed([
      tool({ id: "e", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" }, result: { text: "String to replace not found in file", pics: [], error: true } }),
      tool({ id: "w", name: "TodoWrite", input: { todos: [{ content: "дело", status: "pending" }] }, result: { text: "InputValidationError: todos", pics: [], error: true } }),
    ]);
    expect(screen.getByText("String to replace not found in file").className).toBe("tool-err");
    expect(screen.getByText("InputValidationError: todos")).toBeTruthy();
  });
});

describe("раскрытие", () => {
  it("правка и список дел раскрыты сами, команда — нет; нажатие сворачивает раскрытое", () => {
    feed([
      tool({ id: "e", name: "Edit", input: { file_path: "a.ts", old_string: "было", new_string: "стало" }, result: { text: "ok", pics: [], error: false } }),
      tool({ id: "b", name: "Bash", input: { command: "ls -la" }, result: { text: "итого 0", pics: [], error: false } }),
    ]);
    expect(screen.getByText(/стало/)).toBeTruthy();
    expect(screen.queryByText("итого 0")).toBeNull();
    fireEvent.click(line());
    expect(screen.queryByText(/стало/)).toBeNull();
  });
  it("субагент в ленте свёрнут и пока идёт, и с итогом — его шаги в блоке «Идут сейчас»; у идущего — чип типа и «сейчас: …»", () => {
    const task: Task = { id: "k", desc: "поиск", bg: false, started: Date.now(), last: "Grep", steps: 2 };
    const { unmount } = feed([tool({ name: "Agent", task: "k", input: { subagent_type: "Explore", prompt: "найди вход" } })], { tasks: [task] });
    expect(screen.queryByText("найди вход")).toBeNull();
    expect(screen.getByText("Explore").className).toBe("toolchip");
    expect(screen.getByText("сейчас: Grep")).toBeTruthy();
    unmount();
    feed([tool({ name: "Agent", input: { subagent_type: "Explore", prompt: "найди вход" }, result: { text: "нашёл", pics: [], error: false } })]);
    expect(screen.queryByText("найди вход")).toBeNull();
  });
  it("план ждёт одобрения и свёрнут, пока его показывает карточка вопроса; команда ждёт разрешения", () => {
    feed([tool({ id: "p", name: "ExitPlanMode", input: { plan: "шаг первый" } }), tool({ id: "b", name: "Bash", input: { command: "rm x" } })], { waiting: "p" });
    expect(screen.getByText("ждёт одобрения")).toBeTruthy();
    expect(screen.queryByText("шаг первый")).toBeNull();
    cleanup();
    feed([tool({ id: "b", name: "Bash", input: { command: "rm x" } })], { waiting: "b" });
    expect(screen.getByText("ждёт разрешения")).toBeTruthy();
  });
});

describe("подсказки ввода", () => {
  it("Bash — описание и «$», PowerShell — «PS>»; у поиска в сети — его запрос", () => {
    feed([
      tool({ id: "b", name: "Bash", input: { command: "ls", description: "Список файлов" } }),
      tool({ id: "p", name: "PowerShell", input: { command: "dir" } }),
      tool({ id: "f", name: "WebFetch", input: { url: "https://example.com", prompt: "что на странице" } }),
    ]);
    for (const b of screen.getAllByRole("button", { expanded: false })) fireEvent.click(b);
    expect(screen.getByText("Список файлов").className).toBe("toolhint");
    expect(screen.getByText("$ ls")).toBeTruthy();
    expect(screen.getByText("PS> dir")).toBeTruthy();
    expect(screen.getByText("что на странице").className).toBe("toolhint");
  });
});

describe("значки и тон", () => {
  it("у инструментов и строк свои значки, а не общий ключ; тон строки и баннера — классом", () => {
    rows([
      { k: "line", key: "1", icon: "anchor", tone: "wait", text: "Хук не сработал" },
      { k: "line", key: "2", icon: "zap", text: "локальная команда" },
      { k: "sys", key: "3", icon: "square", tone: "wait", text: "прервано" },
      { k: "ban", key: "4", tone: "bad", icon: "shield-off", title: "Модель отказалась отвечать" },
      { k: "ban", key: "5", tone: "wait", title: "Ждёт лимита" },
    ]);
    const icons = [...document.querySelectorAll("[data-icon]")].map((e) => e.getAttribute("data-icon"));
    expect(icons).toEqual(["anchor", "zap", "square", "shield-off", "info"]);
    expect(screen.getByText("Хук не сработал").closest(".sysline")!.className).toContain("tone-wait");
    expect(screen.getByText("прервано").closest(".sysline")!.className).toContain("tone-wait");
    expect(screen.getByRole("alert").className).toBe("ban bad");
    expect(screen.getByText("Ждёт лимита").closest(".ban")!.className).toBe("ban wait");
  });
});

describe("входящие и размышление", () => {
  it("сообщение сессии — разметкой, со значком и режимом словами; длинное сворачивается обратно", async () => {
    rows([{ k: "in", key: "1", via: "session", from: "pen@wsl", tag: "bypassPermissions", text: "**готово** " + "я".repeat(1000), at: "12:00" }]);
    expect((await screen.findByText("готово")).tagName).toBe("STRONG");
    expect(document.querySelector('[data-icon="messages-square"]')).toBeTruthy();
    expect(screen.getByText(/разрешено всё/)).toBeTruthy();
    expect(document.querySelector(".peer-clamp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "показать всё" }));
    expect(document.querySelector(".peer-clamp")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "свернуть" }));
    expect(document.querySelector(".peer-clamp")).toBeTruthy();
  });
  it("размышление раскрывается разметкой; пустое — строкой «Размышлял»; сводка сжатия — разметкой", async () => {
    rows([
      { k: "reply", key: "1", parts: [{ k: "think", text: "Сначала проверю\n\n- пункт плана" }, { k: "think", text: "" }] },
      { k: "sum", key: "2", stats: "сжато 120k → 20k", text: "## Итог сжатия" },
    ]);
    expect(screen.getByText("Размышлял")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Сначала проверю/ }));
    expect((await screen.findByText("пункт плана")).tagName).toBe("LI");
    fireEvent.click(screen.getByRole("button", { name: /сжато/ }));
    expect((await screen.findByText("Итог сжатия")).tagName).toBe("H2");
  });
});

describe("разметка", () => {
  it("сырой HTML проходит очистку: разрешённое остаётся, скрипт и обработчик — нет; сноска ведёт внутрь текста", async () => {
    render(<MantineProvider><Md text={'<mark>важно</mark> <img src="x.png" onerror="alert(1)"><script>alert(2)</script>\n\nТекст[^1].\n\n[^1]: Пояснение сноски'} /></MantineProvider>);
    expect((await screen.findByText("важно")).tagName).toBe("MARK");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")!.hasAttribute("onerror")).toBe(false);
    expect(screen.getByText("Пояснение сноски")).toBeTruthy();
    expect(document.querySelector("a[data-footnote-ref]")!.getAttribute("href")).toBe("#user-content-fn-1");
    expect(document.querySelector('[id="user-content-fn-1"]')).toBeTruthy();
  });
  it("ссылка из текста не принимает приглашение и не открывает экран этой страницы; чужой адрес остаётся", () => {
    expect(safeHref("https://x.test/#invite=abc")).toBeUndefined();
    expect(safeHref(location.origin + "/#/settings/passes")).toBeUndefined();
    expect(safeHref("https://x.test/doc#part")).toBe("https://x.test/doc#part");
    expect(safeHref("https://x.test/doc")).toBe("https://x.test/doc");
  });

describe("«Идут сейчас»: время и вид", () => {
  const T0 = Date.parse("2026-11-10T12:00:00Z"), MIN = 60_000;
  const agent = (id: string, extra: object) => ({ type: "assistant", uuid: "a-" + id, ...extra, message: { id: "m-" + id, role: "assistant", content: [{ type: "tool_use", id, name: "Task", input: { description: "Права службы оплаты", subagent_type: "Explore", prompt: "проверь" } }] } });
  it("время строки — от начала работы на машине, а не от открытия страницы: началось 5 минут назад — «5 мин», и столько же после перечитывания ленты", () => {
    const events = [agent("ag1", { timestamp: new Date(T0 - 5 * MIN).toISOString() }), { type: "system", subtype: "task_started", uuid: "s1", task_id: "t1", tool_use_id: "ag1", description: "Права службы оплаты", task_type: "local_agent", timestamp: new Date(T0 - 5 * MIN).toISOString() }];
    const first = runningOf(fold(events as never));
    expect(first).toHaveLength(1);
    expect(startedOf(first[0]!)).toBe(T0 - 5 * MIN);
    expect(runTime(first[0]!, T0)).toBe(runTime({ id: "x", task: { id: "x", desc: "", bg: false, started: T0 - 5 * MIN } }, T0));
    expect(runTime(first[0]!, T0)).toMatch(/^5 мин/);
    // та же лента, свёрнутая позже (страницу открыли заново): начало то же
    expect(startedOf(runningOf(fold(events as never))[0]!)).toBe(T0 - 5 * MIN);
  });
  it("живое событие без timestamp берёт время машины из at; субагент без события задачи — время своего вызова; времени нет нигде — строка без времени, а не «0 с»", () => {
    const live = runningOf(fold([agent("ag2", { at: T0 - 3 * MIN }), { type: "system", subtype: "task_started", uuid: "s2", task_id: "t2", tool_use_id: "ag2", description: "x", task_type: "local_agent", at: T0 - 2 * MIN }] as never));
    expect(startedOf(live[0]!)).toBe(T0 - 2 * MIN);
    const bare = runningOf(fold([agent("ag3", { at: T0 - 4 * MIN })] as never));
    expect(startedOf(bare[0]!)).toBe(T0 - 4 * MIN);
    const blind = runningOf(fold([agent("ag4", {})] as never));
    expect(startedOf(blind[0]!)).toBeUndefined();
    expect(runTime(blind[0]!, T0)).toBe("");
  });
  it("идущий инструмент в ленте считает время от своего вызова на машине; времени вызова нет — берёт то, что сказал SDK", () => {
    expect(toolSecs({ at: T0 - 5 * MIN }, T0)).toBe(300);
    expect(toolSecs({ secs: 7 }, T0)).toBe(7);
    expect(toolSecs({}, T0)).toBe(0);
  });
  it("граница панели держит пределы: панель не уже своей наименьшей, второй части остаётся её наименьшая", () => {
    expect(clampSplit(100, 1200, 280, 420)).toBe(280);
    expect(clampSplit(400, 1200, 280, 420)).toBe(400);
    expect(clampSplit(5000, 1200, 280, 420)).toBe(780);
    expect(clampSplit(400, 500, 280, 420)).toBe(280);
  });
  it("отвеченный вопрос: выбранный вариант выделен, свой ответ встаёт вариантом, разрешение — словами кнопок", () => {
    const q = { id: "q", kind: "question", text: "Ветка?", options: [{ label: "main" }, { label: "dev" }], at: 0 } as never;
    expect(askedOf(q, { answers: { "Ветка?": "dev" } })).toEqual([{ question: "Ветка?", options: ["main", "dev"], chosen: ["dev"] }]);
    expect(askedOf(q, { answers: { "Ветка?": "release-2" } })).toEqual([{ question: "Ветка?", options: ["main", "dev", "release-2"], chosen: ["release-2"] }]);
    const p = { id: "p", kind: "permission", text: "rm -rf dist", at: 0 } as never;
    expect(askedOf(p, { action: "allow_always" })[0]).toMatchObject({ chosen: ["Разрешать всегда"], options: ["Разрешить", "Разрешать всегда", "Отклонить"] });
    expect(askedOf(p, { action: "deny", message: "не трогай" })[0]!.chosen).toEqual(["Отклонить: не трогай"]);
  });
});
});
