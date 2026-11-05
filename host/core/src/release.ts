// Выпуск Host: что собрано (build.json, модули) и закреплённый Agent SDK с его claude.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CALL_MS } from "@switchboard/protocol";
import { BUILD_FILE, type BuildList } from "@switchboard/release";
import type { Manifest, Module } from "../contract.ts";

/** Модуль сборки; failed — не импортировался, он выключен на машине. */
export type ModuleEntry = { manifest: Manifest; module: Module; failed?: string };
export type Release = { version: string; sdk: string; modules: ModuleEntry[]; workers: Record<string, string> };

export type Cli = (args: string[], env: Record<string, string | undefined>, input?: string) => Promise<{ code: number | null; out: string }>;
/** Agent SDK глазами ядра; на стенде — подделка. functions читаются при каждом вызове. */
export type SdkApi = { query: (p: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query; functions: Record<string, (...args: any[]) => Promise<unknown>>; cli: Cli; bin?: string };

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

async function importModule(dir: string, name: string): Promise<ModuleEntry> {
  const folder = join(dir, "modules", name);
  const manifest = readJson<Manifest>(join(folder, "module.json")); // папки нет — сборка негодна: это падает весь выпуск
  try {
    const { exports: entry } = readJson<{ exports: { ".": string } }>(join(folder, "package.json"));
    const module = ((await import(pathToFileURL(join(folder, entry["."])).href)) as { default?: Module }).default;
    return module ? { manifest, module } : { manifest, module: {}, failed: `${name}: импорт: нет default — объекта модуля` };
  } catch (e) {
    return { manifest, module: {}, failed: `${name}: импорт: ${(e as Error).message}` };
  }
}

/** Сборка лежит на два уровня выше ядра: packages/host. Без build.json (монорепо) модулей нет. */
export async function loadRelease(coreDir: string): Promise<Release> {
  const root = join(coreDir, "..", "..");
  const build = existsSync(join(root, BUILD_FILE)) ? readJson<BuildList>(join(root, BUILD_FILE)) : null;
  const modules = await Promise.all((build?.modules ?? []).map((m) => importModule(root, m.name)));
  const sdkDir = dirname(createRequire(join(coreDir, "main.ts")).resolve("@anthropic-ai/claude-agent-sdk"));
  return { version: build?.version ?? readJson<{ version: string }>(join(coreDir, "module.json")).version, sdk: readJson<{ version: string }>(join(sdkDir, "package.json")).version, modules, workers: build?.workers ?? {} };
}

/** Файл claude в пакете SDK для этой платформы; поиск самого SDK на Linux занимает около 20 с (process.report). */
export function claudePath(coreDir: string): string | undefined {
  const require = createRequire(join(coreDir, "main.ts"));
  const file = process.platform === "win32" ? "claude.exe" : "claude";
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return require.resolve(`${pkg}/${file}`);
    } catch {
      // такого варианта пакета нет: следующий
    }
  }
  return undefined;
}

/** Команда claude с пределом: stdout и stderr вместе; не ответила — убита, code null со словами. */
export function claudeCli(bin: string | undefined, ms: number = CALL_MS): Cli {
  return (args, env, input) =>
    new Promise((resolve) => {
      if (!bin) return resolve({ code: null, out: "claude не найден в пакете SDK" });
      const child = spawn(bin, args, { env, windowsHide: true });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, out: `claude не ответил за ${ms / 1000} с` });
      }, ms);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
}

/** Настоящий SDK для main. */
export function realSdk(coreDir: string): SdkApi {
  const functions: SdkApi["functions"] = {};
  for (const [name, f] of Object.entries(sdk)) if (typeof f === "function") functions[name] = f as SdkApi["functions"][string];
  const bin = claudePath(coreDir);
  return { query: sdk.query, functions, cli: claudeCli(bin), bin };
}
