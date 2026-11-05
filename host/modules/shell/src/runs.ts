// Жизнь запуска: старт, конец, предел, снимок, сутки хранения.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type { Attachment, Host } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { killTree, startShell } from "./os.ts";
import type { ShellName } from "./os.ts";

export type Snapshot = { state: string; ms: number; stdout: string; stderr: string; code?: number | null; files?: Attachment[] };
export type RunSpec = { id: string; owner?: string; shell: ShellName; path: string; script: string; stdin?: string; timeout: number; background: boolean };

/** Итог живёт сутки от конца (слово пользователя 1 нояб.). */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Сколько ждать выхода после убийства дерева: дальше запуск кончен и без него. */
const KILL_MS = 5_000;
const ROOT = join(tmpdir(), "switchboard-shell");

const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
  ".json": "application/json", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml", ".pdf": "application/pdf", ".zip": "application/zip", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const stateWord = (s: { state: string; code?: number | null }) => (s.state === "exit" && typeof s.code === "number" ? `exit ${s.code}` : s.state);
export const duration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60_000)} мин ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")} с`);
/** Куда на своей машине лягут файлы запуска, которые модель не прочтёт текстом. */
export const filesDir = (run: string) => join(ROOT, "files", run);

function readOut(out: string): Attachment[] {
  // скрипт мог стереть свою папку выхода
  if (!existsSync(out)) return [];
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const file = join(d.parentPath, d.name);
      return { name: relative(out, file).split(sep).join("/"), media_type: MEDIA[extname(d.name).toLowerCase()] ?? "application/octet-stream", data: readFileSync(file).toString("base64") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

class Run {
  readonly dir: string;
  readonly started = Date.now();
  state = "running";
  code: number | null = null;
  ended?: number;
  /** чем кончить, когда процесс выйдет: убит, предел, остановка Host */
  ending?: string;
  done!: Promise<void>;
  finish!: () => void;
  limit?: ReturnType<typeof setTimeout>;
  ttl?: ReturnType<typeof setTimeout>;
  pid?: number;
  /** сообщение владельцу о конце: остановка Host его дожидается */
  told?: Promise<unknown>;
  readonly spec: RunSpec;

  constructor(spec: RunSpec) {
    this.spec = spec;
    this.dir = join(ROOT, "runs", spec.id);
    this.done = new Promise((r) => (this.finish = r));
  }

  snapshot(): Snapshot {
    const read = (name: string) => readFileSync(join(this.dir, name), "utf8");
    const base = { state: this.state, ms: (this.ended ?? Date.now()) - this.started, stdout: read("stdout"), stderr: read("stderr") };
    return this.ended === undefined ? base : { ...base, code: this.code, files: readOut(join(this.dir, "out")) };
  }
}

export function makeRuns(host: () => Host) {
  const runs = new Map<string, Run>();

  function tell(run: Run, text: string): void {
    const to = run.spec.owner;
    if (kindOf(to) !== "session") return;
    run.told = host().request("message", { to, text, report: true }).then((r) => {
      if (!r.ok) host().log({ kind: "refuse", ev: "run_message", word: r.error, to, run: run.spec.id, why: `сообщение о конце run ${run.spec.id} не доставлено: ${r.error}` });
    });
  }

  function end(run: Run, code: number | null): void {
    if (run.ended !== undefined) return;
    clearTimeout(run.limit);
    run.ended = Date.now();
    run.state = run.ending ?? "exit";
    run.code = run.ending ? null : code;
    const { id, background } = run.spec;
    const size = (name: string) => statSync(join(run.dir, name), { throwIfNoEntry: false })?.size ?? 0;
    host().log({ ev: "run_end", run: id, state: run.state, code: run.code, ms: run.ended - run.started, bytes: { stdout: size("stdout"), stderr: size("stderr") } });
    if (run.state === "stopped") {
      if (background) tell(run, `run ${id} на ${host().machine} остановлен: Host ${host().machine} перезапускается, итог не сохранён`);
    } else {
      run.ttl = setTimeout(() => forget(run), TTL_MS);
      run.ttl.unref?.();
      if (background) tell(run, `run ${id} на ${host().machine} кончился: ${stateWord(run)} · ${duration(run.ended - run.started)}. Итог — mcp__shell__wait ${JSON.stringify({ machine: host().machine, run: id, timeout: 0 })}`);
    }
    run.finish();
  }

  function kill(run: Run, ending: string): void {
    run.ending ??= ending;
    if (run.pid !== undefined) killTree(run.pid);
    clearTimeout(run.limit);
    run.limit = setTimeout(() => end(run, null), KILL_MS);
  }

  function forget(run: Run): void {
    runs.delete(run.spec.id);
    try {
      rmSync(run.dir, { recursive: true, force: true });
    } catch (e) {
      // папку держит процесс, который скрипт пустил в фон
      host().log({ ev: "run_forget", run: run.spec.id, why: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    has: (id: string) => runs.has(id),
    get: (id: unknown) => runs.get(id as string),

    start(spec: RunSpec): Run {
      const run = new Run(spec);
      runs.set(spec.id, run);
      const out = join(run.dir, "out");
      mkdirSync(out, { recursive: true });
      const child = startShell(spec.shell, spec.path, run.dir, spec.script, spec.stdin, out);
      run.pid = child.pid;
      child.on("error", (e) => {
        host().log({ ev: "run_error", run: spec.id, why: e.message });
        end(run, null);
      });
      child.on("exit", (code) => end(run, code));
      host().log({ ev: "run_start", run: spec.id, from: spec.owner, shell: spec.shell, pid: child.pid, timeout: spec.timeout, background: spec.background, line: spec.script.split("\n")[0].slice(0, 200) });
      run.limit = setTimeout(() => kill(run, "timeout"), spec.timeout * 1000);
      return run;
    },

    /** Дождаться конца, но не дольше ms. */
    async wait(run: Run, ms: number): Promise<void> {
      if (run.ended !== undefined || ms <= 0) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        void run.done.then(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },

    kill,

    /** Остановка Host: ядро ждёт начатые запросы до stop() модуля, поэтому запуски гаснут по сигналу — ждущие получают stopped с выводом. */
    halt(): void {
      for (const r of runs.values()) if (r.ended === undefined) kill(r, "stopped");
    },

    /** Итогов и папок после остановки нет. */
    async stop(): Promise<void> {
      this.halt();
      const all = [...runs.values()];
      await Promise.all(all.map((r) => r.done.then(() => r.told)));
      for (const r of all) {
        clearTimeout(r.ttl);
        forget(r);
      }
    },
  };
}
