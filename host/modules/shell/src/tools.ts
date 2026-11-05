// Инструменты MCP шелла и текст снимка для модели.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { IMAGE_TYPES } from "@switchboard/host";
import type { Attachment, Host, Result } from "@switchboard/host";
import { z } from "zod";
import { duration, filesDir, stateWord } from "./runs.ts";
import type { Snapshot } from "./runs.ts";

type Refused = Extract<Result, { ok: false }>;

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ ...say(text), isError: true });

/** Отказ машины — словами для модели: что случилось и что делать. */
function refusal(r: Refused, machine: string, run: string | null = null): string {
  const texts: Record<string, string> = {
    no_shell: `на машине ${machine} нет такого шелла — какие есть, покажет info`,
    bad_frame: "запрос не по форме: шелл bash · pwsh · powershell, timeout — секунды больше 0; при background: true timeout обязателен",
    offline: `машины ${machine} нет на связи`,
    disconnected: `связь с машиной ${machine} оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run`,
    shutting_down: `Host машины ${machine} останавливается и новых запросов не берёт`,
    unknown_request: `на машине ${machine} нет модуля shell`,
    timeout: run ? `запуск ${run} мог начаться, смотри wait по run` : `машина ${machine} не ответила за 10 с, повтори`,
    no_run: `запуска ${run} на ${machine} нет: не было, прошли сутки после конца или Host машины перезапускался`,
    too_large: `ответ ${r.bytes} байт больше кадра рации (32 МиБ): сократи вывод (grep, tail) или сожми файлы в $SB_OUT`,
  };
  return `${r.error}: ${texts[r.error] ?? "отказ"}`;
}

/** Текст, если файл читается как UTF-8 без нуля; иначе null. */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function fileBlocks(run: string, { name, media_type: type, data }: Attachment) {
  if (IMAGE_TYPES.has(type)) return [{ type: "text" as const, text: `── ${name} (${type}) — картинка ──` }, { type: "image" as const, data, mimeType: type }];
  const bytes = Buffer.from(data, "base64");
  const text = asText(bytes);
  if (text !== null) return [{ type: "text" as const, text: `── ${name} (${type}) ──\n${text}` }];
  const path = join(filesDir(run), ...name.split("/").filter((x) => x && x !== "." && x !== ".."));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return [{ type: "text" as const, text: `── ${name} (${type}, ${Math.ceil(bytes.length / 1024)} КБ) — файл: ${path}` }];
}

function blocks(machine: string, run: string, s: Snapshot, note = "") {
  const head = `${machine} · ${stateWord(s)} · ${duration(s.ms)} · run ${run}${note}\n── stdout ──\n${s.stdout || "(пусто)"}${s.stderr ? `\n── stderr ──\n${s.stderr}` : ""}`;
  return { content: [{ type: "text" as const, text: head }, ...(s.files ?? []).flatMap((f) => fileBlocks(run, f))] };
}

const machine = z.string().describe("машина флота: win, wsl…; своя тоже");

/** Инструменты MCP сессии me. host появляется на старте Host, тексты от него не зависят. */
export function toolsOf(me: string, host: () => Host) {
  return [
    tool("info", "Какие шеллы есть на машине: версия и путь. Список машин и их ОС — mcp__parts__list.", { machine }, async ({ machine: m }) => {
      const r = await host().read("shell.info", { machine: m });
      return r.ok ? say(JSON.stringify((r.result as { shells: unknown }).shells, null, 1)) : fail(refusal(r, m));
    }),

    tool(
      "run",
      "Запустить скрипт bash или PowerShell на машине флота. Скрипт стартует в домашней папке; stdin отдаётся целиком и закрывается. " +
        "Файлы, положенные в $SB_OUT ($env:SB_OUT), вернутся: картинки — изображением, текст — текстом, прочее — файлом на этой машине. " +
        "По таймауту убивается всё дерево процесса. background: false — когда итог нужен для следующего шага и скрипт недолгий: ход ждёт итога, Esc гасит скрипт. " +
        "background: true — для долгого, с обязательным timeout: ответ сразу; посмотреть или дождаться — wait, погасить — kill; о конце придёт сообщение флота.",
      {
        machine,
        shell: z.enum(["bash", "pwsh", "powershell"]).describe("из info: bash · pwsh · powershell"),
        script: z.string().describe("текст скрипта"),
        stdin: z.string().optional().describe("ввод: отдаётся целиком и закрывается"),
        timeout: z.number().optional().describe("секунды жизни скрипта: по умолчанию 120, при background: true — обязательно"),
        background: z.boolean().describe("обязательный выбор: false — ждать итога, true — в фоне"),
      },
      async ({ machine: m, shell, script, stdin, timeout, background }, extra) => {
        const run = randomBytes(4).toString("hex");
        // ждущий run: Esc гасит скрипт
        if (!background) (extra as { signal?: AbortSignal }).signal?.addEventListener("abort", () => void host().request("shell.kill", { machine: m, run }), { once: true });
        const r = await host().request("shell.run", { machine: m, from: me, run, shell, script, stdin, timeout, background });
        if (!r.ok) return fail(refusal(r, m, run));
        const s = r.result as Snapshot;
        return blocks(m, run, s, background && s.state === "running" ? " — идёт в фоне: wait — посмотреть или дождаться, kill — погасить; о конце придёт сообщение флота" : "");
      },
    ),

    tool(
      "wait",
      "Дождаться конца запуска, но не дольше timeout секунд: кончился — итог с файлами, не кончился — всё накопленное, state running. " +
        "timeout: 0 — посмотреть сейчас. Итог хранится сутки после конца; читать его можно сколько угодно раз. Esc обрывает только ожидание.",
      { machine, run: z.string().describe("id запуска из ответа run"), timeout: z.number().describe("секунды ожидания; 0 — сразу") },
      async ({ machine: m, run, timeout }) => {
        const r = await host().request("shell.wait", { machine: m, run, timeout });
        return r.ok ? blocks(m, run, r.result as Snapshot) : fail(refusal(r, m, run));
      },
    ),

    tool("kill", "Погасить запуск: убить всё дерево процесса. ok — убит или уже кончился.", { machine, run: z.string().describe("id запуска") }, async ({ machine: m, run }) => {
      const r = await host().request("shell.kill", { machine: m, run });
      return r.ok ? say("ok") : fail(refusal(r, m, run));
    }),
  ];
}
