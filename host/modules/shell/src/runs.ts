// Машина-цель: запросы shell.run, wait, kill, info. Скрипт файлом в папке запуска, вывод прямо в её файлы, таймаут и kill гасят всё дерево;
// в момент конца итог получают все ждущие; итог любого запуска живёт сутки от конца, но не дольше Host; конец фонового — сообщение флота владельцу.
// Решений за вызывающего нет: режим, шелл и таймаут фонового называет он сам.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuse } from "@switchboard/host";
import type { Attachment, Ctx, Frame, Host, Module } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { killTree, launch, outFiles, shellPath, shells, SHELLS, sizeOf, textOf } from "./os.ts";
import type { ShellName, Spawned } from "./os.ts";

/** Срок итога: сутки от конца запуска — столько флот держит неполученный пуш (слово пользователя 1 нояб.). */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Таймаут ждущего запуска по умолчанию — как у Bash Claude Code. У фонового таймаут обязателен. */
const DEFAULT_TIMEOUT_S = 120;

export const ROOT = join(tmpdir(), "switchboard-shell");

export type State = "running" | "exit" | "timeout" | "killed" | "stopped";
/** Снимок запуска — одна форма ответа run и wait. */
export type Snapshot = { state: State; code?: number | null; ms: number; stdout: string; stderr: string; files?: Attachment[] };

