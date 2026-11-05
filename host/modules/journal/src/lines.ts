// Сообщение SDK → строки журнала машины: что сессия не смогла, словами. Таблица «вид сообщения → строки»; всё прочее строк не даёт.
import type { LogRecord, SDKMessage } from "@switchboard/host";

type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- поля разных видов сообщения SDK
type Lines = (m: Msg) => LogRecord[];

const first = (s: unknown) => String(s ?? "").split("\n")[0];
const note = (ev: string, why: string, fields: Msg = {}): LogRecord => ({ kind: "note", ev, why, ...fields });
const stop = (ev: string, why: string, fields: Msg = {}): LogRecord => ({ kind: "stop", ev, why, ...fields });

function init(m: Msg): LogRecord[] {
  const failed: string[] = (m.mcp_servers ?? []).filter((x: Msg) => x.status === "failed").map((x: Msg) => x.name);
  const plugins: Msg[] = m.plugin_errors ?? [];
  const why = [...(failed.length ? [`MCP-серверы не поднялись: ${failed.join(", ")}`] : []), ...(plugins.length ? [`плагины: ${plugins.map((p) => `${p.plugin}: ${p.type} — ${p.message}`).join(", ")}`] : [])];
  return [
    note("sdk.init", `claude ${m.claude_code_version} · ${m.model} · ${m.cwd} · ${m.permissionMode}`, { claude_code_version: m.claude_code_version, model: m.model, cwd: m.cwd, permissionMode: m.permissionMode }),
    ...(why.length ? [stop("sdk.init", why.join("; "), { ...(failed.length ? { mcp_failed: failed } : {}), ...(plugins.length ? { plugin_errors: plugins } : {}) })] : []),
  ];
}

const SYSTEM: Record<string, Lines> = {
  api_retry: (m) => [note("sdk.api_retry", `попытка ${m.attempt} из ${m.max_retries}: ${m.error_status ?? "нет ответа"}, пауза ${m.retry_delay_ms / 1000} с`, { attempt: m.attempt, max_retries: m.max_retries, retry_delay_ms: m.retry_delay_ms, error_status: m.error_status, error: m.error })],
  status: (m) => (m.compact_result === "failed" ? [stop("sdk.compact", `сжатие разговора не удалось: ${first(m.compact_error)}`)] : []),
  permission_denied: (m) => [{ kind: "refuse", ev: "sdk.permission_denied", word: "permission_denied", tool_name: m.tool_name, decision_reason_type: m.decision_reason_type, why: `${m.tool_name}: ${first(m.decision_reason ?? m.message)}` }],
  worker_shutting_down: (m) => [note("sdk.worker_shutting_down", String(m.reason))],
  informational: (m) => (m.level === "warning" ? [note("sdk.informational", first(m.content))] : []),
};

const BY_TYPE: Record<string, Lines> = {
  system: (m) => SYSTEM[m.subtype]?.(m) ?? [],
  result(m) {
    if (m.subtype === "success" && !m.is_error) return [];
    return [stop("sdk.result", `ход остановлен: ${first(m.errors?.[0] ?? m.result)}`, { word: m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype) })];
  },
  rate_limit_event({ rate_limit_info: i }) {
    if (i?.status !== "rejected") return [];
    return [stop("sdk.rate_limit", `лимит аккаунта ${i.rateLimitType ?? "—"}: отказ до ${i.resetsAt ? new Date(i.resetsAt * 1000).toISOString() : "—"}`, { word: "rate_limit", rateLimitType: i.rateLimitType, resetsAt: i.resetsAt })];
  },
  auth_status: (m) => (m.error ? [stop("sdk.auth_status", `вход аккаунта не удался: ${first(m.error)}`)] : []),
};

/** Строки сообщения; system/init отдельно: он нужен только первый у процесса. */
export const linesOf = (msg: SDKMessage): LogRecord[] => BY_TYPE[msg.type]?.(msg as Msg) ?? [];
export const initLines = (msg: SDKMessage): LogRecord[] => init(msg as Msg);
export const isInit = (msg: SDKMessage) => msg.type === "system" && msg.subtype === "init";
