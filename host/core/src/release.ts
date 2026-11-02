// Выпуск Host: ядро, список сборки и Agent SDK точных версий.
// Сборка «Выпусков» — папка ядра плюс modules/<имя>/ и build.json в корне: { version, modules: [{ name, version }] }
// в порядке зависимостей — это порядок старта. Без build.json (ядро само по себе, монорепо) модулей нет.
// Модуль не импортировался — запись с ошибкой: ядро выключает его, остальные работают.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest, Module } from "../contract.ts";

/** Модуль выпуска; error — импорт не прошёл: модуль выключен на машине. */
export type ModuleEntry = { manifest: Manifest; module: Module; error?: string };

/** Список сборки в build.json. */
export type BuildList = { version: string; modules: Array<{ name: string; version: string }> };

export type Release = {
  /** версия выпуска: release.json папки ядра, иначе версия ядра */
  version: string;
  /** версия Agent SDK */
  sdk: string;
  modules: ModuleEntry[];
};

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** Папка пакета по пути его входа: вверх до package.json с этим именем. */
function packageDir(entry: string, name: string): string {
  for (let d = dirname(entry); ; d = dirname(d)) {
    const pj = join(d, "package.json");
    if (existsSync(pj) && readJson(pj).name === name) return d;
    if (dirname(d) === d) throw new Error(`не найден package.json пакета ${name}`);
  }
}

/** Прочитать выпуск от папки base: оттуда разрешаются ядро, модули и SDK. Модули импортируются заново из их папок. */
export async function loadRelease(base: string): Promise<Release> {
  const req = createRequire(join(base, "noop.js"));
  const coreDir = realpathSync(packageDir(req.resolve("@switchboard/host"), "@switchboard/host"));
  const core = readJson(join(coreDir, "module.json")) as Manifest;
  const coreReq = createRequire(join(coreDir, "noop.js"));
  const sdkDir = packageDir(coreReq.resolve("@anthropic-ai/claude-agent-sdk"), "@anthropic-ai/claude-agent-sdk");
  const sdk = readJson(join(sdkDir, "package.json")).version as string;
  // корень сборки — над packages/host
  const root = dirname(dirname(coreDir));
  const list = existsSync(join(root, "build.json")) ? (readJson(join(root, "build.json")) as BuildList) : null;
  const modules: ModuleEntry[] = [];
  for (const { name } of list?.modules ?? []) {
    const dir = join(root, "modules", name);
    const manifest = readJson(join(dir, "module.json")) as Manifest;
    try {
      const exp = (readJson(join(dir, "package.json")) as { exports?: Record<string, string> }).exports?.["."] ?? "./contract.ts";
      const module = ((await import(pathToFileURL(join(dir, exp)).href)) as { default?: Module }).default;
      if (!module) throw new Error("нет default — объекта модуля");
      modules.push({ manifest, module });
    } catch (e) {
      modules.push({ manifest, module: {}, error: `импорт: ${(e as Error).message}` });
    }
  }
  return { version: list?.version ?? core.version, sdk, modules };
}

/** Команда claude из пакета SDK: ввод — stdin, вывод — stdout и stderr вместе. claude нет — code null со словами. */
export function claudeCli(bin: string | undefined) {
  return (args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }> =>
    new Promise((res) => {
      if (!bin) return res({ code: null, out: "claude не найден в пакете SDK" });
      const p = spawn(bin, args, { env, windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => res({ code: null, out: e.message }));
      p.on("close", (code) => res({ code, out }));
      p.stdin.end(input ?? "");
    });
}

/** Путь к исполняемому claude из пакета SDK для этой платформы. */
export function claudePath(fromDir: string): string | undefined {
  const req = createRequire(join(fromDir, "noop.js"));
  const sdkReq = createRequire(req.resolve("@anthropic-ai/claude-agent-sdk"));
  const plat = `${process.platform}-${process.arch}`;
  for (const p of [plat, `${plat}-musl`]) {
    try {
      const d = dirname(sdkReq.resolve(`@anthropic-ai/claude-agent-sdk-${p}/package.json`));
      for (const b of ["claude.exe", "claude"]) if (existsSync(join(d, b))) return join(d, b);
    } catch {
      // нет пакета этой платформы — следующий
    }
  }
  return undefined;
}
