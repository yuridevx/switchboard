// Скрипты на машине: запуск, ожидание, снятие. Вывод — файлы: конец запуска — выход шелла, а не закрытие потоков у его фоновых детей.
// stdout и stderr пишутся раздельно и вместе, по порядку прихода; файлы, которые скрипт кладёт в папку $SB_OUT, возвращаются в снимке.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { kindOf, message, newId, Refusal } from "@sb/protocol";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { clientPath } from "../../core/paths.ts";
import { argsOf, killTree, pathOf, scriptOf, SHELLS, versionOf, WIN, type Shell } from "./os.ts";

/** Сутки от конца запуска итог хранится. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Предел жизни запуска. */
const RUN_MS = 6 * 60 * 60 * 1000;
/** Сколько вывода уходит в ответ: хвост. */
const OUT_MAX = 200_000;
/** Сколько после выхода шелла ждём остаток его вывода. */
const DRAIN_MS = 300;
/** Файл из $SB_OUT идёт в ответ целиком, если он не больше; всего — не больше FILES_MAX. Больший — только имя и размер. */
const FILE_MAX = 256 * 1024;
const FILES_MAX = 2 * 1024 * 1024;

/** killed — снят запросом или остановкой Host; timeout — вышел предел запроса; stopped — вышел предел жизни запуска. */
type State = "running" | "done" | "failed" | "killed" | "timeout" | "stopped";
type Run = {
  id: string; dir: string; started: number; ended?: number; state: State; code?: number; pid: number;
  /** сессия, которой сказать о конце запуска, если она его не дождалась */
  owner?: string;
  waited: boolean;
  limit?: NodeJS.Timeout; ttl?: NodeJS.Timeout; timeout?: NodeJS.Timeout;
  over: Promise<void>; finish: () => void; killing?: State;
};

