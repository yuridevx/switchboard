// Слова ленты таблицами: что сказал SDK → что видит человек. Незнакомое значение показывается как есть.

export const API_ERRORS: Record<string, string> = {
  authentication_failed: "Вход в claude не действует",
  billing_error: "Проблема с оплатой подписки",
  rate_limit: "Лимит подписки исчерпан",
  overloaded: "Серверы Anthropic перегружены",
  server_error: "Ошибка сервера Anthropic",
  invalid_request: "Запрос отклонён API",
  model_not_found: "Модель не найдена",
  max_output_tokens: "Ответ упёрся в предел длины",
  account_on_hold: "Аккаунт приостановлен",
  unknown: "Неизвестная ошибка API",
};

export const REFUSAL_AREAS: Record<string, string> = { bio: "биология и химия", chem: "химия", weapons: "оружие", self_harm: "самоповреждение", cyber: "кибербезопасность" };

/** Почему ход отвечает запасная модель: {m} — модель сессии. */
export const FALLBACK_WHY: Record<string, string> = {
  model_not_found: "{m} недоступна",
  permission_denied: "{m} недоступна организации",
  overloaded: "{m} перегружена",
  server_error: "{m} не ответила (сбой сервера)",
  last_resort: "{m} не ответила (ошибка)",
  model_blocked: "{m} временно отключена",
};

export const RESULT_ERRORS: Record<string, string> = {
  error_during_execution: "сбой при выполнении",
  error_max_turns: "предел шагов",
  error_max_budget_usd: "предел бюджета",
  error_max_structured_output_retries: "предел повторов ответа",
};

/** Конец фоновой задачи: слово и тон строки. */
export const TASK_END: Record<string, [string, "ok" | "bad" | "wait"]> = {
  completed: ["Задача завершена", "ok"],
  failed: ["Задача упала", "bad"],
  stopped: ["Задача остановлена", "wait"],
  killed: ["Задача оборвана", "wait"],
};

/** Части контекста в панели своими подписями. */
export const CONTEXT_PARTS: Record<string, string> = {
  Messages: "Разговор",
  Skills: "Скилы",
  "Custom agents": "Свои агенты",
  "Autocompact buffer": "Запас на сжатие",
  "System prompt": "Системная подсказка",
  "System tools": "Инструменты",
  "MCP tools": "Инструменты MCP",
  "Memory files": "CLAUDE.md и память",
  "Free space": "Свободно",
};

export const STATUS_LABELS: Record<string, string> = {
  Version: "Версия",
  "Session name": "Имя",
  "Session ID": "Номер",
  "Session kind": "Вид",
  cwd: "Папка",
  "Login method": "Вход",
  Organization: "Организация",
  Email: "Почта",
  Model: "Модель",
  "MCP servers": "MCP",
  "Setting sources": "Настройки",
  Memory: "Память",
};

/** Подпись модели: claude-opus-5-5[1m] → Opus 5.5. */
export function modelName(model: unknown): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(String(model ?? ""));
  if (!m) return String(model ?? "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

