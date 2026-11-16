// Машина: папки для выбора, журнал машины (строки Host, Keeper и держателей) и беды из сообщений SDK — строками журнала (таблица — troubles.ts).
// Журнал машины уходит в историю флота (ClickHouse) пачками с места остановки: файл на машине — источник, вызовы модели отправку не ждут.
import { existsSync, readdirSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logWrite, MAX_FRAME, obsMetrics, Refusal, type HostMetrics, type LogLine } from "@sb/protocol";
import { limited } from "../../core/clock.ts";
import type { Window } from "../../core/meter.ts";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { clientPath, tildePath } from "../../core/paths.ts";
import { troubles } from "./troubles.ts";

/** Ошибка ОС → слово договора; остальное — ошибка модуля. */
const WORDS: Record<string, string> = { ENOENT: "not_found", ENOTDIR: "not_found", ENAMETOOLONG: "not_found", EACCES: "no_access", EPERM: "no_access" };
const FILE = /^[a-z]+-(\d{4}-\d{2}-\d{2})\.jsonl$/;

type Msg = Record<string, any>;

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

/** Как часто Host отдаёт свои числа службе наблюдения. */
export const METRICS_MS = 60_000;
/** Как часто машина смотрит, не дописан ли журнал: отставание истории флота от файла. Пока есть что слать, пачки идут подряд. */
export const SHIP_MS = 5_000;
/** Через сколько машина шлёт пачку снова после отказа истории флота. */
export const SHIP_RETRY_MS = 60_000;
/** Срок одной пачки: служба пишет её в ClickHouse внутри запроса. */
const SHIP_CALL_MS = 60_000;
/** Пачка строк, байты файла: в кадр она идёт строками JSON (экранирование удлиняет), служба держит её в памяти Worker'а несколько раз. */
const BATCH = MAX_FRAME / 8;

/** Места отправки: файл журнала → сколько его байт уже в истории флота. */
type Shipped = { sent: Record<string, number> };
type Batch = { file: string; pos: number; lines: string[]; next: number };

/** Следующая пачка: первый файл журнала, дописанный после своего места, — целые строки от места, не больше предела. */
async function nextBatch(dir: string, sent: Record<string, number>, limit: number): Promise<Batch | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => FILE.test(n)).sort();
  for (const file of names) {
    const pos = sent[file] ?? 0;
    const path = join(dir, file);
    if ((await stat(path)).size <= pos) continue;
    const fd = await open(path, "r");
    try {
      const { bytesRead, buffer } = await fd.read(Buffer.alloc(limit), 0, limit, pos);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      // строка ещё дописывается
      if (end < 0 && bytesRead < limit) continue;
      // строка длиннее пачки в историю не идёт: место уходит за прочитанное
      if (end < 0) return { file, pos, lines: [], next: pos + bytesRead };
      return { file, pos, lines: buffer.subarray(0, end).toString("utf8").split("\n"), next: pos + end + 1 };
    } finally {
      await fd.close();
    }
  }
  return null;
}