export function make({ root = join(tmpdir(), "sb2-shell") }: { root?: string } = {}): Module {
  let host: HostApi;
  const runs = new Map<string, Run>();

  const tail = (r: Run, name: string) => {
    try {
      const text = readFileSync(join(r.dir, name), "utf8");
      return text.length > OUT_MAX ? text.slice(-OUT_MAX) : text;
    } catch {
      // скрипт мог стереть свою папку
      return "";
    }
  };

  /** Файлы, которые скрипт положил в $SB_OUT: небольшие — целиком. */
  function filesOf(r: Run) {
    const dir = join(r.dir, "files");
    let left = FILES_MAX;
    try {
      return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => {
        const full = join(e.parentPath, e.name);
        const size = statSync(full).size;
        const name = full.slice(dir.length + 1).split("\\").join("/");
        if (size > FILE_MAX || size > left) return { name, size };
        left -= size;
        return { name, size, base64: readFileSync(full).toString("base64") };
      });
    } catch {
      return [];
    }
  }

  const snapshot = (r: Run) => {
    const files = r.ended === undefined ? [] : filesOf(r);
    return {
      run: r.id, state: r.state, ...(r.code !== undefined ? { code: r.code } : {}), out: tail(r, "out"), stdout: tail(r, "stdout"), stderr: tail(r, "stderr"),
      started: r.started, ...(r.ended ? { ended: r.ended, ms: r.ended - r.started } : {}), ...(files.length ? { files } : {}),
    };
  };

  function forget(r: Run): void {
    runs.delete(r.id);
    clearTimeout(r.ttl);
    try {
      rmSync(r.dir, { recursive: true, force: true });
    } catch (e) {
      // папку держит процесс, который скрипт пустил в фон
      host.log.warn("run_forget", { run: r.id, why: (e as Error).message });
    }
  }

  function ended(r: Run, state: State, code: number | null): void {
    if (r.ended !== undefined) return;
    clearTimeout(r.limit);
    clearTimeout(r.timeout);
    r.ended = Date.now();
    r.state = state;
    if (code !== null && (state === "done" || state === "failed")) r.code = code;
    const bytes = statSync(join(r.dir, "out"), { throwIfNoEntry: false })?.size ?? 0;
    host.log.info("run_end", { run: r.id, state, code: r.code, ms: r.ended - r.started, bytes });
    r.ttl = setTimeout(() => forget(r), TTL_MS);
    r.ttl.unref();
    r.finish();
    // сессия пустила запуск и не дождалась — конец придёт ей сообщением
    if (r.owner && !r.waited) {
      const text = `Запуск ${r.id} на ${host.machine} кончился: ${state}${r.code !== undefined ? `, код ${r.code}` : ""}. Вывод — shell_wait с run ${r.id}.`;
      void host.call(message, { to: r.owner, text }).catch((e: unknown) => host.log.warn("run_message", { run: r.id, to: r.owner, why: (e as Error).message }));
    }
  }

  /** Погасить дерево: конец запуска — конец снятия, а не выход шелла. as — чем кончился: снят, предел запроса или предел жизни. */
  function kill(r: Run, as: State = "killed"): Promise<void> {
    if (r.ended === undefined && !r.killing) {
      r.killing = as;
      clearTimeout(r.limit);
      clearTimeout(r.timeout);
      void killTree(r.pid).then((why) => {
        if (why) host.log.warn("run_kill", { run: r.id, why });
        ended(r, as, null);
      });
    }
    return r.over;
  }

  async function wait(r: Run, seconds: number | undefined): Promise<void> {
    if (!seconds) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([r.over, new Promise((res) => (timer = setTimeout(res, seconds * 1000)))]);
    clearTimeout(timer);
  }

  const runOf = (id: string) => {
    const r = runs.get(id);
    if (!r) throw new Refusal("no_run", `run ${id}: запуска нет`);
    return r;
  };

  return {
    name: "host-shell",
    start(h) {
      host = h;
      // остановка Host: запуски гаснут сразу, ждущие получают killed
      h.signal.addEventListener("abort", () => void [...runs.values()].forEach((r) => void kill(r)), { once: true });
    },
    async stop() {
      const all = [...runs.values()];
      await Promise.all(all.map((r) => kill(r)));
      all.forEach(forget);
    },
    requests: {
      async "shell.run"({ script, cwd, wait: seconds, shell = WIN ? "powershell" : "bash", stdin, timeout }: { script: string; cwd?: string; wait?: number; shell?: string; stdin?: string; timeout?: number }, ctx: Ctx) {
        const sh = (shell === "powershell" && !WIN ? "pwsh" : shell) as Shell;
        const path = SHELLS.includes(sh) ? pathOf(sh) : undefined;
        if (!path) throw new Refusal("no_shell", `${shell}: на машине ${host.machine} нет`);
        const where = cwd === undefined ? homedir() : clientPath(cwd, homedir());
        if (!where || !statSync(where, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal("bad_dir", `shell.run: папки ${cwd} нет`);
        const id = newId("x");
        const dir = join(root, id);
        const out = join(dir, "files");
        mkdirSync(out, { recursive: true });
        const { name, text } = scriptOf(sh, script);
        writeFileSync(join(dir, name), text);
        for (const f of ["out", "stdout", "stderr"]) writeFileSync(join(dir, f), "");
        const child = spawn(path, argsOf(sh, join(dir, name)), { cwd: where, env: { ...process.env, SB_OUT: out }, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: !WIN, windowsHide: true });
        // вывод — в файлы по мере прихода: запись не ждёт закрытия потоков, их могут держать фоновые дети скрипта
        const sink = (file: string) => (chunk: Buffer) => {
          try {
            appendFileSync(join(dir, file), chunk);
            appendFileSync(join(dir, "out"), chunk);
          } catch {
            // папку запуска уже убрали
          }
        };
        child.stdout!.on("data", sink("stdout"));
        child.stderr!.on("data", sink("stderr"));
        if (stdin !== undefined) {
          child.stdin!.on("error", () => {});
          child.stdin!.end(stdin);
        }
        let finish = () => {};
        const over = new Promise<void>((r) => (finish = r));
        const r: Run = { id, dir, started: Date.now(), state: "running", pid: child.pid ?? 0, owner: kindOf(ctx.from) === "session" ? ctx.from : undefined, waited: false, over, finish };
        runs.set(id, r);
        ctx.log.info("run_start", { run: id, from: ctx.from, shell: sh, pid: child.pid, line: script.split("\n")[0]!.slice(0, 200) });
        const closed = new Promise<void>((res) => child.once("close", () => res()));
        child.once("exit", (code) => {
          // последние куски вывода приходят после выхода шелла; потоки могут держать его фоновые дети — их закрытия ждём недолго
          let timer: NodeJS.Timeout | undefined;
          void Promise.race([closed, new Promise<void>((res) => (timer = setTimeout(res, DRAIN_MS)))]).then(() => {
            clearTimeout(timer);
            if (!r.killing) ended(r, code === 0 ? "done" : "failed", code);
          });
        });
        child.once("error", (e) => {
          host.log.warn("run_error", { run: id, why: e.message });
          ended(r, "failed", null);
        });
        r.limit = setTimeout(() => void kill(r, "stopped"), RUN_MS);
        r.limit.unref();
        if (timeout) {
          r.timeout = setTimeout(() => void kill(r, "timeout"), timeout * 1000);
          r.timeout.unref();
        }
        await wait(r, seconds);
        if (r.ended !== undefined) r.waited = true;
        return snapshot(r);
      },
      async "shell.wait"({ run, wait: seconds }: { run: string; wait?: number }) {
        const r = runOf(run);
        await wait(r, seconds);
        if (r.ended !== undefined) r.waited = true;
        return snapshot(r);
      },
      async "shell.kill"({ run }: { run: string }) {
        const r = runOf(run);
        await kill(r);
        return snapshot(r);
      },
      async "shell.info"() {
        const found = await Promise.all(SHELLS.flatMap((s) => {
          const path = pathOf(s);
          return path ? [versionOf(s, path).then((version) => ({ shell: s as string, path, version }))] : [];
        }));
        return { os: `${process.platform} ${process.arch}`, shells: found.map((f) => f.shell), home: homedir(), node: process.version, found };
      },
    },
  };
}
