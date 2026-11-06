// Сборка на диске: build.json и modules/<имя>/ рядом с packages/, путь к claude из пакета SDK, команда claude.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CALL_MS } from "@switchboard/protocol";
import { BUILD_FILE, type BuildList } from "@switchboard/release";
import type { Manifest, Module } from "../contract.ts";

/** Модуль сборки. failed — не импортировался: выключен на машине. */
export type ModuleEntry = { manifest: Manifest; module: Module; failed?: string };
export type Release = { version: string; sdk: string; modules: ModuleEntry[]; workers: Record<string, string> };

const json = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

async function loadModule(dir: string, manifest: Manifest): Promise<ModuleEntry> {
  const { exports } = json<{ exports?: Record<string, string> }>(join(dir, "package.json"));
  try {
    const { default: module } = (await import(pathToFileURL(join(dir, exports?.["."] ?? "contract.ts")).href)) as { default?: Module };
    return module ? { manifest, module } : { manifest, module: {}, failed: `${manifest.name}: импорт: нет default — объекта модуля` };
  } catch (e) {
    return { manifest, module: {}, failed: `${manifest.name}: импорт: ${String(e)}` };
  }
}

/** Выпуск: root — папка версии. Без списка сборки — ядро из монорепо без модулей. */
export async function loadRelease(root: string, core: string): Promise<Release> {
  const sdk = json<{ version: string }>(join(createRequire(join(core, "x.js")).resolve("@anthropic-ai/claude-agent-sdk"), "..", "package.json")).version;
  const file = join(root, BUILD_FILE);
  if (!existsSync(file)) return { version: json<Manifest>(join(core, "module.json")).version, sdk, modules: [], workers: {} };
  const list = json<BuildList>(file);
  const dirs = list.modules.map((m) => join(root, "modules", m.name));
  const manifests = dirs.map((d) => json<Manifest>(join(d, "module.json")));
  return { version: list.version, sdk, workers: list.workers, modules: await Promise.all(dirs.map((d, i) => loadModule(d, manifests[i]))) };
}

/** Файл claude в пакете SDK: Host находит его сам, поиск внутри SDK на Linux идёт через process.report, это 20 с на wsl. */
export function claudePath(core: string): string | undefined {
  const { resolve } = createRequire(join(core, "x.js"));
  const file = `claude${process.platform === "win32" ? ".exe" : ""}`;
  for (const libc of ["", "-musl"]) {
    try {
      return resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/${file}`);
    } catch {
      // пакета этой libc на машине нет
    }
  }
  return undefined;
}

/** Команда claude: вывод вместе, предел ms — потом убита. */
export const claudeCli =
  (bin: string | undefined, ms = CALL_MS) =>
  (args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }> => {
    if (!bin) return Promise.resolve({ code: null, out: "claude не найден в пакете SDK" });
    return new Promise((resolve) => {
      const p = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        // ответ сейчас: close ждёт и потомков, которые держат вывод
        resolve({ code: null, out: `${out}claude не ответил за ${ms / 1000} с` });
      }, ms);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.stdin.on("error", () => {});
      p.stdin.end(input);
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out: String(e) });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  };
