// Инструменты MCP shell: запрос к модулю shell нужной машины и ответ текстом для модели.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { IMAGE_TYPES } from "@switchboard/host";
import type { Attachment, Host, Result } from "@switchboard/host";
import { z } from "zod";
import { SHELLS } from "./os.ts";
import { duration, ROOT, stateWord, type Snapshot } from "./runs.ts";

type Refused = Extract<Result, { ok: false }>;
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ ...say(text), isError: true });

function refusal(r: Refused, machine: string, run: string | null, started = false): string {
  const words: Record<string, string> = {
    no_shell: `на машине ${machine} нет такого шелла — какие есть, покажет info`,
    bad_frame: "запрос не по форме: шелл bash · pwsh · powershell, timeout — секунды больше 0; при background: true timeout обязателен",
    offline: `машины ${machine} нет на связи`,
    disconnected: `связь с машиной ${machine} оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run`,
    shutting_down: `Host машины ${machine} останавливается и новых запросов не берёт`,
    unknown_request: `на машине ${machine} нет модуля shell`,
    timeout: started ? `запуск ${run} мог начаться, смотри wait по run` : `машина ${machine} не ответила за 10 с, повтори`,
    no_run: `запуска ${run} на ${machine} нет: не было, прошли сутки после конца или Host машины перезапускался`,
    too_large: `ответ ${String(r.bytes)} байт больше кадра рации (32 МиБ): сократи вывод (grep, tail) или сожми файлы в $SB_OUT`,
  };
  return `${r.error}: ${words[r.error] ?? "отказ"}`;
}

const utf8 = (data: Buffer) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
};

/** Файл для модели: картинка, текст или путь на этой машине. Имя пришло с другой машины: запись не выходит из папки запуска. */
function fileBlocks(run: string, f: Attachment): Block[] {
  if (IMAGE_TYPES.has(f.media_type)) return [{ type: "text", text: `── ${f.name} (${f.media_type}) — картинка ──` }, { type: "image", data: f.data, mimeType: f.media_type }];
  const data = Buffer.from(f.data, "base64");
  const text = utf8(data);
  if (text !== null) return [{ type: "text", text: `── ${f.name} (${f.media_type}) ──\n${text}` }];
  const path = join(ROOT, "files", run, ...f.name.split("/").filter((x) => x && x !== "." && x !== ".."));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return [{ type: "text", text: `── ${f.name} (${f.media_type}, ${Math.ceil(data.length / 1024)} КБ) — файл: ${path}` }];
}

function show(machine: string, run: string, s: Snapshot, note = ""): { content: Block[] } {
  const head = `${machine} · ${stateWord(s)} · ${duration(s.ms)} · run ${run}${note}\n── stdout ──\n${s.stdout || "(пусто)"}${s.stderr ? `\n── stderr ──\n${s.stderr}` : ""}`;
  return { content: [{ type: "text", text: head }, ...(s.files ?? []).flatMap((f) => fileBlocks(run, f))] };
}

export function toolsOf(host: () => Host, me: string) {
  const machine = z.string().describe("машина флота: win, wsl…; своя тоже");
  const seconds = "секунды ожидания; 0 — сразу";
  return [
    tool("info", "Какие шеллы есть на машине: версия и путь. Список машин и их ОС — mcp__parts__list.", { machine }, async (a) => {
      const r = await host().read("shell.info", { machine: a.machine });
      return r.ok ? say(JSON.stringify((r.result as { shells: unknown }).shells, null, 1)) : fail(refusal(r, a.machine, null));
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
        const run = randomBytes(8).toString("hex");
        if (!a.background) (extra as { signal?: AbortSignal }).signal?.addEventListener("abort", () => void host().request("shell.kill", { machine: a.machine, run }), { once: true });
        const r = await host().request("shell.run", { ...a, run, from: me });
        if (!r.ok) return fail(refusal(r, a.machine, run, true));
        const s = r.result as Snapshot;
        return show(a.machine, run, s, a.background && s.state === "running" ? " — идёт в фоне: wait — посмотреть или дождаться, kill — погасить; о конце придёт сообщение флота" : "");
      },
    ),
    tool(
      "wait",
      "Дождаться конца запуска, но не дольше timeout секунд: кончился — итог с файлами, не кончился — всё накопленное, state running. " +
        "timeout: 0 — посмотреть сейчас. Итог хранится сутки после конца; читать его можно сколько угодно раз. Esc обрывает только ожидание.",
      { machine, run: z.string().describe("id запуска из ответа run"), timeout: z.number().describe(seconds) },
      async (a) => {
        const r = await host().request("shell.wait", a);
        return r.ok ? show(a.machine, a.run, r.result as Snapshot) : fail(refusal(r, a.machine, a.run));
      },
    ),
    tool("kill", "Погасить запуск: убить всё дерево процесса. ok — убит или уже кончился.", { machine, run: z.string().describe("id запуска") }, async (a) => {
      const r = await host().request("shell.kill", a);
      return r.ok ? say("ok") : fail(refusal(r, a.machine, a.run));
    }),
  ];
}
