// Модуль shell: скрипты bash и PowerShell на любой машине флота. Два дела одного модуля:
//   машина-цель — запросы shell.run · wait · kill · info: скрипт файлом в папке запуска, вывод прямо в её файлы,
//     таймаут и kill гасят всё дерево процесса; в момент конца итог получают все ждущие (run без фона и wait);
//     итог любого запуска живёт сутки от конца, но не дольше Host; конец фонового — сообщение флота владельцу (from);
//   машина сессии — инструменты MCP info · run · wait · kill: id запуска, снимок → блоки MCP, Esc у ждущего run → shell.kill.
// Решений за вызывающего нет: режим, шелл и таймаут фонового называет он сам.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Attachment, Ctx, Frame, Host, Module, Result } from "@switchboard/host";
import { IMAGE_TYPES, refuse } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { killTree, outFiles, shellPath, shells, SHELLS, size, start, text } from "./run.ts";
import type { ShellName } from "./run.ts";

/** Срок итога: сутки от конца запуска — столько флот держит неполученный пуш (слово пользователя 1 нояб.). */
export const TTL_MS = 24 * 60 * 60 * 1000;
/** Таймаут ждущего запуска по умолчанию — как у Bash Claude Code. У фонового таймаут обязателен. */
export const DEFAULT_TIMEOUT_S = 120;

export type State = "running" | "exit" | "timeout" | "killed" | "stopped";
/** Снимок запуска — одна форма ответа run и wait. */
export type Snapshot = { state: State; code?: number | null; ms: number; stdout: string; stderr: string; files?: Attachment[] };