type Ending = "timeout" | "killed" | "stopped";
type Run = {
  id: string;
  /** владелец — from запроса run: ему сообщение о конце фонового */
  owner: string | null;
  background: boolean;
  dir: string;
  files: Spawned;
  started: number;
  ended: number | null;
  state: State;
  code: number | null;
  /** почему гасим */
  ending: Ending | null;
  killTimer?: ReturnType<typeof setTimeout>;
  ttl?: ReturnType<typeof setTimeout>;
  /** ждущие конца: run без фона, wait и остановка модуля */
  waiters: Set<() => void>;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const stateWord = (s: { state: State; code?: number | null }) => (s.state === "exit" && s.code !== null && s.code !== undefined ? `exit ${s.code}` : s.state);

/** Длительность для человека: 48.2 с · 2 мин 03 с. */
export function duration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} с` : `${Math.floor(s / 60)} мин ${String(Math.floor(s % 60)).padStart(2, "0")} с`;
}

/** Запрос run по форме; не по форме — bad_frame, скрипт не запущен. */
function parseRun(req: Frame) {
  const { run, shell, script, stdin, timeout, background } = req;
  if (typeof run !== "string" || !ID.test(run)) throw refuse("bad_frame", "run: нужен id запуска");
  if (typeof shell !== "string" || !(SHELLS as readonly string[]).includes(shell)) throw refuse("bad_frame", `shell: ${String(shell)} — нужен bash, pwsh или powershell`);
  if (typeof script !== "string") throw refuse("bad_frame", "script: нужен текст");
  if (stdin !== undefined && typeof stdin !== "string") throw refuse("bad_frame", "stdin: нужен текст");
  if (typeof background !== "boolean") throw refuse("bad_frame", "background: обязательный выбор true или false");
  if (timeout !== undefined && !(typeof timeout === "number" && timeout > 0)) throw refuse("bad_frame", "timeout: секунды больше 0");
  if (background && timeout === undefined) throw refuse("bad_frame", "background: true — timeout обязателен");
  return { id: run, shell: shell as ShellName, script, stdin: (stdin as string | undefined) ?? "", timeout: (timeout as number | undefined) ?? DEFAULT_TIMEOUT_S, background };
}

export function makeRuns(host: () => Host) {
  const runs = new Map<string, Run>();
  /** сообщения о конце, ещё не отданные fleet: остановка Host их дожидается */
  const telling = new Set<Promise<unknown>>();

  function snapshot(r: Run): Snapshot {
    const s: Snapshot = { state: r.state, ms: (r.ended ?? Date.now()) - r.started, stdout: textOf(r.files.stdout), stderr: textOf(r.files.stderr) };
    return r.state === "running" ? s : { ...s, code: r.code, files: outFiles(r.files.out) };
  }

  function kill(r: Run, why: Ending): void {
    if (r.state !== "running") return;
    r.ending ??= why;
    if (r.files.child.pid !== undefined) killTree(r.files.child.pid);
  }

  function forget(r: Run): void {
    clearTimeout(r.ttl);
    runs.delete(r.id);
    try {
      rmSync(r.dir, { recursive: true, force: true });
    } catch (e) {
      // файл держит процесс, который скрипт пустил в фон: папка остаётся во временной папке ОС
      host().log({ kind: "note", ev: "run_forget", run: r.id, why: (e as Error).message });
    }
  }

  /** Конец фонового — сообщение флота владельцу, уведомление, не новая задача. Не доставилось — строка в журнале, итог ждёт wait. */
  function tell(r: Run): void {
    const m = host().machine;
    const text =
      r.state === "stopped"
        ? `run ${r.id} на ${m} остановлен: Host ${m} перезапускается, итог не сохранён`
        : `run ${r.id} на ${m} кончился: ${stateWord(r)} · ${duration(r.ended! - r.started)}. Итог — mcp__shell__wait {"machine":"${m}","run":"${r.id}","timeout":0}`;
    const told = host()
      .request("message", { to: r.owner, text, report: true })
      .then((x) => {
        if (!x.ok) host().log({ kind: "refuse", ev: "run_message", word: x.error, run: r.id, to: r.owner, why: `сообщение о конце run ${r.id} не доставлено: ${x.error}` });
      });
    telling.add(told);
    void told.finally(() => telling.delete(told));
  }

  function finish(r: Run, code: number | null): void {
    if (r.state !== "running") return;
    clearTimeout(r.killTimer);
    r.ended = Date.now();
    r.state = r.ending ?? "exit";
    r.code = r.state === "exit" ? code : null;
    host().log({ ev: "run_end", run: r.id, state: r.state, code: r.code, ms: r.ended - r.started, bytes: { stdout: sizeOf(r.files.stdout), stderr: sizeOf(r.files.stderr) } });
    for (const w of r.waiters) w();
    r.waiters.clear();
    // при остановке Host таймер снимает forget
    r.ttl = setTimeout(() => forget(r), TTL_MS);
    r.ttl.unref?.();
    if (r.background && r.owner && kindOf(r.owner) === "session") tell(r);
  }

  /** Конец запуска; кончился — сразу. */
  const ended = (r: Run) => (r.state === "running" ? new Promise<void>((res) => r.waiters.add(res)) : Promise.resolve());

  function runOf(req: Frame): Run {
    const r = typeof req.run === "string" ? runs.get(req.run) : undefined;
    if (!r) throw refuse("no_run", `run ${String(req.run)}: запуска нет`);
    return r;
  }

  async function run(req: Frame, ctx: Ctx): Promise<Snapshot> {
    const { id, shell, script, stdin, timeout, background } = parseRun(req);
    if (runs.has(id)) throw refuse("bad_frame", `run ${id}: такой запуск уже есть`);
    const path = shellPath(shell);
    if (!path) throw refuse("no_shell", `${shell}: на машине ${host().machine} нет`);
    const dir = join(ROOT, "runs", id);
    const files = launch(dir, shell, path, script, stdin);
    // отправитель — от Host или relay
    const r: Run = { id, owner: ctx.from ?? null, background, dir, files, started: Date.now(), ended: null, state: "running", code: null, ending: null, waiters: new Set() };
    runs.set(id, r);
    host().log({ ev: "run_start", run: id, from: r.owner, shell, pid: files.child.pid, timeout, background, line: script.split("\n")[0].slice(0, 200) });
    r.killTimer = setTimeout(() => kill(r, "timeout"), timeout * 1000);
    // сигнал остановки Host из контекста запроса: запуск гаснет с итогом stopped
    const onStop = () => kill(r, "stopped");
    ctx.signal.addEventListener("abort", onStop, { once: true });
    const close = (code: number | null) => {
      ctx.signal.removeEventListener("abort", onStop);
      try {
        finish(r, code);
      } catch (e) {
        // событие процесса — вне ловушки ядра: причина в журнал, Host живёт
        host().log({ kind: "stop", ev: "run_end", run: id, why: (e as Error).stack ?? String(e) });
      }
    };
    files.child.on("exit", (code) => close(code));
    // шелл не стартовал: итог — exit без кода, причина в журнале
    files.child.on("error", (e) => {
      host().log({ kind: "note", ev: "run_error", run: id, why: e.message });
      close(null);
    });
    if (!background) await ended(r);
    return snapshot(r);
  }

  async function wait(req: Frame): Promise<Snapshot> {
    const r = runOf(req);
    const t = req.timeout;
    if (!(typeof t === "number" && t >= 0)) throw refuse("bad_frame", "timeout: секунды ожидания, 0 — сразу");
    if (r.state === "running" && t > 0)
      await new Promise<void>((res) => {
        const done = () => {
          clearTimeout(timer);
          r.waiters.delete(done);
          res();
        };
        const timer = setTimeout(done, t * 1000);
        r.waiters.add(done);
      });
    return snapshot(r);
  }

  const requests: Required<Module>["requests"] = {
    "shell.run": run,
    "shell.wait": wait,
    "shell.kill": (req) => {
      kill(runOf(req), "killed");
      return undefined;
    },
    "shell.info": async () => ({ shells: await shells() }),
  };

  /** Штатная остановка: идущие уже гасит сигнал остановки Host — дождаться их конца и сообщений владельцам, стереть итоги и папки. */
  async function stop(): Promise<void> {
    await Promise.all([...runs.values()].map(ended));
    await Promise.allSettled([...telling]);
    for (const r of [...runs.values()]) forget(r);
  }

  return { requests, stop };
}
