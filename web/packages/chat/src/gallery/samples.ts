// Образцы галереи: сообщения SDK той же формы, что приходят в session.events. Рисуются тем же кодом, что живая лента.
import type { WireBlock, WireMessage } from "../state/wire.ts";

export type Sample = { title: string; msgs: WireMessage[] };
export type Section = { title: string; samples: Sample[] };

let n = 0;
const id = () => `g${++n}`;
const asst = (content: WireBlock[], parent: string | null = null): WireMessage => ({ type: "assistant", uuid: id(), parent_tool_use_id: parent, message: { id: id(), model: "claude-opus-5-5", content } });
const text = (t: string) => asst([{ type: "text", text: t }]);
const tool = (tid: string, name: string, input: WireBlock["input"], parent: string | null = null) => asst([{ type: "tool_use", id: tid, name, input }], parent);
const res = (tid: string, content: unknown, is_error = false): WireMessage => ({ type: "user", uuid: id(), message: { content: [{ type: "tool_result", tool_use_id: tid, content, is_error }] } });
const user = (content: string | WireBlock[], x: Partial<WireMessage> = {}): WireMessage => ({ type: "user", uuid: id(), message: { content }, ...x });
const sys = (subtype: string, x: Partial<WireMessage> = {}): WireMessage => ({ type: "system", subtype, uuid: id(), ...x });
const live = (msg: string, kind: "text" | "think", piece: string): WireMessage[] => [
  { type: "stream_event", event: { type: "message_start", message: { id: msg } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: kind === "text" ? { type: "text_delta", text: piece } : { type: "thinking_delta", thinking: piece } } },
];
/** Картинка 2×2 точки в base64: поток и история приносят картинки так. */
const PIC = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

const MD = `## Причина падения

Сборка падала на **таймауте теста**: \`vitest\` ждал *5 секунд*, а эталон 4187 идёт дольше. Смотри [журнал CI](https://example.com/ci).

1. Поднял таймаут до 15 с
2. Разделил файл тестов

- [x] Сборка зелёная
- [ ] Выложить на тестовый флот

> Прод не трогал: номер занят параллельной выкладкой.

| Часть | Было | Стало |
|---|---:|---:|
| web-chat | 41 с | 12 с |
| web-board | 18 с | 18 с |

\`\`\`ts
export function retry(ms: number): Promise<void> {
  // одна попытка: дальше решает агент
  return new Promise((resolve) => setTimeout(resolve, ms));
}
\`\`\`

\`\`\`bash
npm test -- --reporter=dot && git status --short
\`\`\`
`;

const HTML_MD = `Встроенный HTML проходит через санитайзер: <kbd>Ctrl</kbd>+<kbd>K</kbd>, <mark>отметка</mark>, H<sub>2</sub>O, x<sup>2</sup>.

<details><summary>Подробности</summary>

Сворачиваемый блок с **разметкой** внутри.

</details>

<script>alert("скрипт вырезан")</script><img src="x" onerror="alert(1)" alt="обработчик вырезан">
<a href="javascript:alert(1)">опасная ссылка без адреса</a>

\`\`\`html
<!doctype html><html><body style="font:16px system-ui;background:#fbfcfa;color:#17201b">
<h2>Отчёт</h2><p id="c">Нажатий: 0</p><button onclick="c.textContent='Нажатий: '+(++window.n||(window.n=1))">Нажать</button>
</body></html>
\`\`\`

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" rx="12" fill="#2B5CCB"/><text x="100" y="48" fill="#fff" text-anchor="middle" font-family="sans-serif">SVG</text></svg>
\`\`\`
`;

const DOC = `<!doctype html>
<html><head><style>body{font:15px system-ui;margin:16px;color:#17201b;background:#fbfcfa}table{border-collapse:collapse}td{border:1px solid #d3d9d2;padding:4px 8px}</style></head>
<body><h1>Отчёт о сборке</h1><table><tr><td>web-chat</td><td>12 с</td></tr><tr><td>web-board</td><td>18 с</td></tr></table></body></html>`;

