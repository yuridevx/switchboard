// Запуски этой машины. Вывод и ввод — файлы: конец запуска — выход шелла, а не закрытие потоков у его фоновых детей.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { kindOf } from "@switchboard/protocol";
import type { Attachment, Host } from "@switchboard/host";
import { argsOf, killTree, scriptOf, WIN, type Shell } from "./os.ts";

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

export type Snapshot = { state: string; code?: number | null; ms: number; stdout: string; stderr: string; files?: Attachment[] };
export type Spec = { id: string; path: string; shell: Shell; script: string; stdin?: string; timeout?: number; background: boolean; from?: string };

type Run = {
  id: string;
  dir: string;
  started: number;
  ended?: number;
  /** чем кончится: задаёт тот, кто гасит; иначе exit */
  end: string;
  code: number | null;
  pid: number;
  /** сессия, которой сказать о конце фонового */
  owner?: string;
  /** предел жизни */
  limit?: NodeJS.Timeout;
  ttl?: NodeJS.Timeout;
  over: Promise<void>;
  finish: () => void;
  /** сообщение владельцу ушло */
  told?: Promise<void>;
};

/** Состояние и код словами: «exit 3», «timeout». */
export const stateWord = (s: { state: string; code?: number | null }) => (s.state === "exit" && typeof s.code === "number" ? `exit ${s.code}` : s.state);

export const duration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60_000)} мин ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")} с`);

function filesOf(out: string): Attachment[] {
  if (!existsSync(out)) return [];
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = join(e.parentPath, e.name);
      return { name: relative(out, file).split(sep).join("/"), media_type: TYPES[extname(e.name).slice(1).toLowerCase()] ?? "application/octet-stream", data: readFileSync(file).toString("base64") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function makeRuns(host: () => Host) {
  const runs = new Map<string, Run>();

  function forget(run: Run): void {
    runs.delete(run.id);
    clearTimeout(run.ttl);
    try {
      rmSync(run.dir, { recursive: true, force: true });
    } catch (e) {
      // папку держит процесс, который скрипт пустил в фон
      host().log({ ev: "run_forget", run: run.id, why: (e as Error).message });
    }
  }

  /** Владельцу фонового — конец запуска. */
  async function tell(run: Run, to: string): Promise<void> {
    const { machine } = host();
    const { id, end, code } = run;
    const text = end === "stopped" ? `run ${id} на ${machine} остановлен: Host ${machine} перезапускается, итог не сохранён` : `run ${id} на ${machine} кончился: ${stateWord({ state: end, code })} · ${duration(run.ended! - run.started)}. Итог — mcp__shell__wait ${JSON.stringify({ machine, run: id, timeout: 0 })}`;
    const r = await host().request("message", { to, text, report: true });
    if (!r.ok) host().log({ kind: "refuse", ev: "run_message", word: r.error, run: id, to, why: `сообщение о конце run ${id} не доставлено: ${r.error}` });
  }

  function ended(run: Run, code: number | null): void {
    if (run.ended !== undefined) return;
    clearTimeout(run.limit);
    run.ended = Date.now();
    run.code = run.end === "exit" ? code : null;
    // скрипт мог стереть свою папку: конец запуска важнее счёта байт
    const size = (name: string) => statSync(join(run.dir, name), { throwIfNoEntry: false })?.size ?? 0;
    host().log({ ev: "run_end", run: run.id, state: run.end, code: run.code, ms: run.ended - run.started, bytes: { stdout: size("stdout"), stderr: size("stderr") } });
    run.ttl = setTimeout(() => forget(run), TTL_MS);
    run.ttl.unref();
    run.finish();
    if (run.owner) run.told = tell(run, run.owner);
  }

  /** Погасить дерево: конец запуска — конец снятия, а не выход шелла. Не вышло за предел — запуск кончен, причина в журнале. */
  function put(run: Run, end: string): void {
    if (run.ended !== undefined || run.end !== "exit") return;
    run.end = end;
    clearTimeout(run.limit);
    void killTree(run.pid).then((why) => {
      if (why) host().log({ kind: "stop", ev: "run_kill", run: run.id, why });
      ended(run, null);
    });
  }

  function snapshot(run: Run): Snapshot {
    const read = (name: string) => readFileSync(join(run.dir, name), "utf8");
    const seen = { ms: (run.ended ?? Date.now()) - run.started, stdout: read("stdout"), stderr: read("stderr") };
    return run.ended === undefined ? { state: "running", ...seen } : { state: run.end, code: run.code, ...seen, files: filesOf(join(run.dir, "out")) };
  }

  return {
    snapshot,
    get: (id: unknown) => runs.get(id as string),

    start(spec: Spec): Run {
      const { id, shell, stdin, background, from, timeout = DEFAULT_TIMEOUT_S } = spec;
      const dir = join(ROOT, "runs", id);
      const out = join(dir, "out");
      mkdirSync(out, { recursive: true });
      const { name, text } = scriptOf(shell, spec.script);
      writeFileSync(join(dir, name), text);
      if (stdin !== undefined) writeFileSync(join(dir, "stdin"), stdin);
      const fds = [stdin === undefined ? null : openSync(join(dir, "stdin"), "r"), openSync(join(dir, "stdout"), "w"), openSync(join(dir, "stderr"), "w")];
      const child = spawn(spec.path, argsOf(shell, join(dir, name)), { cwd: homedir(), env: { ...process.env, SB_OUT: out }, stdio: fds.map((fd) => fd ?? "ignore"), detached: !WIN, windowsHide: true });
      for (const fd of fds) if (fd !== null) closeSync(fd);

      let finish = () => {};
      const over = new Promise<void>((r) => (finish = r));
      const run: Run = { id, dir, started: Date.now(), end: "exit", code: null, pid: child.pid!, owner: background && kindOf(from) === "session" ? from : undefined, over, finish };
      runs.set(id, run);
      host().log({ ev: "run_start", run: id, from, shell, background, timeout, line: spec.script.split("\n")[0].slice(0, LINE_MAX), pid: child.pid });
      child.once("exit", (code) => {
        if (run.end === "exit") ended(run, code);
      });
      child.once("error", (e) => {
        host().log({ ev: "run_error", run: id, why: e.message });
        ended(run, null);
      });
      run.limit = setTimeout(() => put(run, "timeout"), timeout * 1000);
      return run;
    },

    kill(run: Run): Promise<void> {
      put(run, "killed");
      return run.over;
    },

    /** Снимок в момент конца; ms — не позже. Без ms предел — у самого запуска. */
    async wait(run: Run, ms?: number): Promise<Snapshot> {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([run.over, ...(ms === undefined ? [] : [new Promise((r) => (timer = setTimeout(r, ms)))])]);
      clearTimeout(timer);
      return snapshot(run);
    },

    /** Остановка Host: погасить всё сразу, ждущие получают stopped. */
    halt(): void {
      for (const run of runs.values()) put(run, "stopped");
    },

    /** Конец остановки: владельцы узнали, итогов и папок нет. */
    async close(): Promise<void> {
      const all = [...runs.values()];
      for (const run of all) put(run, "stopped");
      await Promise.all(all.map((r) => r.over.then(() => r.told)));
      all.forEach(forget);
    },
  };
}