export function make({ home = homedir(), metricsMs = METRICS_MS, shipMs = SHIP_MS, batch = BATCH }: { home?: string; metricsMs?: number; shipMs?: number; batch?: number } = {}): Module {
  let host: HostApi;
  /** окно счётчиков, отданное последним */
  let last: Window = { counts: {}, times: {} };
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Числа Host: сессии и очередь — как есть сейчас; время провайдера, сбои и возобновления — за окно. */
  const numbers = (w: Window): HostMetrics => {
    const sessions: Record<string, number> = {};
    let queue = 0;
    for (const s of host.sessions()) {
      sessions[s.state] = (sessions[s.state] ?? 0) + 1;
      queue += s.info.queue;
    }
    const p = w.times.provider;
    return {
      at: Date.now(), build: host.build, sessions, queue,
      provider: { n: p?.n ?? 0, p50: p?.p50 ?? 0, p95: p?.p95 ?? 0, failed: w.counts["provider.failed"] ?? 0, retries: w.counts["provider.retry"] ?? 0 },
      crashes: w.counts["session.crash"] ?? 0, resumes: w.counts["session.resume"] ?? 0,
    };
  };
  /** Такт: закрыть окно и отдать числа службе; служба не ответила — строка журнала, следующее окно уйдёт своим тактом. */
  const tick = async () => {
    last = host.meter.take();
    await host.call(obsMetrics, numbers(last)).catch((e: unknown) => host.log.warn("metrics", { word: (e as { word?: string }).word ?? "offline", why: (e as Error).message }));
  };
  let stopped = false;
  let shipTimer: unknown;
  /** история флота не приняла пачку: строка журнала — одна на отказ и одна на возврат */
  let behind = false;
  /** Отправка журнала: в полёте одна пачка, место файла сдвигается только после ответа службы. Отказ — строки ждут в файле, та же пачка уйдёт снова через минуту. */
  const ship = async () => {
    const places = host.store<Shipped>();
    try {
      for (;;) {
        const sent = places.get()?.sent ?? {};
        const b = await nextBatch(host.journalDir, sent, batch);
        if (!b || stopped) break;
        if (b.lines.length) await limited(host.clock, host.call(logWrite, { file: b.file, pos: b.pos, lines: b.lines }), SHIP_CALL_MS, () => new Refusal("timeout", `служба не ответила за ${SHIP_CALL_MS / 1000} с`));
        else host.log.error("log_ship", { word: "line_too_long", why: `${b.file}: строка с места ${b.pos} длиннее пачки ${batch} байт — в историю флота не ушла` });
        // остановка оборвала запрос: место прежнее, новая машина пришлёт пачку снова
        if (stopped) break;
        // мест удалённых файлов журнала в записи нет
        const live = new Set(await readdir(host.journalDir).catch(() => [] as string[]));
        places.set({ sent: { ...Object.fromEntries(Object.entries(sent).filter(([file]) => live.has(file))), [b.file]: b.next } });
        if (behind) host.log.info("log_ship", { why: "история флота снова принимает журнал: отправка продолжилась с места остановки" });
        behind = false;
      }
    } catch (e) {
      if (!behind && !stopped) host.log.warn("log_ship", { word: (e as { word?: string }).word ?? "offline", why: `история флота не приняла журнал: ${(e as { why?: string }).why ?? (e as Error).message} — строки ждут в файле` });
      behind = true;
    }
    if (!stopped) shipTimer = host.clock.setTimeout(() => void ship(), behind ? SHIP_RETRY_MS : shipMs);
  };
  /** процессы, чей init уже записан: новый процесс сессии пишет его снова */
  const inited = new Set<string>();
  return {
    name: "host-machine",
    start(h) {
      host = h;
      timer = setInterval(() => void tick(), metricsMs);
      timer.unref();
      shipTimer = host.clock.setTimeout(() => void ship(), shipMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      host.clock.clearTimeout(shipTimer);
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
      "machine.journal": (q: JournalQuery, ctx: Ctx) => journal(host.journalDir, q, ctx.signal),
      "machine.metrics": () => numbers(last),
    },
    on: {
      state(s, state) {
        if (state === "starting") inited.delete(s.callsign);
      },
      event(s, m: Msg) {
        const cs = s.callsign;
        if (m.type === "system" && m.subtype === "api_retry") host.meter.count("provider.retry");
        // init приходит на каждый ход: строки о процессе — один раз на процесс
        const init = m.type === "system" && m.subtype === "init";
        if (init && inited.has(cs)) return;
        if (init) {
          inited.add(cs);
          host.log.info("sdk.init", { callsign: cs, why: `claude ${m.claude_code_version} · ${m.model} · ${m.cwd} · ${m.permissionMode}` });
        }
        for (const { level, msg, ...fields } of troubles(m)) host.log[level](msg, { callsign: cs, ...fields });
      },
    },
  };
}