const LONG = "Станция собрана, эталоны зелёные. ".repeat(40);
const OLD = "function crit(base, mult) {\n  return base * mult;\n}\n";
const NEW = "function crit(base, mult) {\n  // множитель крита — проценты сверх базы\n  return base * (1 + mult / 100);\n}\n";
const TODOS = [
  { content: "Найти, где считается урон", activeForm: "Ищу, где считается урон", status: "completed" },
  { content: "Поправить формулу крита", activeForm: "Правлю формулу крита", status: "in_progress" },
  { content: "Прогнать тесты", activeForm: "Гоняю тесты", status: "pending" },
];

export const SECTIONS: Section[] = [
  {
    title: "Сообщения",
    samples: [
      { title: "Ваше сообщение", msgs: [user("Почини сборку на CI — падает с утра")] },
      { title: "С картинками", msgs: [user([{ type: "image", source: { type: "base64", media_type: "image/png", data: PIC } }, { type: "text", text: "Вот снимок экрана" }])] },
      { title: "Другая сессия флота", msgs: [user('<fleet-message from="poe-bot@pc">\nСтанция собрана. Прогони эталоны?\n</fleet-message>')] },
      { title: "Другая сессия, длинное", msgs: [user(LONG, { origin: { kind: "peer", name: "tests@wsl", fromMode: "bypassPermissions" } })] },
      { title: "Субагент", msgs: [user("<agent-message from-name=\"Explore\">\nНашёл три места с таймаутом.\n</agent-message>")] },
      { title: "Прервано", msgs: [user("[Request interrupted by user]")] },
    ],
  },
  {
    title: "Ответ Claude",
    samples: [
      { title: "Разметка", msgs: [text(MD)] },
      { title: "Встроенный HTML и блоки просмотра", msgs: [text(HTML_MD)] },
      { title: "HTML-документ целиком", msgs: [text(DOC)] },
      { title: "Пишется", msgs: live("g-live", "text", "Смотрю лог CI и **сравниваю** с прошлым прогоном") },
      { title: "Размышляет", msgs: live("g-think", "think", "Таймаут в 5 с похож на причину, но эталон 4187 мог упасть и раньше — проверю по журналу") },
      { title: "Размышлял", msgs: [asst([{ type: "thinking", thinking: "Таймаут — причина. Править **конфиг**, а не тест." }, { type: "text", text: "Правлю конфиг." }])] },
    ],
  },
  {
    title: "Инструменты",
    samples: [
      { title: "Команда идёт", msgs: [tool("t-run", "Bash", { command: "npm test", description: "Прогон тестов" }), { type: "tool_progress", tool_use_id: "t-run", elapsed_time_seconds: 18 }] },
      { title: "Команда готова", msgs: [tool("t-ok", "Bash", { command: "git status --short" }), res("t-ok", " M web/packages/chat/src/module.tsx\n?? web/packages/chat/src/state/")] },
      { title: "Команда с ошибкой", msgs: [tool("t-err", "Bash", { command: "npm run gate" }), res("t-err", "web-chat: нет объявленной зависимости host-manage", true)] },
      { title: "Отклонено человеком", msgs: [tool("t-no", "Bash", { command: "rm -rf dist" }), res("t-no", "The user doesn't want to proceed with this tool use.", true)] },
      { title: "PowerShell", msgs: [tool("t-ps", "PowerShell", { command: "Get-Service sb-keeper" }), res("t-ps", "Running  sb-keeper  Switchboard keeper")] },
      { title: "Правка", msgs: [tool("t-ed", "Edit", { file_path: "src/combat/damage.ts", old_string: OLD, new_string: NEW }), res("t-ed", "ok")] },
      { title: "Несколько правок", msgs: [tool("t-me", "MultiEdit", { file_path: "vitest.config.ts", edits: [{ old_string: "testTimeout: 5000", new_string: "testTimeout: 15000" }, { old_string: "retry: 2", new_string: "retry: 0" }] }), res("t-me", "ok")] },
      { title: "Запись файла", msgs: [tool("t-wr", "Write", { file_path: "docs/notes.md", content: "# Заметки\n\nТаймаут поднят.\n" }), res("t-wr", "ok")] },
      { title: "Запись HTML", msgs: [tool("t-wh", "Write", { file_path: "docs/report.html", content: DOC }), res("t-wh", "ok")] },
      { title: "Ячейка блокнота", msgs: [tool("t-nb", "NotebookEdit", { notebook_path: "analysis.ipynb", cell_id: "c3", new_source: "print(df.head())" }), res("t-nb", "ok")] },
      { title: "Чтение", msgs: [tool("t-rd", "Read", { file_path: "src/combat/damage.ts", offset: 10, limit: 40 }), res("t-rd", "export const crit = (base: number) => base * 2;\n")] },
      { title: "Чтение картинки", msgs: [tool("t-ri", "Read", { file_path: "shots/board.png" }), res("t-ri", [{ type: "image", source: { type: "base64", media_type: "image/png", data: PIC } }])] },
      { title: "Поиск", msgs: [tool("t-gr", "Grep", { pattern: "testTimeout", path: "web", glob: "*.ts" }), res("t-gr", "web/pult/vitest.config.ts:5: testTimeout: 20000")] },
      { title: "Файлы по маске", msgs: [tool("t-gl", "Glob", { pattern: "**/*.test.ts" }), res("t-gl", "web/packages/chat/test/feed.test.ts")] },
      { title: "Страница", msgs: [tool("t-wf", "WebFetch", { url: "https://code.claude.com/docs", prompt: "Что умеет Agent SDK?" }), res("t-wf", "Сессии, инструменты, подписка на поток.")] },
      { title: "Поиск в сети", msgs: [tool("t-ws", "WebSearch", { query: "react 19 useSyncExternalStore" }), res("t-ws", "react.dev — useSyncExternalStore")] },
      { title: "Задачи", msgs: [tool("t-td", "TodoWrite", { todos: TODOS }), res("t-td", "ok")] },
      { title: "Скил", msgs: [tool("t-sk", "Skill", { skill: "deliver" }), res("t-sk", "Launching skill: deliver")] },
      { title: "Инструмент MCP", msgs: [tool("t-mc", "mcp__github__create_issue", { title: "Таймаут на CI", body: "Падает эталон 4187" }), res("t-mc", '{"number": 42}')] },
      { title: "Вопрос в ленте", msgs: [tool("t-as", "AskUserQuestion", { questions: [{ question: "Какую базу мигрировать первой?", header: "База", options: [{ label: "стенд" }, { label: "прод" }] }] }), res("t-as", "стенд")] },
      { title: "План", msgs: [tool("t-pl", "ExitPlanMode", { plan: "## План\n\n1. Найти формулу\n2. Перевести в проценты\n3. Прогнать `npm test`" }), res("t-pl", "ok")] },
      { title: "Сводка шагов", msgs: [tool("t-su", "Read", { file_path: "src/a.ts" }), res("t-su", "a"), { type: "tool_use_summary", uuid: id(), summary: "Прочитал конфиг: таймаут 5 с", preceding_tool_use_ids: ["t-su"] }] },
      {
        title: "Субагент с шагами",
        msgs: [
          tool("t-ag", "Agent", { description: "Ищет тесты CI", prompt: "Найди все тесты с таймаутом", subagent_type: "Explore" }),
          tool("t-ag1", "Grep", { pattern: "timeout" }, "t-ag"),
          { type: "user", uuid: id(), parent_tool_use_id: "t-ag", message: { content: [{ type: "tool_result", tool_use_id: "t-ag1", content: "3 совпадения" }] } },
          res("t-ag", "Нашёл **три** теста с таймаутом."),
        ],
      },
      {
        title: "Субагент идёт",
        msgs: [tool("t-ar", "Agent", { description: "Правит тесты", prompt: "Подними таймауты", subagent_type: "general-purpose" }), { type: "system", subtype: "task_started", uuid: id(), task_id: "k-ar", tool_use_id: "t-ar", task_type: "local_agent", description: "Правит тесты" }, { type: "system", subtype: "task_progress", uuid: id(), task_id: "k-ar", summary: "читает test/", usage: { tool_uses: 3 } }],
      },
      {
        title: "Команда в фоне",
        msgs: [tool("t-bg", "Bash", { command: "npm run dev", run_in_background: true }), { type: "system", subtype: "task_started", uuid: id(), task_id: "k-bg", tool_use_id: "t-bg", task_type: "local_bash", description: "npm run dev", is_backgrounded: true }, res("t-bg", "Command running in background")],
      },
      { title: "Задача без вызова", msgs: [sys("task_started", { task_id: "k-free", task_type: "local_agent", description: "Explore · ищет тесты CI" }), sys("task_progress", { task_id: "k-free", summary: "читает test/", usage: { tool_uses: 2 } })] },
      { title: "Фоновая кончилась", msgs: [sys("task_started", { task_id: "k-end", tool_use_id: "x-end", task_type: "local_bash", description: "npm run build", is_backgrounded: true }), sys("task_notification", { task_id: "k-end", status: "completed" })] },
    ],
  },
  {
    title: "Служебные строки",
    samples: [
      { title: "Итог хода", msgs: [{ type: "result", uuid: id(), subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41, usage: { input_tokens: 1200, cache_read_input_tokens: 45000 } }] },
      { title: "Ход с ошибкой", msgs: [{ type: "result", uuid: id(), subtype: "error_during_execution", is_error: true, result: "Процесс claude завершился с кодом 1" }] },
      { title: "Сжатие", msgs: [sys("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 182_000, post_tokens: 41_000 } })] },
      { title: "Сжатие со сводкой", msgs: [sys("compact_boundary", { compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } }), user("This session is being continued from a previous conversation.\nSummary:\n## Что сделано\n\n- Таймаут поднят\n- Тесты зелёные", { isCompactSummary: true })] },
      { title: "Повтор API", msgs: [sys("api_retry", { attempt: 2, max_retries: 10, error_status: 529, retry_delay_ms: 4000 })] },
      { title: "Лимит подходит", msgs: [{ type: "rate_limit_event", uuid: id(), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000 } }] },
      { title: "Лимит исчерпан", msgs: [{ type: "rate_limit_event", uuid: id(), rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }] },
      { title: "Команда и вывод", msgs: [user("<command-name>/context</command-name><command-args>--full</command-args>"), user("<local-command-stdout>84.2k / 200k токенов (42%)</local-command-stdout>")] },
      { title: "Вывод без команды", msgs: [sys("local_command_output", { content: "Set model to sonnet" })] },
      { title: "Ошибка ответа", msgs: [{ type: "assistant", uuid: id(), error: "overloaded", message: { id: id(), content: [] } }] },
      { title: "Смена модели", msgs: [text("Ответ."), sys("init", { model: "claude-sonnet-5-5" })] },
      { title: "Запасная модель", msgs: [sys("model_fallback", { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", trigger: "overloaded" })] },
      { title: "Отказ, переписано", msgs: [sys("model_refusal_fallback", { original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5", api_refusal_category: "cyber", api_refusal_explanation: "Запрос похож на создание вредоносного кода." })] },
      { title: "Отказ, ход кончился", msgs: [sys("model_refusal_no_fallback", { original_model: "claude-opus-5-5", api_refusal_category: "bio" })] },
      { title: "Отказано правилами", msgs: [sys("permission_denied", { tool_name: "Bash", message: "rm -rf запрещён правилами" })] },
      { title: "Хук упал", msgs: [sys("hook_response", { hook_event: "PostToolUse", hook_name: "fmt", exit_code: 2, stderr: "cargo fmt: не найден" })] },
      { title: "Из памяти", msgs: [sys("memory_recall", { memories: [{ path: "memory/backlog.md" }, { path: "memory/keeper-freeze.md" }] })] },
      { title: "Сообщение claude", msgs: [sys("informational", { content: "Контекст заполнен на 80%", level: "info" })] },
      { title: "Предупреждение claude", msgs: [sys("notification", { text: "Вход истекает через час", priority: "high" })] },
      { title: "Файлы сохранены", msgs: [sys("files_persisted", { files: [{ filename: "report.pdf" }], failed: [] })] },
      { title: "Разговор заново", msgs: [{ type: "conversation_reset", uuid: id() }] },
    ],
  },
];
