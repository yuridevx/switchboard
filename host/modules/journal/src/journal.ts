// host-journal: сбои из сообщений SDK — строками журнала машины; machine.journal — строки host и keeper из файлов журнала машины.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refuse, type Frame, type Host, type LogRecord, type Module, type SDKMessage } from "@switchboard/host";

type Msg = Record<string, any>;
type Line = { t: string; kind?: string; part?: string; callsign?: string; [k: string]: unknown };

const first = (v: unknown) => String(v ?? "—").split("\n")[0];

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

/** Сообщение SDK → строки журнала; что не сбой и не init — ничего. */
function lines(m: Msg, firstInit: boolean): LogRecord[] {
  const sub = m.type === "system" ? m.subtype : undefined;
  if (sub === "init") return firstInit ? init(m) : [];
  if (m.type === "result" && m.is_error) {
    const word = m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype);
    return [{ kind: "stop", ev: "sdk.result", word, why: `ход остановлен: ${first(m.errors?.[0] ?? m.result)}` }];
  }
  if (sub === "api_retry") {
    const { attempt, max_retries, retry_delay_ms, error_status } = m;
    return [{ ev: "sdk.api_retry", why: `попытка ${attempt} из ${max_retries}: ${error_status ?? "нет ответа"}, пауза ${retry_delay_ms / 1000} с`, attempt, max_retries, retry_delay_ms, error_status }];
  }
  if (m.type === "rate_limit_event" && m.rate_limit_info?.status === "rejected") {
    const { rateLimitType, resetsAt } = m.rate_limit_info;
    const until = resetsAt ? new Date(resetsAt * 1000).toISOString() : "—";
    return [{ kind: "stop", ev: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта ${rateLimitType ?? "—"}: отказ до ${until}`, rateLimitType, resetsAt }];
  }
  if (m.type === "auth_status" && m.error) return [{ kind: "stop", ev: "sdk.auth_status", why: `вход аккаунта не удался: ${first(m.error)}` }];
  if (sub === "status" && m.compact_result === "failed") return [{ kind: "stop", ev: "sdk.compact", why: `сжатие разговора не удалось: ${first(m.compact_error)}` }];
  if (sub === "permission_denied") {
    return [{ kind: "refuse", ev: "sdk.permission_denied", word: "permission_denied", tool_name: m.tool_name, decision_reason_type: m.decision_reason_type, why: `${m.tool_name}: ${first(m.decision_reason ?? m.message)}` }];
  }
  if (sub === "worker_shutting_down") return [{ ev: "sdk.worker_shutting_down", why: String(m.reason) }];
  if (sub === "informational" && m.level === "warning") return [{ ev: "sdk.informational", why: first(m.content) }];
  return [];
}

const FILE = /^(?:host|keeper)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
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
  const found: Line[] = [];
  for (const name of names) {
    const day = FILE.exec(name)?.[1];
    if (!day || day < since.slice(0, 10)) continue;
    for (const text of readFileSync(join(dir, name), "utf8").split("\n")) {
      let l: Line;
      try {
        l = JSON.parse(text);
      } catch {
        continue;
      }
      if (!(l.t > since) || (kind && !(kind as string[]).includes(l.kind ?? "note")) || (session && l.callsign !== session) || (part && l.part !== part)) continue;
      found.push(l);
    }
  }
  found.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
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
        const firstInit = m.type === "system" && m.subtype === "init" && !inited.has(cs);
        if (firstInit) inited.add(cs);
        for (const l of lines(m, firstInit)) host.log({ kind: "note", ...l, callsign: cs });
      },
    },
    requests: {
      "machine.journal": (q) => journal(join(host.dataDir, "journal"), q),
    },
  };
}
