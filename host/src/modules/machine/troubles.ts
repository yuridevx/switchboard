// Беды Claude: какое сообщение SDK — беда сессии, какого она уровня и какими словами названа. Таблица одна, на машине:
// строка уровня warn или error уходит в ленту сессии как есть, страница своих слов о бедах не держит.
// У каждого вида сообщения закреплённой версии SDK здесь есть место — в таблице бед или в списке «не беда»: новый вид без места роняет эталон.
import { LIMIT_WORD } from "@sb/protocol";

type Msg = Record<string, any>;
export type Line = { level: "info" | "warn" | "error"; msg: string; why: string; [k: string]: unknown };

/** Вид сообщения: type, у системного — «system:subtype». */
export const kindOf = (m: Msg): string => (m.type === "system" ? `system:${m.subtype}` : String(m.type));

const first = (v: unknown) => String(v ?? "").split("\n")[0]!;
/** Вывод хука и текст ошибки в строке журнала — не длиннее. */
const SAID_MAX = 300;
/** Пределы хода, о которых SDK говорит видом итога без текста. */
const TURN_LIMITS: Record<string, string> = { error_max_turns: "предел шагов", error_max_budget_usd: "предел бюджета", error_max_structured_output_retries: "предел повторов ответа" };
const DISK: Record<string, string> = { ENOSPC: "диск полон", EDQUOT: "квота диска выбрана" };
const LOST: Record<string, string> = { transcript: "часть разговора", global_config: "настройки claude" };
const utc = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const TROUBLES: Record<string, (m: Msg) => Line[]> = {
  /** Итог хода: подтип ошибки — сбой и при is_error: false. Ход, прерванный человеком, — не беда: итог сам называет прерывание. */
  result(m) {
    if (m.subtype === "success" && !m.is_error) return [];
    if (m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools") return [{ level: "info", msg: "sdk.result", word: "interrupted", why: "ход прерван" }];
    const said = [TURN_LIMITS[m.subtype], first(m.errors?.[0] ?? m.result)].filter(Boolean).join(" — ");
    return [{ level: "error", msg: "sdk.result", word: m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype), why: `ход остановлен: ${said || "причина не названа"}` }];
  },
  "system:status": (m) => (m.compact_result === "failed" ? [{ level: "error", msg: "sdk.compact", why: `сжатие разговора не удалось: ${first(m.compact_error)}` }] : []),
  rate_limit_event(m) {
    const i = m.rate_limit_info ?? {};
    if (i.status !== "rejected") return [];
    return [{ level: "error", msg: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта${i.rateLimitType ? ` (${LIMIT_WORD[i.rateLimitType] ?? i.rateLimitType})` : ""}: отказ${i.resetsAt ? ` до ${utc(i.resetsAt)}` : ""}` }];
  },
  auth_status: (m) => (m.error ? [{ level: "error", msg: "sdk.auth_status", why: `вход аккаунта не удался: ${first(m.error)}` }] : []),
  /** init процесса: серверы инструментов и плагины, которые не поднялись. */
  "system:init"(m) {
    const mcp = ((m.mcp_servers ?? []) as Msg[]).filter((x) => x.status === "failed").map((x) => x.name as string);
    const plugins = (m.plugin_errors ?? []) as Msg[];
    return [
      ...(mcp.length ? [{ level: "error" as const, msg: "sdk.init", word: "mcp_failed", why: `серверы инструментов не поднялись: ${mcp.join(", ")}` }] : []),
      ...(plugins.length ? [{ level: "error" as const, msg: "sdk.init", word: "plugin_failed", why: `плагины не загрузились: ${plugins.map((p) => `${p.plugin}: ${p.type} — ${p.message}`).join(", ")}` }] : []),
    ];
  },
  "system:plugin_install": (m) => (m.status === "failed" ? [{ level: "error", msg: "sdk.plugin_install", why: `плагин не установился${m.name ? ` (${m.name})` : ""}${m.error ? `: ${first(m.error)}` : ""}` }] : []),
  "system:session_writes_lost": (m) => [{ level: "error", msg: "sdk.writes_lost", word: m.error_code, why: `записи потеряны — ${DISK[m.error_code] ?? m.error_code}: не сохранено ${((m.lost ?? []) as string[]).map((x) => LOST[x] ?? x).join(", ")}` }],
  "system:permission_denied": (m) => [{ level: "warn", msg: "sdk.permission_denied", word: "permission_denied", why: `отклонено правилами: ${m.tool_name} — ${first(m.decision_reason ?? m.message)}` }],
  /** Хук: успех — не беда; у старых записей исхода нет — тогда по коду выхода. */
  "system:hook_response"(m) {
    if (m.outcome ? m.outcome === "success" : !m.exit_code) return [];
    const said = String(m.stderr || m.output || "").trim().slice(0, SAID_MAX);
    return [{ level: "warn", msg: "sdk.hook", why: `хук ${m.hook_name} не сработал${m.exit_code != null ? ` (код ${m.exit_code})` : ""}${said ? `: ${said}` : ""}` }];
  },
  "system:files_persisted"(m) {
    const failed = ((m.failed ?? []) as Msg[]).map((f) => `${f.filename}: ${f.error}`);
    return failed.length ? [{ level: "warn", msg: "sdk.files", why: `файлы не сохранились: ${failed.join(", ")}` }] : [];
  },
  "system:mirror_error": (m) => (m.error ? [{ level: "warn", msg: "sdk.mirror", why: `ошибка записи копии разговора: ${first(m.error)}` }] : []),
  /** Уведомление Claude высокой важности — его текст как есть: так приходит и сбой проверки цели, без причины. */
  "system:notification": (m) => (m.priority === "high" || m.priority === "immediate" ? [{ level: "warn", msg: "sdk.notification", why: String(m.text) }] : []),
  "system:informational": (m) => (m.level === "warning" ? [{ level: "warn", msg: "sdk.warning", why: String(m.content) }] : []),
  /** Повтор запроса — ход работы: причину даёт строка отказа провайдера. */
  "system:api_retry": (m) => [{ level: "info", msg: "sdk.api_retry", why: `попытка ${m.attempt} из ${m.max_retries}: ${m.error_status ?? "нет ответа"}, пауза ${m.retry_delay_ms / 1000} с` }],
};

/** Виды сообщений, в которых беды нет: разговор и ход работы. */
const CALM = new Set([
  "assistant", "user", "stream_event", "tool_progress", "tool_use_summary", "prompt_suggestion", "conversation_reset",
  "system:compact_boundary", "system:control_request_progress", "system:model_refusal_fallback", "system:model_refusal_no_fallback", "system:local_command_output",
  "system:hook_started", "system:hook_progress", "system:task_notification", "system:task_started", "system:task_updated", "system:task_progress",
  "system:background_tasks_changed", "system:thinking_tokens", "system:session_state_changed", "system:worker_shutting_down", "system:commands_changed",
  "system:memory_recall", "system:elicitation_complete",
]);

/** У вида сообщения есть место: таблица бед или «не беда». */
export const named = (kind: string): boolean => kind in TROUBLES || CALM.has(kind);

/** Сообщение SDK → строки журнала о нём: беда с уровнем и причиной или ничего. */
export const troubles = (m: Msg): Line[] => TROUBLES[kindOf(m)]?.(m) ?? [];
