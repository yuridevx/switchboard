// host-journal: сбои из сообщений SDK — строками журнала машины; machine.journal — строки host и keeper из файлов журнала машины.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refuse, type Frame, type Host, type LogRecord, type Module, type SDKMessage } from "@switchboard/host";

type Msg = Record<string, any>;
type Lines = (m: Msg) => LogRecord[];
type Line = { t: string; kind?: string; part?: string; callsign?: string; [k: string]: unknown };

const first = (v: unknown) => String(v ?? "").split("\n")[0];

/** init процесса: версия, модель, папка, режим; MCP и плагины, которые не поднялись, — строкой stop. */
function init(m: Msg): LogRecord[] {
  const lines: LogRecord[] = [
    { ev: "sdk.init", why: `claude ${m.claude_code_version} · ${m.model} · ${m.cwd} · ${m.permissionMode}`, claude_code_version: m.claude_code_version, model: m.model, cwd: m.cwd, permissionMode: m.permissionMode },
  ];
  const mcp = ((m.mcp_servers ?? []) as Msg[]).filter((x) => x.status === "failed").map((x) => x.name as string);
  const plugins = (m.plugin_errors ?? []) as Msg[];
  const why = [
    ...(mcp.length ? [`MCP-серверы не поднялись: ${mcp.join(", ")}`] : []),
    ...(plugins.length ? [`плагины: ${plugins.map((p) => `${p.plugin}: ${p.type} — ${p.message}`).join(", ")}`] : []),
  ];
  if (why.length) lines.push({ kind: "stop", ev: "sdk.init", why: why.join("; "), ...(mcp.length ? { mcp_failed: mcp } : {}), ...(plugins.length ? { plugin_errors: plugins } : {}) });
  return lines;
}

const stop = (ev: string, why: string, fields: Msg = {}): LogRecord => ({ kind: "stop", ev, why, ...fields });

const SYSTEM: Record<string, Lines> = {
  api_retry: ({ attempt, max_retries, retry_delay_ms, error_status, error }) => [
    { ev: "sdk.api_retry", why: `попытка ${attempt} из ${max_retries}: ${error_status ?? "нет ответа"}, пауза ${retry_delay_ms / 1000} с`, attempt, max_retries, retry_delay_ms, error_status, error },
  ],
  status: (m) => (m.compact_result === "failed" ? [stop("sdk.compact", `сжатие разговора не удалось: ${first(m.compact_error)}`)] : []),
  permission_denied: (m) => [
    { kind: "refuse", ev: "sdk.permission_denied", word: "permission_denied", tool_name: m.tool_name, decision_reason_type: m.decision_reason_type, why: `${m.tool_name}: ${first(m.decision_reason ?? m.message)}` },
  ],
  worker_shutting_down: (m) => [{ ev: "sdk.worker_shutting_down", why: String(m.reason) }],
  informational: (m) => (m.level === "warning" ? [{ ev: "sdk.informational", why: first(m.content) }] : []),
};

/** Вид сообщения SDK → строки журнала; всё прочее строк не даёт. system/init — отдельно: нужен только первый у процесса. */
const BY_TYPE: Record<string, Lines> = {
  system: (m) => SYSTEM[m.subtype]?.(m) ?? [],
  // подтип ошибки — сбой и при is_error: false
  result: (m) => (m.subtype === "success" && !m.is_error ? [] : [stop("sdk.result", `ход остановлен: ${first(m.errors?.[0] ?? m.result)}`, { word: m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype) })]),
  rate_limit_event({ rate_limit_info: i }) {
    if (i?.status !== "rejected") return [];
    const until = i.resetsAt ? new Date(i.resetsAt * 1000).toISOString() : "—";
    return [stop("sdk.rate_limit", `лимит аккаунта ${i.rateLimitType ?? "—"}: отказ до ${until}`, { word: "rate_limit", rateLimitType: i.rateLimitType, resetsAt: i.resetsAt })];
  },
  auth_status: (m) => (m.error ? [stop("sdk.auth_status", `вход аккаунта не удался: ${first(m.error)}`)] : []),
};

const FILE = /^(?:host|keeper)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Строка файла журнала; пустая или битая — ничего. */
function parsed(text: string): Line[] {
  try {
    return text ? [JSON.parse(text) as Line] : [];
  } catch {
    return [];
  }
}
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const isText = (v: unknown) => typeof v === "string";

/** Строки журнала машины после since, старые первыми: файлы host и keeper с дня since. */
function journal(dir: string, q: Frame) {
  const { limit, kind, session, part } = q;
  if (!Number.isInteger(limit) || (limit as number) < 1) throw refuse("bad_frame", "limit — целое больше нуля");
  if (!isText(q.since) || Number.isNaN(Date.parse(q.since as string))) throw refuse("bad_frame", "since — время ISO");
  if (!optional(kind, Array.isArray) || !optional(session, isText) || !optional(part, isText)) throw refuse("bad_frame", "kind — список, session и part — текст");
  const since = new Date(q.since as string).toISOString();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // папки ещё нет: строк нет
  }
  const wanted = (l: Line) => l.t > since && (!kind || (kind as string[]).includes(l.kind ?? "note")) && (!session || l.callsign === session) && (!part || l.part === part);
  const dayOf = (name: string) => FILE.exec(name)?.[1];
  // дни по порядку; записей набралось больше limit — дальше не читается
  const days = [...new Set(names.map(dayOf))].filter((d): d is string => !!d && d >= since.slice(0, 10)).sort();
  const found: Line[] = [];
  for (const day of days) {
    if (found.length > (limit as number)) break;
    const lines = names.filter((n) => dayOf(n) === day).flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").flatMap(parsed).filter(wanted));
    found.push(...lines.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)));
  }
  return { records: found.slice(0, limit as number), more: found.length > (limit as number) };
}

export function make(): Module {
  let host: Host;
  /** процессы, чей init уже записан: новый процесс сессии пишет его снова */
  const inited = new Set<string>();
  return {
    start(h) {
      host = h;
    },
    session: () => ({ env: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } }),
    on: {
      open: (s) => void inited.delete(s.info.callsign),
      event(s, msg: SDKMessage) {
        const m = msg as Msg;
        const cs = s.info.callsign;
        let lines = BY_TYPE[m.type]?.(m) ?? [];
        if (m.type === "system" && m.subtype === "init" && !inited.has(cs)) {
          inited.add(cs);
          lines = init(m);
        }
        for (const l of lines) host.log({ kind: "note", ...l, callsign: cs });
      },
    },
    requests: {
      "machine.journal": (q) => journal(join(host.dataDir, "journal"), q),
    },
  };
}
