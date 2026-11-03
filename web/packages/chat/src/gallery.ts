// Образцы для галереи карточек (#gallery): сообщения SDK той же формы, что приходят в session.events,
// и подпись «когда появляется». Рисуются тем же кодом, что живая лента.
import type { SdkMsg } from "./render.tsx";

export type Sample = { title: string; when: string; msgs: SdkMsg[]; swap?: string; hint?: string };

const asst = (uuid: string, content: unknown[]): SdkMsg => ({ type: "assistant", uuid, message: { content: content as never } });

export const SAMPLES: Sample[] = [
  { title: "Ваше сообщение", when: "user · текст человека; ✓ — reply ok на session.prompt, ✓✓ — этот uuid пришёл в ленте", msgs: [{ type: "user", uuid: "g-u1", message: { content: "Почини сборку" } }] },
  { title: "Ответ Claude", when: "assistant · text", msgs: [asst("g-a1", [{ type: "text", text: "Сборка зелёная. Поднял таймаут до 15 с." }])] },
  {
    title: "Команда идёт",
    when: "assistant · tool_use и tool_progress — секунды",
    msgs: [asst("g-a2", [{ type: "tool_use", id: "g-t1", name: "Bash", input: { command: "npm test" } }]), { type: "tool_progress", tool_use_id: "g-t1", elapsed_time_seconds: 18 }],
  },
  {
    title: "Правка с diff",
    when: "tool_use Edit и его tool_result",
    msgs: [
      asst("g-a3", [{ type: "tool_use", id: "g-t2", name: "Edit", input: { file_path: "vitest.config.ts", old_string: "testTimeout: 5000,", new_string: "testTimeout: 15000," } }]),
      { type: "user", uuid: "g-r2", message: { content: [{ type: "tool_result", tool_use_id: "g-t2" }] } },
    ],
  },
  { title: "Субагент", when: "system task_started · task_progress", msgs: [{ type: "system", subtype: "task_started", uuid: "g-s1", task_id: "g-k1", description: "Explore · ищет тесты CI" }, { type: "system", subtype: "task_progress", task_id: "g-k1", summary: "читает test/" }] },
  { title: "Итог хода", when: "result · success: время, шаги, стоимость", msgs: [{ type: "result", uuid: "g-z1", subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41 }] },
  { title: "Сжатие", when: "system compact_boundary", msgs: [{ type: "system", subtype: "compact_boundary", uuid: "g-c1", compact_metadata: { trigger: "auto", pre_tokens: 182_000, post_tokens: 41_000 } }] },
  { title: "Подмена аккаунта", when: "в roster сменилось поле account (slots)", msgs: [], swap: "⇄ аккаунт: infirex → y0902 · тот же ход" },
  {
    title: "Сообщение другой сессии",
    when: "ввод с тегом fleet-message (fleet)",
    msgs: [{ type: "user", uuid: "g-f1", message: { content: '<fleet-message from="poe-bot@pc">\nСтанция собрана. Прогони эталоны?\n</fleet-message>' } }],
  },
  { title: "Повтор API", when: "system api_retry", msgs: [{ type: "system", subtype: "api_retry", uuid: "g-p1", attempt: 2, max_retries: 10, error_status: 529 }] },
  { title: "Ход с ошибкой", when: "result · error_*", msgs: [{ type: "result", uuid: "g-z2", subtype: "error_during_execution" }] },
  { title: "Подсказка следующего", when: "prompt_suggestion — после result, опция query() promptSuggestions", msgs: [], hint: "Подсказка: «Закоммить правку» — Tab" },
];
