// Скрипты на машине: запуск, ожидание, снятие. Вывод — файл: конец запуска — выход шелла, а не закрытие потоков у его фоновых детей.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { kindOf, message, newId, Refusal } from "@sb/protocol";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { clientPath } from "../../core/paths.ts";
import { argsOf, killTree, pathOf, scriptOf, SHELLS, WIN, type Shell } from "./os.ts";

/** Сутки от конца запуска итог хранится. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Предел жизни запуска. */
const RUN_MS = 6 * 60 * 60 * 1000;
/** Сколько вывода уходит в ответ: хвост. */
const OUT_MAX = 200_000;

type State = "running" | "done" | "failed" | "killed";
type Run = {
  id: string; dir: string; started: number; ended?: number; state: State; code?: number; pid: number;
  /** сессия, которой сказать о конце запуска, если она его не дождалась */
  owner?: string;
  waited: boolean;
  limit?: NodeJS.Timeout; ttl?: NodeJS.Timeout;
  over: Promise<void>; finish: () => void; killing?: boolean;
};

export function make({ root = join(tmpdir(), "sb2-shell") }: { root?: string } = {}): Module {
  let host: HostApi;
  const runs = new Map<string, Run>();

  const snapshot = (r: Run) => {
    let out = "";
    try {
      out = readFileSync(join(r.dir, "out"), "utf8");
    } catch {
      // скрипт мог стереть свою папку
    }
    return { run: r.id, state: r.state, ...(r.code !== undefined ? { code: r.code } : {}), out: out.length > OUT_MAX ? out.slice(-OUT_MAX) : out, started: r.started, ...(r.ended ? { ended: r.ended } : {}) };
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
    r.ended = Date.now();
    r.state = state;
    if (code !== null && state !== "killed") r.code = code;
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

  /** Погасить дерево: конец запуска — конец снятия, а не выход шелла. */
  function kill(r: Run): Promise<void> {
    if (r.ended === undefined && !r.killing) {
      r.killing = true;
      clearTimeout(r.limit);
      void killTree(r.pid).then((why) => {
        if (why) host.log.warn("run_kill", { run: r.id, why });
        ended(r, "killed", null);
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
      async "shell.run"({ script, cwd, wait: seconds, shell = WIN ? "powershell" : "bash" }: { script: string; cwd?: string; wait?: number; shell?: string }, ctx: Ctx) {
        const sh = (shell === "powershell" && !WIN ? "pwsh" : shell) as Shell;
        const path = SHELLS.includes(sh) ? pathOf(sh) : undefined;
        if (!path) throw new Refusal("no_shell", `${shell}: на машине ${host.machine} нет`);
        const where = cwd === undefined ? homedir() : clientPath(cwd, homedir());
        if (!where || !statSync(where, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal("bad_dir", `shell.run: папки ${cwd} нет`);
        const id = newId("x");
        const dir = join(root, id);
        mkdirSync(dir, { recursive: true });
        const { name, text } = scriptOf(sh, script);
        writeFileSync(join(dir, name), text);
        const fd = openSync(join(dir, "out"), "w");
        const child = spawn(path, argsOf(sh, join(dir, name)), { cwd: where, env: process.env, stdio: ["ignore", fd, fd], detached: !WIN, windowsHide: true });
        closeSync(fd);
        let finish = () => {};
        const over = new Promise<void>((r) => (finish = r));
        const r: Run = { id, dir, started: Date.now(), state: "running", pid: child.pid ?? 0, owner: kindOf(ctx.from) === "session" ? ctx.from : undefined, waited: false, over, finish };
        runs.set(id, r);
        ctx.log.info("run_start", { run: id, from: ctx.from, shell: sh, pid: child.pid, line: script.split("\n")[0]!.slice(0, 200) });
        child.once("exit", (code) => {
          if (!r.killing) ended(r, code === 0 ? "done" : "failed", code);
        });
        child.once("error", (e) => {
          host.log.warn("run_error", { run: id, why: e.message });
          ended(r, "failed", null);
        });
        r.limit = setTimeout(() => void kill(r), RUN_MS);
        r.limit.unref();
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
      "shell.info"() {
        const shells = SHELLS.filter((s) => pathOf(s));
        return { os: `${process.platform} ${process.arch}`, shells, home: homedir(), node: process.version };
      },
    },
  };
}