type Run = {
  id: string;
  /** владелец — from запроса run: callsign сессии; ему — сообщение о конце фонового */
  from: string | null;
  background: boolean;
  dir: string;
  stdout: string;
  stderr: string;
  out: string;
  started: number;
  ended: number | null;
  state: State;
  code: number | null;
  /** почему гасим: таймаут, kill или остановка Host */
  ending: "timeout" | "killed" | "stopped" | null;
  pid: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  ttl: ReturnType<typeof setTimeout> | undefined;
  /** ждущие конца: run без фона, wait и остановка модуля; снимок каждый берёт сам — в своём запросе, в ловушке ядра */
  waiters: Set<() => void>;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROOT = join(tmpdir(), "switchboard-shell");

/** Длительность для человека: 48.2 с · 2 мин 03 с. */
export function dur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${String(Math.floor(s % 60)).padStart(2, "0")} с`;
}

const stateText = (s: { state: State; code?: number | null }) => (s.state === "exit" && s.code !== null && s.code !== undefined ? `exit ${s.code}` : s.state);

type Blocks = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
const textResult = (t: string, isError = false): Blocks => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** UTF-8 без нулевых байтов — текст; иначе null. */
function asText(b: Buffer): string | null {
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(b);
    return t.includes("\u0000") ? null : t;
  } catch {
    return null;
  }
}

/** Снимок → блоки MCP: заголовок, stdout, stderr; картинка — изображением, текст — текстом, прочее — файлом на этой машине. */
export function blocks(machine: string, run: string, s: Snapshot, background = false): Blocks {
  const head = `${machine} · ${stateText(s)} · ${dur(s.ms)} · run ${run}` + (background && s.state === "running" ? " — идёт в фоне: wait — посмотреть или дождаться, kill — погасить; о конце придёт сообщение флота" : "");
  const parts = [head, "── stdout ──", s.stdout || "(пусто)"];
  if (s.stderr) parts.push("── stderr ──", s.stderr);
  const content: Blocks["content"] = [{ type: "text", text: parts.join("\n") }];
  for (const f of s.files ?? []) {
    const b = Buffer.from(f.data, "base64");
    if (IMAGE_TYPES.has(f.media_type)) {
      content.push({ type: "text", text: `── ${f.name} (${f.media_type}) — картинка ──` }, { type: "image", data: f.data, mimeType: f.media_type });
      continue;
    }
    const t = asText(b);
    if (t !== null) {
      content.push({ type: "text", text: `── ${f.name} (${f.media_type}) ──\n${t}` });
      continue;
    }
    const p = join(ROOT, "files", run, ...f.name.split("/").filter((x) => x && x !== ".." && x !== "."));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, b);
    content.push({ type: "text", text: `── ${f.name} (${f.media_type}, ${Math.ceil(b.length / 1024)} КБ) — файл: ${p}` });
  }
  return { content };
}

/** Отказ словом — текстом для модели. */
function failed(machine: string, run: string | null, r: Result & { ok: false }): Blocks {
  const why: Record<string, string> = {
    no_shell: `на машине ${machine} нет такого шелла — какие есть, покажет info`,
    no_run: `запуска ${run} на ${machine} нет: не было, прошли сутки после конца или Host машины перезапускался`,
    bad_frame: "запрос не по форме: шелл bash · pwsh · powershell, timeout — секунды больше 0; при background: true timeout обязателен",
    too_large: `ответ ${String(r.bytes ?? "")} байт больше кадра рации (32 МиБ): сократи вывод (grep, tail) или сожми файлы в $SB_OUT`,
    offline: `машины ${machine} нет на связи`,
    disconnected: `связь с машиной ${machine} оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run`,
    shutting_down: `Host машины ${machine} останавливается и новых запросов не берёт`,
    unknown_request: `на машине ${machine} нет модуля shell`,
  };
  return textResult(`${r.error}: ${why[r.error] ?? "отказ"}`, true);
}

export function make() {
  let host: Host;
  const runs = new Map<string, Run>();
  /** сообщения о конце, ещё не отданные fleet: остановка Host их дожидается */
  const sending = new Set<Promise<unknown>>();

  // ───────── машина-цель ─────────

  function snapshot(r: Run): Snapshot {
    const s: Snapshot = { state: r.state, ms: (r.ended ?? Date.now()) - r.started, stdout: text(r.stdout), stderr: text(r.stderr) };
    if (r.state !== "running") {
      s.code = r.code;
      s.files = outFiles(r.out);
    }
    return s;
  }

  function kill(r: Run, why: "timeout" | "killed" | "stopped"): void {
    if (r.state !== "running") return;
    r.ending ??= why;
    if (r.pid !== undefined) killTree(r.pid);
  }

  function forget(r: Run): void {
    clearTimeout(r.ttl);
    runs.delete(r.id);
    try {
      rmSync(r.dir, { recursive: true, force: true });
    } catch (e) {
      // файл держит процесс, который скрипт пустил в фон: папка остаётся во временной папке ОС
      host.log({ kind: "note", ev: "run_forget", run: r.id, why: (e as Error).message });
    }
  }

  function end(r: Run, code: number | null): void {
    if (r.state !== "running") return;
    clearTimeout(r.timer);
    r.ended = Date.now();
    r.state = r.ending ?? "exit";
    r.code = r.state === "exit" ? code : null;
    host.log({ ev: "run_end", run: r.id, state: r.state, code: r.code, ms: r.ended - r.started, bytes: { stdout: size(r.stdout), stderr: size(r.stderr) } });
    for (const w of r.waiters) w();
    r.waiters.clear();
    // при остановке Host таймер снимает forget в stop()
    r.ttl = setTimeout(() => forget(r), TTL_MS);
    r.ttl.unref?.();
    if (r.background && r.from && kindOf(r.from) === "session") tell(r);
  }

  /** Конец фонового — сообщение флота владельцу. Не доставилось — строка в журнале, итог ждёт wait. */
  function tell(r: Run): void {
    const m = host.machine;
    const body =
      r.state === "stopped"
        ? `run ${r.id} на ${m} остановлен: Host ${m} перезапускается, итог не сохранён`
        : `run ${r.id} на ${m} кончился: ${stateText(r)} · ${dur(r.ended! - r.started)}. Итог — mcp__shell__wait {"machine":"${m}","run":"${r.id}","timeout":0}`;
    const p = host.request("message", { v: 1, to: r.from, text: body }).then((x) => {
      if (!x.ok) host.log({ kind: "refuse", ev: "run_message", word: x.error, run: r.id, to: r.from, why: `сообщение о конце run ${r.id} не доставлено: ${x.error}` });
    });
    sending.add(p);
    void p.finally(() => sending.delete(p));
  }

  /** Конец запуска; кончился — сразу. */
  function ended(r: Run): Promise<void> {
    if (r.state !== "running") return Promise.resolve();
    return new Promise((res) => r.waiters.add(res));
  }

  function runOf(req: Frame): Run {
    const r = typeof req.run === "string" ? runs.get(req.run) : undefined;
    if (!r) throw refuse("no_run", `run ${String(req.run)}: запуска нет`);
    return r;
  }

  async function run(req: Frame, ctx: Ctx): Promise<Snapshot> {
    const { run: id, shell, script, stdin, timeout, background } = req;
    if (typeof id !== "string" || !ID.test(id)) throw refuse("bad_frame", "run: нужен id запуска");
    if (runs.has(id)) throw refuse("bad_frame", `run ${id}: такой запуск уже есть`);
    if (typeof shell !== "string" || !(SHELLS as readonly string[]).includes(shell)) throw refuse("bad_frame", `shell: ${String(shell)} — нужен bash, pwsh или powershell`);
    if (typeof script !== "string") throw refuse("bad_frame", "script: нужен текст");
    if (stdin !== undefined && typeof stdin !== "string") throw refuse("bad_frame", "stdin: нужен текст");
    if (typeof background !== "boolean") throw refuse("bad_frame", "background: обязательный выбор true или false");
    if (timeout !== undefined && !(typeof timeout === "number" && timeout > 0)) throw refuse("bad_frame", "timeout: секунды больше 0");
    if (background && timeout === undefined) throw refuse("bad_frame", "background: true — timeout обязателен");
    const path = shellPath(shell as ShellName);
    if (!path) throw refuse("no_shell", `${shell}: на машине ${host.machine} нет`);
    const dir = join(ROOT, "runs", id);
    const sp = start(dir, shell as ShellName, path, script, stdin ?? "");
    const r: Run = {
      id,
      // отправитель — от Host или relay
      from: ctx.from ?? null,
      background,
      dir,
      stdout: sp.stdout,
      stderr: sp.stderr,
      out: sp.out,
      started: Date.now(),
      ended: null,
      state: "running",
      code: null,
      ending: null,
      pid: sp.child.pid,
      timer: undefined,
      ttl: undefined,
      waiters: new Set(),
    };
    runs.set(id, r);
    const t = (timeout as number | undefined) ?? DEFAULT_TIMEOUT_S;
    host.log({ ev: "run_start", run: id, from: r.from, shell, pid: r.pid, timeout: t, background, line: script.split("\n")[0].slice(0, 200) });
    r.timer = setTimeout(() => kill(r, "timeout"), t * 1000);
    // сигнал остановки Host из контекста запроса: запуск гаснет с итогом stopped
    const onStop = () => kill(r, "stopped");
    ctx.signal.addEventListener("abort", onStop, { once: true });
    const close = (code: number | null) => {
      ctx.signal.removeEventListener("abort", onStop);
      try {
        end(r, code);
      } catch (e) {
        // событие процесса — вне ловушки ядра: причина в журнал, Host живёт
        host.log({ kind: "stop", ev: "run_end", run: id, why: (e as Error).stack ?? String(e) });
      }
    };
    sp.child.on("exit", (code) => close(code));
    // шелл не стартовал: итог — exit без кода, причина в журнале
    sp.child.on("error", (e) => {
      host.log({ kind: "note", ev: "run_error", run: id, why: e.message });
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

  // ───────── машина сессии: инструменты MCP ─────────

  const call = async (name: string, payload: Record<string, unknown>) => host.request(name, { v: 1, ...payload });

  function tools(me: string) {
    const machine = z.string().describe("машина флота: win, wsl…; своя тоже");
    return [
      tool("info", "Какие шеллы есть на машине: версия и путь. Список машин и их ОС — mcp__parts__list.", { machine }, async (a) => {
        const r = await call("shell.info", { machine: a.machine });
        return r.ok ? textResult(JSON.stringify((r.result as { shells: unknown }).shells, null, 1)) : failed(a.machine, null, r);
      }),
      tool(
        "run",
        "Запустить скрипт bash или PowerShell на машине флота. Скрипт стартует в домашней папке; stdin отдаётся целиком и закрывается. " +
          "Файлы, положенные в $SB_OUT ($env:SB_OUT), вернутся: картинки — изображением, текст — текстом, прочее — файлом на этой машине. " +
          "По таймауту убивается всё дерево процесса. background: false — когда итог нужен для следующего шага и скрипт недолгий: ход ждёт итога, Esc гасит скрипт. " +
          "background: true — для долгого, с обязательным timeout: ответ сразу; посмотреть или дождаться — wait, погасить — kill; о конце придёт сообщение флота.",
        {
          machine,
          shell: z.enum(SHELLS).describe("из info: bash · pwsh · powershell"),
          script: z.string().describe("текст скрипта"),
          stdin: z.string().optional().describe("ввод: отдаётся целиком и закрывается"),
          timeout: z.number().optional().describe("секунды жизни скрипта: по умолчанию 120, при background: true — обязательно"),
          background: z.boolean().describe("обязательный выбор: false — ждать итога, true — в фоне"),
        },
        async (a, extra) => {
          const run = randomUUID().slice(0, 8);
          // Esc у ждущего run гасит скрипт; ответа на kill никто не ждёт — вызова уже нет
          if (!a.background) (extra as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => void call("shell.kill", { machine: a.machine, run }), { once: true });
          const r = await call("shell.run", { machine: a.machine, from: me, run, shell: a.shell, script: a.script, stdin: a.stdin, timeout: a.timeout, background: a.background });
          return r.ok ? blocks(a.machine, run, r.result as Snapshot, a.background) : failed(a.machine, run, r);
        },
      ),
      tool(
        "wait",
        "Дождаться конца запуска, но не дольше timeout секунд: кончился — итог с файлами, не кончился — всё накопленное, state running. " +
          "timeout: 0 — посмотреть сейчас. Итог хранится сутки после конца; читать его можно сколько угодно раз. Esc обрывает только ожидание.",
        { machine, run: z.string().describe("id запуска из ответа run"), timeout: z.number().describe("секунды ожидания; 0 — сразу") },
        async (a) => {
          const r = await call("shell.wait", { machine: a.machine, run: a.run, timeout: a.timeout });
          return r.ok ? blocks(a.machine, a.run, r.result as Snapshot) : failed(a.machine, a.run, r);
        },
      ),
      tool("kill", "Погасить запуск: убить всё дерево процесса. ok — убит или уже кончился.", { machine, run: z.string().describe("id запуска") }, async (a) => {
        const r = await call("shell.kill", { machine: a.machine, run: a.run });
        return r.ok ? textResult("ok") : failed(a.machine, a.run, r);
      }),
    ];
  }

  const mod: Module = {
    requests: {
      "shell.run": run,
      "shell.wait": wait,
      "shell.kill": (req) => {
        kill(runOf(req), "killed");
        return undefined;
      },
      "shell.info": async () => ({ shells: await shells() }),
    },
    session: (s) => ({ mcpServers: { shell: createSdkMcpServer({ name: "shell", version: "1.0.0", tools: tools(s.info.callsign) }) } }),
    start(h) {
      host = h;
    },
    // штатная остановка: идущие уже гасит сигнал остановки Host — дождаться их конца и сообщений владельцам, стереть итоги и папки
    async stop() {
      await Promise.all([...runs.values()].map(ended));
      await Promise.allSettled([...sending]);
      for (const r of [...runs.values()]) forget(r);
    },
  };
  return { module: mod, tools };
}
