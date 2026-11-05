// Машина сессии: инструменты MCP info, run, wait, kill. Id запуска, снимок → блоки MCP, отказ → текст для модели, Esc у ждущего run → shell.kill.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { IMAGE_TYPES } from "@switchboard/host";
import type { Attachment, Host, Result } from "@switchboard/host";
import { SHELLS } from "./os.ts";
import { duration, ROOT, stateWord, type Snapshot } from "./runs.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Blocks = { content: Content[]; isError?: boolean };

const say = (text: string, isError = false): Blocks => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** UTF-8 без нулевых байтов — текст; иначе null. */
function asText(b: Buffer): string | null {
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(b);
    return t.includes("\u0000") ? null : t;
  } catch {
    return null;
  }
}

/** Картинка — изображением, текст — текстом, прочее — файлом на этой машине. */
function fileBlocks(run: string, f: Attachment): Content[] {
  if (IMAGE_TYPES.has(f.media_type)) return [{ type: "text", text: `── ${f.name} (${f.media_type}) — картинка ──` }, { type: "image", data: f.data, mimeType: f.media_type }];
  const bytes = Buffer.from(f.data, "base64");
  const text = asText(bytes);
  if (text !== null) return [{ type: "text", text: `── ${f.name} (${f.media_type}) ──\n${text}` }];
  const path = join(ROOT, "files", run, ...f.name.split("/").filter((x) => x && x !== ".." && x !== "."));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return [{ type: "text", text: `── ${f.name} (${f.media_type}, ${Math.ceil(bytes.length / 1024)} КБ) — файл: ${path}` }];
}

/** Снимок → блоки MCP: заголовок, stdout, stderr, файлы. */
function blocks(machine: string, run: string, s: Snapshot, background = false): Blocks {
  const hint = background && s.state === "running" ? " — идёт в фоне: wait — посмотреть или дождаться, kill — погасить; о конце придёт сообщение флота" : "";
  const parts = [`${machine} · ${stateWord(s)} · ${duration(s.ms)} · run ${run}${hint}`, "── stdout ──", s.stdout || "(пусто)", ...(s.stderr ? ["── stderr ──", s.stderr] : [])];
  return { content: [{ type: "text", text: parts.join("\n") }, ...(s.files ?? []).flatMap((f) => fileBlocks(run, f))] };
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
    timeout: run ? `запуск ${run} мог начаться, смотри wait по run` : `машина ${machine} не ответила за 10 с, повтори`,
  };
  return say(`${r.error}: ${why[r.error] ?? "отказ"}`, true);
}

export function shellTools(me: string, host: () => Host) {
  const machine = z.string().describe("машина флота: win, wsl…; своя тоже");
  return [
    tool("info", "Какие шеллы есть на машине: версия и путь. Список машин и их ОС — mcp__parts__list.", { machine }, async (a) => {
      const r = await host().read("shell.info", { machine: a.machine });
      return r.ok ? say(JSON.stringify((r.result as { shells: unknown }).shells, null, 1)) : failed(a.machine, null, r);
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
        if (!a.background) (extra as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => void host().request("shell.kill", { machine: a.machine, run }), { once: true });
        const r = await host().request("shell.run", { machine: a.machine, from: me, run, shell: a.shell, script: a.script, stdin: a.stdin, timeout: a.timeout, background: a.background });
        return r.ok ? blocks(a.machine, run, r.result as Snapshot, a.background) : failed(a.machine, run, r);
      },
    ),
    tool(
      "wait",
      "Дождаться конца запуска, но не дольше timeout секунд: кончился — итог с файлами, не кончился — всё накопленное, state running. " +
        "timeout: 0 — посмотреть сейчас. Итог хранится сутки после конца; читать его можно сколько угодно раз. Esc обрывает только ожидание.",
      { machine, run: z.string().describe("id запуска из ответа run"), timeout: z.number().describe("секунды ожидания; 0 — сразу") },
      async (a) => {
        const r = await host().request("shell.wait", { machine: a.machine, run: a.run, timeout: a.timeout });
        return r.ok ? blocks(a.machine, a.run, r.result as Snapshot) : failed(a.machine, a.run, r);
      },
    ),
    tool("kill", "Погасить запуск: убить всё дерево процесса. ok — убит или уже кончился.", { machine, run: z.string().describe("id запуска") }, async (a) => {
      const r = await host().request("shell.kill", { machine: a.machine, run: a.run });
      return r.ok ? say("ok") : failed(a.machine, a.run, r);
    }),
  ];
}
