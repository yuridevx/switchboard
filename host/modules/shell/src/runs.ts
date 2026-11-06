// Запуски этой машины. Вывод и ввод — файлы: конец запуска — выход шелла, а не закрытие потоков у его фоновых детей.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { kindOf } from "@switchboard/protocol";
import type { Attachment, Host } from "@switchboard/host";
import { argsOf, killTree, KILL_MS, scriptOf, WIN, type Shell } from "./os.ts";

export const ROOT = join(tmpdir(), "switchboard-shell");
/** Сутки от конца запуска (слово пользователя 1 нояб.). */
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_S = 120;
const LINE_MAX = 200;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html",
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", pdf: "application/pdf", zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

type End = "exit" | "timeout" | "killed" | "stopped";
export type Snapshot = { state: "running" | End; code?: number | null; ms: number; stdout: string; stderr: string; files?: Attachment[] };
export type Spec = { id: string; path: string; shell: Shell; script: string; stdin?: string; timeout?: number; background: boolean; from?: string };

type Run = {
  id: string;
  dir: string;
  started: number;
  ended?: number;
  /** чем кончится: задаёт тот, кто гасит; иначе exit */
  end: End;
  code: number | null;
  pid?: number;
  /** сессия, которой сказать о конце фонового */
  owner?: string;
  /** предел жизни, затем предел смерти */
  limit?: ReturnType<typeof setTimeout>;
  ttl?: ReturnType<typeof setTimeout>;
  over: Promise<void>;
  finish: () => void;
  /** сообщение владельцу ушло */
  told: Promise<void>;
};

/** Состояние и код словами: «exit 3», «timeout». */
export const stateWord = (s: Pick<Snapshot, "state" | "code">) => (s.state === "exit" && s.code !== null && s.code !== undefined ? `exit ${s.code}` : s.state);

export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, "0")} с`;
}

function filesOf(out: string): Attachment[] {
  if (!existsSync(out)) return [];
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .map((file) => ({ file, name: relative(out, file).split(sep).join("/") }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ file, name }) => ({ name, media_type: TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream", data: readFileSync(file).toString("base64") }));
}

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly host: () => Host;

  constructor(host: () => Host) {
    this.host = host;
  }

  get(id: unknown): Run | undefined {
    return this.runs.get(id as string);
  }

  start(spec: Spec): Run {
    const { id, shell, background, from } = spec;
    const timeout = spec.timeout ?? DEFAULT_TIMEOUT_S;
    const dir = join(ROOT, "runs", id);
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    const { name, text } = scriptOf(shell, spec.script);
    const file = join(dir, name);
    writeFileSync(file, text);
    const output = (stream: string) => openSync(join(dir, stream), "w");
    const files = [output("stdout"), output("stderr")];
    if (spec.stdin !== undefined) writeFileSync(join(dir, "stdin"), spec.stdin);
    const input = spec.stdin === undefined ? "ignore" : openSync(join(dir, "stdin"), "r");
    const child = spawn(spec.path, argsOf(shell, file), { cwd: homedir(), env: { ...process.env, SB_OUT: out }, stdio: [input, ...files], detached: !WIN, windowsHide: true });
    for (const fd of input === "ignore" ? files : [input, ...files]) closeSync(fd);

    let finish = () => {};
    const over = new Promise<void>((r) => (finish = r));
    const run: Run = { id, dir, started: Date.now(), end: "exit", code: null, pid: child.pid, owner: background && kindOf(from) === "session" ? from : undefined, over, finish, told: Promise.resolve() };
    this.runs.set(id, run);
    this.host().log({ ev: "run_start", run: id, from, shell, background, timeout, line: spec.script.split("\n")[0].slice(0, LINE_MAX), pid: child.pid });
    child.once("exit", (code) => this.ended(run, code));
    child.once("error", (e) => {
      this.host().log({ kind: "stop", ev: "run_error", run: id, why: e.message });
      this.ended(run, null);
    });
    run.limit = setTimeout(() => this.put(run, "timeout"), timeout * 1000);
    return run;
  }

  /** Погасить дерево; не вышло за предел — запуск всё равно кончен, причина видна по state. */
  private put(run: Run, end: End): void {
    if (run.ended !== undefined || run.end !== "exit") return;
    run.end = end;
    clearTimeout(run.limit);
    if (run.pid !== undefined) killTree(run.pid);
    run.limit = setTimeout(() => this.ended(run, null), KILL_MS);
  }

  kill(run: Run): Promise<void> {
    this.put(run, "killed");
    return run.over;
  }

  private ended(run: Run, code: number | null): void {
    if (run.ended !== undefined) return;
    clearTimeout(run.limit);
    run.ended = Date.now();
    run.code = run.end === "exit" ? code : null;
    const size = (name: string) => statSync(join(run.dir, name)).size;
    this.host().log({ ev: "run_end", run: run.id, state: run.end, code: run.code, ms: run.ended - run.started, bytes: { stdout: size("stdout"), stderr: size("stderr") } });
    run.ttl = setTimeout(() => this.forget(run), TTL_MS);
    run.ttl.unref();
    run.finish();
    if (run.owner) run.told = this.tell(run, run.owner);
  }

  /** Владельцу фонового — конец запуска. */
  private async tell(run: Run, to: string): Promise<void> {
    const host = this.host();
    const { machine } = host;
    const text = run.end === "stopped" ? `run ${run.id} на ${machine} остановлен: Host ${machine} перезапускается, итог не сохранён` : `run ${run.id} на ${machine} кончился: ${stateWord({ state: run.end, code: run.code })} · ${duration(run.ended! - run.started)}. Итог — mcp__shell__wait ${JSON.stringify({ machine, run: run.id, timeout: 0 })}`;
    const r = await host.request("message", { to, text, report: true });
    if (!r.ok) host.log({ kind: "refuse", ev: "run_message", word: r.error, run: run.id, to, why: `сообщение о конце run ${run.id} не доставлено: ${r.error}` });
  }

  private forget(run: Run): void {
    this.runs.delete(run.id);
    clearTimeout(run.ttl);
    try {
      rmSync(run.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      this.host().log({ kind: "note", ev: "run_forget", run: run.id, why: (e as Error).message });
    }
  }

  snapshot(run: Run): Snapshot {
    const read = (name: string) => readFileSync(join(run.dir, name)).toString("utf8");
    const seen = { ms: (run.ended ?? Date.now()) - run.started, stdout: read("stdout"), stderr: read("stderr") };
    return run.ended === undefined ? { state: "running", ...seen } : { state: run.end, code: run.code, ...seen, files: filesOf(join(run.dir, "out")) };
  }

  /** Снимок в момент конца; ms — не позже. Без ms предел — у самого запуска. */
  async wait(run: Run, ms?: number): Promise<Snapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = ms === undefined ? [] : [new Promise((r) => (timer = setTimeout(r, ms)))];
    await Promise.race([run.over, ...late]);
    clearTimeout(timer);
    return this.snapshot(run);
  }

  /** Остановка Host: погасить всё сразу, ждущие получают stopped. */
  halt(): void {
    for (const run of this.runs.values()) this.put(run, "stopped");
  }

  /** Конец остановки: владельцы узнали, итогов и папок нет. */
  async close(): Promise<void> {
    const all = [...this.runs.values()];
    this.halt();
    await Promise.all(all.map((r) => r.over.then(() => r.told)));
    for (const run of all) this.forget(run);
  }
}
