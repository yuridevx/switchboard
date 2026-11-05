// Галерея карточек для снимков: образцы сообщений SDK идут той же свёрткой и теми же строками, что и лента. Кнопки молчат.
import { useMemo } from "react";
import { fold, type Msg } from "../../src/fold.ts";
import type { Env } from "../../src/store.ts";
import { EnvCtx, Rows } from "../../src/view/Rows.tsx";

const asst = (uuid: string, content: unknown[], x: Msg = {}) => ({ type: "assistant", uuid, message: { id: uuid, model: "claude-opus-5-5", content }, ...x });
const tool = (uuid: string, name: string, input: Msg) => asst(uuid, [{ type: "tool_use", id: `t-${uuid}`, name, input }]);
const res = (uuid: string, content: unknown, isError = false) => ({ type: "user", uuid: `r-${uuid}`, message: { content: [{ type: "tool_result", tool_use_id: `t-${uuid}`, content, is_error: isError }] } });
const sys = (uuid: string, subtype: string, x: Msg = {}) => ({ type: "system", subtype, uuid, ...x });
const HTML = "<!doctype html><html><body><h1>Отчёт</h1><p>Сборка зелёная.</p></body></html>";

type Sample = { title: string; msgs: Msg[] };

const FENCE = "```";
/** Опасный HTML в сообщении: эталон 6795 проверяет его в настоящем браузере. */
const HTML_MD = [
  "Встроенный HTML проходит через санитайзер: <kbd>Ctrl</kbd>+<kbd>K</kbd>, <mark>отметка</mark>.",
  "",
  '<script>alert("скрипт вырезан")</script><img src="x" onerror="alert(1)" alt="обработчик вырезан">',
  '<a href="javascript:alert(1)">опасная ссылка без адреса</a>',
  "",
  `${FENCE}html`,
  '<!doctype html><html><body style="font:16px system-ui">',
  `<h2>Отчёт</h2><p id="c">Нажатий: 0</p><button onclick="c.textContent='Нажатий: '+(++window.n||(window.n=1))">Нажать</button>`,
  "</body></html>",
  FENCE,
].join("\n");

