// Образцы сообщений Claude, которые машина называет бедой сессии, — одни на эталоны машины и страницы:
// машина ставит каждому уровень и слова (её таблица бед), страница своих строк о них не рисует — беду пишет только строка журнала (LogEvent).
// level — уровень строки журнала: warn и error идут в ленту, info — только в журнал.

export type TroubleSample = { name: string; level: "info" | "warn" | "error"; event: Record<string, unknown> & { type: string } };

export const TROUBLE_SAMPLES: TroubleSample[] = [
  { name: "ход остановлен", level: "error", event: { type: "result", subtype: "success", is_error: true, result: "API Error: Request rejected (429) · Subscription quota exhausted.", duration_ms: 626, num_turns: 1 } },
  { name: "сжатие не удалось", level: "error", event: { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "prompt is too long" } },
  { name: "лимит аккаунта", level: "error", event: { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1795122000 } } },
  { name: "вход аккаунта", level: "error", event: { type: "auth_status", isAuthenticating: false, output: [], error: "OAuth token expired" } },
  { name: "сервер инструментов не поднялся", level: "error", event: { type: "system", subtype: "init", model: "claude-haiku-5-5", mcp_servers: [{ name: "ida", status: "failed" }] } },
  { name: "плагин не загрузился", level: "error", event: { type: "system", subtype: "init", model: "claude-haiku-5-5", plugin_errors: [{ plugin: "notes", type: "manifest", message: "нет plugin.json" }] } },
  { name: "плагин не установился", level: "error", event: { type: "system", subtype: "plugin_install", status: "failed", name: "notes", error: "git clone: код 128" } },
  { name: "записи разговора потеряны", level: "error", event: { type: "system", subtype: "session_writes_lost", error_code: "ENOSPC", lost: ["transcript"] } },
  { name: "отклонено правилами", level: "warn", event: { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_1", message: "команда запрещена правилом проекта" } },
  { name: "хук не сработал", level: "warn", event: { type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", outcome: "error", exit_code: 2, stderr: "lint failed", stdout: "", output: "" } },
  { name: "файлы не сохранились", level: "warn", event: { type: "system", subtype: "files_persisted", files: [], failed: [{ filename: "report.pdf", error: "файл слишком большой" }] } },
  { name: "копия разговора: ошибка", level: "warn", event: { type: "system", subtype: "mirror_error", error: "EACCES: нет доступа к папке копии" } },
  { name: "важное уведомление Claude", level: "warn", event: { type: "system", subtype: "notification", key: "stop-hook-error", text: "Stop hook error occurred · ctrl+o to see", priority: "immediate" } },
  { name: "предупреждение Claude", level: "warn", event: { type: "system", subtype: "informational", content: "Контекст почти полон", level: "warning" } },
  { name: "повтор запроса", level: "info", event: { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 529, retry_delay_ms: 2000 } },
  { name: "ход прерван человеком", level: "info", event: { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"], duration_ms: 4704, num_turns: 2 } },
];
