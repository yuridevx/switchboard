// Модуль journal: что Claude SDK сообщает о сбоях сессий — строками журнала машины; журнал машины по запросу.
// Разговор не дублирует: его пишет сам Claude Code в файл разговора. Своего хранилища нет — читает папку журнала.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, LogRecord, Module, SDKMessage } from "@switchboard/host";
import { refuse } from "@switchboard/host";

/** Папка журнала машины — та же, что у ядра: SWITCHBOARD_HOME или ~/.switchboard. */
export function journalDir(): string {
  return join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "journal");
}

const firstLine = (s: unknown) => String(s ?? "").split("\n")[0];

type Msg = Record<string, any>;

/** Сообщение SDK → записи журнала. init — только первый после старта процесса (first). */
export function records(m: SDKMessage, first: boolean): LogRecord[] {
  const x = m as Msg;
  if (x.type === "system" && x.subtype === "init") {
    if (!first) return [];
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
    if (mcp.length || plugins.length) {
      const why = [mcp.length ? `MCP-серверы не поднялись: ${mcp.join(", ")}` : "", plugins.length ? `плагины: ${plugins.join("; ")}` : ""].filter(Boolean).join("; ");
      out.push({ kind: "stop", ev: "sdk.init", why, ...(mcp.length ? { mcp_failed: mcp } : {}), ...(plugins.length ? { plugin_errors: x.plugin_errors } : {}) });
    }
    return out;
  }
  if (x.type === "result") {
    if (x.subtype === "success" && !x.is_error) return [];
    const word = x.startup_failure_reason ?? (x.subtype === "success" ? "is_error" : x.subtype);
    const why = x.errors?.length ? firstLine(x.errors[0]) : firstLine(x.result);
    return [{ kind: "stop", ev: "sdk.result", word, why: `ход остановлен: ${why}` }];
  }
  if (x.type === "system" && x.subtype === "api_retry") {
    const status = x.error_status ?? "нет ответа";
    return [{ ev: "sdk.api_retry", why: `попытка ${x.attempt} из ${x.max_retries}: ${status}, пауза ${x.retry_delay_ms / 1000} с`, attempt: x.attempt, max_retries: x.max_retries, error_status: x.error_status, retry_delay_ms: x.retry_delay_ms }];
  }
  if (x.type === "rate_limit_event" && x.rate_limit_info?.status === "rejected") {
    const r = x.rate_limit_info as Msg;
    const reset = r.resetsAt ? new Date(r.resetsAt * 1000).toISOString() : "—";
    return [{ kind: "stop", ev: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта ${r.rateLimitType ?? "—"}: отказ до ${reset}`, rateLimitType: r.rateLimitType, resetsAt: r.resetsAt }];
  }
  if (x.type === "auth_status" && x.error) {
    return [{ kind: "stop", ev: "sdk.auth_status", why: `вход аккаунта не удался: ${firstLine(x.error)}` }];
  }
  if (x.type === "system" && x.subtype === "status" && x.compact_result === "failed") {
    return [{ kind: "stop", ev: "sdk.compact", why: `сжатие разговора не удалось: ${firstLine(x.compact_error)}` }];
  }
  if (x.type === "system" && x.subtype === "permission_denied") {
    return [{ kind: "refuse", ev: "sdk.permission_denied", word: "permission_denied", why: `${x.tool_name}: ${firstLine(x.decision_reason ?? x.message)}`, tool_name: x.tool_name, decision_reason_type: x.decision_reason_type }];
  }
  if (x.type === "system" && x.subtype === "worker_shutting_down") {
    return [{ ev: "sdk.worker_shutting_down", why: String(x.reason) }];
  }
  if (x.type === "system" && x.subtype === "informational" && x.level === "warning") {
    return [{ ev: "sdk.informational", why: firstLine(x.content) }];
  }
  return [];
}

type JournalRecord = { t: string; kind?: string; callsign?: string; [k: string]: unknown };

/** Записи host и keeper машины после since, старые первыми; kind, callsign и part — по желанию.
 * part — чья строка: host — Host, keeper — сам keeper, имя приложения — его старты, выходы и вывод. */
export function read(dir: string, q: { since: string; kind?: string[]; callsign?: string; part?: string; limit: number }): { records: JournalRecord[]; more: boolean } {
  const day = q.since.slice(0, 10);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(host|keeper)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(-16, -6) >= day) : [];
  const all: JournalRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as JournalRecord;
      if (r.t <= q.since) continue;
      if (q.kind && !q.kind.includes(r.kind ?? "note")) continue;
      if (q.callsign !== undefined && r.callsign !== q.callsign) continue;
      if (q.part !== undefined && r.part !== q.part) continue;
      all.push(r);
    }
  }
  all.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return { records: all.slice(0, q.limit), more: all.length > q.limit };
}

export function make(): Module {
  let host: Host;
  /** сессии, у которых первый init нынешнего процесса уже записан */
  const inited = new Set<string>();

  return {
    // известный сбой старта claude — result со startup_failure_reason, а не только stderr у keeper
    session: () => ({ env: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } }),
    requests: {
      "machine.journal"(req) {
        const since = req.since;
        const limit = req.limit;
        const kind = req.kind;
        const callsign = req.callsign;
        const part = req.part;
        if (typeof limit !== "number" || limit < 1) throw refuse("bad_frame", "machine.journal: нет limit");
        if (typeof since !== "string" || Number.isNaN(Date.parse(since))) throw refuse("bad_frame", `machine.journal: since не время — ${String(since)}`);
        if (kind !== undefined && !(Array.isArray(kind) && kind.every((k) => typeof k === "string"))) throw refuse("bad_frame", "machine.journal: kind — список слов");
        if (callsign !== undefined && typeof callsign !== "string") throw refuse("bad_frame", "machine.journal: callsign — строка");
        if (part !== undefined && typeof part !== "string") throw refuse("bad_frame", "machine.journal: part — строка");
        return read(journalDir(), { since: new Date(since).toISOString(), kind: kind as string[] | undefined, callsign, part, limit });
      },
    },
    on: {
      event(s, m) {
        const cs = s.info.callsign;
        const first = !inited.has(cs);
        if ((m as Msg).type === "system" && (m as Msg).subtype === "init") inited.add(cs);
        for (const r of records(m, first)) host.log({ callsign: cs, ...r });
      },
      // процесс закрыт: следующий init — первый у нового процесса
      close(s) {
        inited.delete(s.info.callsign);
      },
    },
    start(h) {
      host = h;
    },
    // сохранять нечего: каждая строка уже записана
    stop() {},
  };
}