const SECTIONS: Array<[string, Sample[]]> = [
  [
    "Сообщения",
    [
      { title: "Встроенный HTML и блоки просмотра", msgs: [asst("m6", [{ type: "text", text: HTML_MD }])] },
      { title: "Человек", msgs: [{ type: "user", uuid: "m1", message: { content: "Почини сборку на CI" } }] },
      { title: "Другая сессия", msgs: [{ type: "user", uuid: "m2", message: { content: '<fleet-message from="poe-bot@pc">\nСобрано, катить?\n</fleet-message>' } }] },
      { title: "Субагент", msgs: [{ type: "user", uuid: "m3", message: { content: '<agent-message from-name="Explore">\nНашёл три места\n</agent-message>' } }] },
      { title: "Команда", msgs: [{ type: "user", uuid: "m4", message: { content: "<command-name>/context</command-name>" } }, { type: "user", uuid: "m5", message: { content: "<local-command-stdout>42%</local-command-stdout>" } }] },
    ],
  ],
  [
    "Ответ",
    [
      { title: "Разметка", msgs: [asst("a1", [{ type: "text", text: "## Итог\n\n- [x] готово\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```" }])] },
      { title: "Размышление", msgs: [asst("a2", [{ type: "thinking", thinking: "Сначала **лог**." }, { type: "text", text: "Смотрю лог." }])] },
      { title: "Документ", msgs: [asst("a3", [{ type: "text", text: HTML }])] },
      { title: "Блок html", msgs: [asst("a4", [{ type: "text", text: "```html\n<h1>Отчёт</h1>\n```" }])] },
    ],
  ],
  [
    "Инструменты",
    [
      { title: "Команда", msgs: [tool("b1", "Bash", { command: "npm test", description: "Тесты" }), res("b1", "ok 12")] },
      { title: "Ошибка", msgs: [tool("b2", "Bash", { command: "npm run gate" }), res("b2", "нет зависимости", true)] },
      { title: "Идёт", msgs: [tool("b3", "Bash", { command: "npm run dev" })] },
      { title: "Отклонено", msgs: [tool("b4", "Bash", { command: "rm -r x" }), res("b4", "The user doesn't want to proceed with this tool use. Reason: не трогай", true)] },
      { title: "Правка", msgs: [tool("b5", "Edit", { file_path: "a.ts", old_string: "старая\nобщая\n", new_string: "новая\nобщая\n" })] },
      { title: "Запись страницы", msgs: [tool("b6", "Write", { file_path: "a.html", content: HTML })] },
      { title: "Чтение", msgs: [tool("b7", "Read", { file_path: "a.ts" }), res("b7", "const a = 1;")] },
      { title: "Задачи", msgs: [tool("b8", "TodoWrite", { todos: [{ content: "собрать", status: "completed" }, { content: "выложить", status: "in_progress" }, { content: "проверить", status: "pending" }] })] },
      { title: "Вопрос", msgs: [tool("b9", "AskUserQuestion", { questions: [{ question: "Базу?", options: [{ label: "стенд" }, { label: "прод" }] }] })] },
      { title: "План", msgs: [tool("b10", "ExitPlanMode", { plan: "## План\n\n1. раз" })] },
      { title: "Субагент", msgs: [tool("b11", "Agent", { description: "ищет", prompt: "найди таймауты" }), { ...tool("b12", "Grep", { pattern: "timeout" }), parent_tool_use_id: "t-b11" }] },
      { title: "MCP", msgs: [tool("b13", "mcp__github__create_issue", { title: "Таймаут" }), res("b13", "создано")] },
    ],
  ],
  [
    "Служебное",
    [
      { title: "Итог хода", msgs: [{ type: "result", uuid: "s1", subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41 }] },
      { title: "Ход оборвался", msgs: [{ type: "result", uuid: "s2", subtype: "error_during_execution", is_error: true, errors: ["процесс упал"] }] },
      { title: "Сжатие", msgs: [sys("s3", "compact_boundary", { compact_metadata: { pre_tokens: 90_000, post_tokens: 8000 } })] },
      { title: "Прервано", msgs: [{ type: "user", uuid: "s4", message: { content: "[Request interrupted by user]" } }] },
      { title: "Смена модели", msgs: [sys("s5", "init", { model: "claude-opus-5-5" }), sys("s6", "init", { model: "claude-sonnet-5-5" })] },
    ],
  ],
  [
    "Плашки",
    [
      { title: "Ошибка", msgs: [asst("e1", [], { error: "overloaded" })] },
      { title: "Отказ модели", msgs: [sys("e2", "model_refusal_fallback", { original_model: "claude-fable-5-1", fallback_model: "claude-opus-5-5" })] },
      { title: "Лимит", msgs: [{ type: "rate_limit_event", uuid: "e3", rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }] },
      { title: "Задача", msgs: [sys("e4", "task_started", { task_id: "k", description: "ищет" }), sys("e5", "task_progress", { task_id: "k", usage: { tool_uses: 2 } })] },
    ],
  ],
];

const silent = (view: Env["view"]): Env => ({
  callsign: "site@laptop",
  wide: true,
  view,
  send: () => undefined,
  rewind: () => null,
  canAct: () => true,
  label: (cs) => cs,
  waiting: () => false,
  act: () => {},
  again: () => {},
  cancel: () => {},
  probe: () => {},
  apply: () => {},
  cancelRewind: () => {},
  fill: () => {},
});

function SampleRow({ s }: { s: Sample }) {
  const env = useMemo(() => {
    const view = fold(s.msgs);
    return { view, env: silent(() => view) };
  }, [s]);
  return (
    <div className="chat-galr" data-sample={s.title}>
      <div className="chat-galn">{s.title}</div>
      <div className="chat-galc">
        <EnvCtx.Provider value={env.env}>
          <Rows rows={env.view.rows} />
        </EnvCtx.Provider>
      </div>
    </div>
  );
}

export function Gallery() {
  return (
    <div className="chat-gal">
      {SECTIONS.map(([title, samples]) => (
        <section key={title} className="chat-gals">
          <h3>{title}</h3>
          {samples.map((s) => (
            <SampleRow key={s.title} s={s} />
          ))}
        </section>
      ))}
    </div>
  );
}
