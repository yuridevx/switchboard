// Машина: папки для выбора, журнал машины (строки Host, Keeper и держателей) и сбои из сообщений SDK — строками журнала.
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Refusal, type LogLine } from "@sb/protocol";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { clientPath, tildePath } from "../../core/paths.ts";

/** Ошибка ОС → слово договора; остальное — ошибка модуля. */
const WORDS: Record<string, string> = { ENOENT: "not_found", ENOTDIR: "not_found", ENAMETOOLONG: "not_found", EACCES: "no_access", EPERM: "no_access" };
const FILE = /^[a-z]+-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const first = (v: unknown) => String(v ?? "").split("\n")[0]!;

type Msg = Record<string, any>;
type Line = { level: "info" | "warn" | "error"; msg: string; why: string; [k: string]: unknown };

/** Сообщение SDK → строки журнала: только сбои и то, что нужно для разбора. */
function sdkLines(m: Msg): Line[] {
  if (m.type === "system" && m.subtype === "api_retry") return [{ level: "warn", msg: "sdk.api_retry", why: `попытка ${m.attempt} из ${m.max_retries}: ${m.error_status ?? "нет ответа"}, пауза ${m.retry_delay_ms / 1000} с` }];
  if (m.type === "system" && m.subtype === "status" && m.compact_result === "failed") return [{ level: "error", msg: "sdk.compact", why: `сжатие разговора не удалось: ${first(m.compact_error)}` }];
  if (m.type === "system" && m.subtype === "permission_denied") return [{ level: "warn", msg: "sdk.permission_denied", word: "permission_denied", why: `${m.tool_name}: ${first(m.decision_reason ?? m.message)}` }];
  // подтип ошибки — сбой и при is_error: false
  if (m.type === "result" && !(m.subtype === "success" && !m.is_error)) return [{ level: "error", msg: "sdk.result", word: m.startup_failure_reason ?? (m.subtype === "success" ? "is_error" : m.subtype), why: `ход остановлен: ${first(m.errors?.[0] ?? m.result)}` }];
  if (m.type === "rate_limit_event" && m.rate_limit_info?.status === "rejected") {
    const i = m.rate_limit_info;
    return [{ level: "error", msg: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта ${i.rateLimitType ?? "—"}: отказ до ${i.resetsAt ? new Date(i.resetsAt * 1000).toISOString() : "—"}` }];
  }
  if (m.type === "auth_status" && m.error) return [{ level: "error", msg: "sdk.auth_status", why: `вход аккаунта не удался: ${first(m.error)}` }];
  return [];
}

/** init процесса: версия, модель, папка, режим; серверы и плагины, которые не поднялись, — строкой error. */
function initLines(m: Msg): Line[] {
  const lines: Line[] = [{ level: "info", msg: "sdk.init", why: `claude ${m.claude_code_version} · ${m.model} · ${m.cwd} · ${m.permissionMode}` }];
  const mcp = ((m.mcp_servers ?? []) as Msg[]).filter((x) => x.status === "failed").map((x) => x.name as string);
  const plugins = (m.plugin_errors ?? []) as Msg[];
  const why = [...(mcp.length ? [`серверы инструментов не поднялись: ${mcp.join(", ")}`] : []), ...(plugins.length ? [`плагины: ${plugins.map((p) => `${p.plugin}: ${p.type} — ${p.message}`).join(", ")}`] : [])];
  if (why.length) lines.push({ level: "error", msg: "sdk.init", why: why.join("; ") });
  return lines;
}

type JournalQuery = { part?: string; level?: "info" | "warn" | "error"; before?: number; limit?: number; of?: string; session?: string; since?: number; kind?: "stop" | "refuse" | "note" };
const RANK = { info: 0, warn: 1, error: 2 };
const STOPS = /^(session_failed|session_exited|session_os_stop|stop|stop_late|shutdown|shutdown_late|exit|link_stopped|orphan_kill|initialize_late|sdk\.result|sdk\.rate_limit|host_failed)$/;
/** Вид строки: stop — остановки и сбои, refuse — отказы запросам, note — остальное. */
export const lineKind = (l: LogLine): "stop" | "refuse" | "note" => (l.msg === "request" ? (l.ok === false ? "refuse" : "note") : STOPS.test(l.msg) || l.level === "error" ? "stop" : "note");

/** Строки журнала машины до before, новые первыми. Чтение не держит поток Host; остановка Host его обрывает. */
async function journal(dir: string, q: JournalQuery, signal: AbortSignal): Promise<{ lines: LogLine[]; more: boolean }> {
  const limit = q.limit ?? 200;
  const before = q.before ?? Number.MAX_SAFE_INTEGER;
  const names = await readdir(dir).catch(() => [] as string[]);
  const dayOf = (name: string) => FILE.exec(name)?.[1];
  const lastDay = q.before === undefined ? "9999" : new Date(before).toISOString().slice(0, 10);
  const days = [...new Set(names.map(dayOf))].filter((d): d is string => !!d && d <= lastDay).sort().reverse();
  const since = q.since ?? 0;
  const firstDay = q.since === undefined ? "0000" : new Date(since).toISOString().slice(0, 10);
  // строка о сессии называет её полем callsign или адресатом запроса
  const about = (l: LogLine) => l.callsign === q.session || l.to === q.session;
  const wanted = (l: LogLine) =>
    typeof l.t === "number" && l.t < before && l.t >= since && (!q.part || l.part === q.part) && (!q.level || RANK[l.level] >= RANK[q.level]) && (!q.of || l.trace === q.of) &&
    (!q.session || about(l)) && (!q.kind || lineKind(l) === q.kind);
  const found: LogLine[] = [];
  for (const day of days) {
    if (found.length > limit || day < firstDay) break;
    const lines: LogLine[] = [];
    for (const n of names.filter((x) => dayOf(x) === day && (!q.part || x.startsWith(`${q.part}-`)))) {
      for (const text of (await readFile(join(dir, n), { encoding: "utf8", signal })).split("\n")) {
        if (!text) continue;
        try {
          const l = JSON.parse(text) as LogLine;
          if (wanted(l)) lines.push(l);
        } catch {
          // недописанная строка — не запись
        }
      }
    }
    found.push(...lines.sort((a, b) => b.t - a.t));
  }
  return { lines: found.slice(0, limit), more: found.length > limit };
}

export function make({ home = homedir() }: { home?: string } = {}): Module {
  let host: HostApi;
  /** процессы, чей init уже записан: новый процесс сессии пишет его снова */
  const inited = new Set<string>();
  return {
    name: "host-machine",
    start(h) {
      host = h;
    },
    compose: () => ({ env: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } }),
    requests: {
      "machine.dirs"({ path = "~" }: { path?: string }) {
        const full = clientPath(path, home);
        if (!full) throw new Refusal("bad_dir", `machine.dirs «${path}»: путь не от ~ и не полный`);
        try {
          const dirs = readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
          // недавние — папки сессий этой машины
          const recent = [...new Set(host.sessions().map((s) => tildePath(s.info.cwd, home)))];
          return { path, dirs, recent, git: existsSync(join(full, ".git")) };
        } catch (e) {
          const { code } = e as NodeJS.ErrnoException;
          if (!code || !WORDS[code]) throw e;
          throw new Refusal(WORDS[code]!, `machine.dirs «${path}»: ${code}`);
        }
      },
      "machine.journal": (q: JournalQuery, ctx: Ctx) => journal(join(host.dataDir, "journal"), q, ctx.signal),
    },
    on: {
      state(s, state) {
        if (state === "starting") inited.delete(s.callsign);
      },
      event(s, m: Msg) {
        const cs = s.callsign;
        let lines = sdkLines(m);
        if (m.type === "system" && m.subtype === "init" && !inited.has(cs)) {
          inited.add(cs);
          lines = initLines(m);
        }
        for (const { level, msg, ...fields } of lines) host.log[level](msg, { callsign: cs, ...fields });
      },
    },
  };
}
