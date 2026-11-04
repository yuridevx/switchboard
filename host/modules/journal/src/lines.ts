// Что Claude SDK сообщает о сбоях сессии → строки журнала машины. Разговор сюда не идёт: его пишет сам Claude Code.
import type { LogRecord, SDKMessage } from "@switchboard/host";

type Msg = Record<string, any>;

const firstLine = (s: unknown) => String(s ?? "").split("\n")[0];

/** Системные сообщения по подвиду. */
const SYSTEM: Record<string, (m: Msg) => LogRecord[]> = {
  api_retry: (m) => [
    {
      ev: "sdk.api_retry",
      why: `попытка ${m.attempt} из ${m.max_retries}: ${m.error_status ?? "нет ответа"}, пауза ${m.retry_delay_ms / 1000} с`,
      attempt: m.attempt,
      max_retries: m.max_retries,
      error_status: m.error_status,
      retry_delay_ms: m.retry_delay_ms,
    },
  ],
  status: (m) => (m.compact_result === "failed" ? [{ kind: "stop", ev: "sdk.compact", why: `сжатие разговора не удалось: ${firstLine(m.compact_error)}` }] : []),
  permission_denied: (m) => [
    {
      kind: "refuse",
      ev: "sdk.permission_denied",
      word: "permission_denied",
      why: `${m.tool_name}: ${firstLine(m.decision_reason ?? m.message)}`,
      tool_name: m.tool_name,
      decision_reason_type: m.decision_reason_type,
    },
  ],
  worker_shutting_down: (m) => [{ ev: "sdk.worker_shutting_down", why: String(m.reason) }],
  informational: (m) => (m.level === "warning" ? [{ ev: "sdk.informational", why: firstLine(m.content) }] : []),
};

/** Прочие сообщения по виду. */
const OTHER: Record<string, (m: Msg) => LogRecord[]> = {
  result(m) {
    if (m.subtype === "success" && !m.is_error) return [];
    const word = m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype);
    return [{ kind: "stop", ev: "sdk.result", word, why: `ход остановлен: ${firstLine(m.errors?.length ? m.errors[0] : m.result)}` }];
  },
  rate_limit_event(m) {
    const limit = m.rate_limit_info as Msg | undefined;
    if (limit?.status !== "rejected") return [];
    const until = limit.resetsAt ? new Date(limit.resetsAt * 1000).toISOString() : "—";
    return [{ kind: "stop", ev: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта ${limit.rateLimitType ?? "—"}: отказ до ${until}`, rateLimitType: limit.rateLimitType, resetsAt: limit.resetsAt }];
  },
  auth_status: (m) => (m.error ? [{ kind: "stop", ev: "sdk.auth_status", why: `вход аккаунта не удался: ${firstLine(m.error)}` }] : []),
};

/** init: версия и настройки процесса; не поднявшиеся MCP-серверы и плагины — отдельной строкой stop. */
export function initLines(m: SDKMessage): LogRecord[] {
  const x = m as Msg;
  const out: LogRecord[] = [
    {
      ev: "sdk.init",
      why: `claude ${x.claude_code_version} · ${x.model} · ${x.cwd} · ${x.permissionMode}`,
      claude_code_version: x.claude_code_version,
      model: x.model,
      cwd: x.cwd,
      permissionMode: x.permissionMode,
    },
  ];
  const mcp = ((x.mcp_servers ?? []) as Msg[]).filter((s) => s.status === "failed").map((s) => s.name as string);
  const plugins = ((x.plugin_errors ?? []) as Msg[]).map((p) => `${p.plugin}: ${p.type} — ${p.message}`);
  const why = [mcp.length ? `MCP-серверы не поднялись: ${mcp.join(", ")}` : "", plugins.length ? `плагины: ${plugins.join("; ")}` : ""].filter(Boolean).join("; ");
  if (why) out.push({ kind: "stop", ev: "sdk.init", why, ...(mcp.length ? { mcp_failed: mcp } : {}), ...(plugins.length ? { plugin_errors: x.plugin_errors } : {}) });
  return out;
}

export const isInit = (m: SDKMessage) => (m as Msg).type === "system" && (m as Msg).subtype === "init";

/** Сообщение SDK, кроме init → строки журнала. */
export function linesOf(m: SDKMessage): LogRecord[] {
  const x = m as Msg;
  return (x.type === "system" ? SYSTEM[x.subtype] : OTHER[x.type])?.(x) ?? [];
}
