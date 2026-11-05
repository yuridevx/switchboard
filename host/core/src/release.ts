// Выпуск Host: ядро, список сборки и Agent SDK точных версий.
// Сборка «Выпусков» — папка ядра плюс modules/<имя>/ и build.json в корне (BuildList формата выпуска): модули в порядке
// зависимостей — это порядок старта, и адреса Worker'ов флота, которыми пользуется сборка. Без build.json (ядро само
// по себе, монорепо) модулей и адресов нет. Модуль не импортировался — запись с ошибкой: ядро выключает его, остальные работают.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILD_FILE, type BuildList } from "@switchboard/release";
import type { Manifest, Module } from "../contract.ts";

/** Модуль выпуска; error — импорт не прошёл: модуль выключен на машине. */
export type ModuleEntry = { manifest: Manifest; module: Module; error?: string };

export type Release = {
  /** версия выпуска: build.json сборки, иначе версия ядра */
  version: string;
  /** версия Agent SDK */
  sdk: string;
  modules: ModuleEntry[];
  /** адреса Worker'ов флота из списка сборки: имя → https; relay — объекты машин, gate — список машин */
  workers: Record<string, string>;
};

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const requireFrom = (dir: string) => createRequire(join(dir, "noop.js"));

/** Папка пакета по пути его входа: вверх до package.json с этим именем. */
function packageDir(entry: string, name: string): string {
  for (let d = dirname(entry); ; d = dirname(d)) {
    const pj = join(d, "package.json");
    if (existsSync(pj) && readJson(pj).name === name) return d;
    if (dirname(d) === d) throw new Error(`не найден package.json пакета ${name}`);
  }
}

async function loadModule(root: string, name: string): Promise<ModuleEntry> {
  const dir = join(root, "modules", name);
  const manifest = readJson(join(dir, "module.json")) as Manifest;
  try {
    const entry = (readJson(join(dir, "package.json")) as { exports?: Record<string, string> }).exports?.["."] ?? "./contract.ts";
    const module = ((await import(pathToFileURL(join(dir, entry)).href)) as { default?: Module }).default;
    if (!module) throw new Error("нет default — объекта модуля");
    return { manifest, module };
  } catch (e) {
    return { manifest, module: {}, error: `импорт: ${(e as Error).message}` };
  }
}

/** Прочитать выпуск от папки base: оттуда разрешаются ядро, модули и SDK. Модули импортируются заново из их папок. */
export async function loadRelease(base: string): Promise<Release> {
  const coreDir = realpathSync(packageDir(requireFrom(base).resolve("@switchboard/host"), "@switchboard/host"));
  const core = readJson(join(coreDir, "module.json")) as Manifest;
  const sdkDir = packageDir(requireFrom(coreDir).resolve("@anthropic-ai/claude-agent-sdk"), "@anthropic-ai/claude-agent-sdk");
  // корень сборки — над packages/host
  const root = dirname(dirname(coreDir));
  const list = existsSync(join(root, BUILD_FILE)) ? (readJson(join(root, BUILD_FILE)) as BuildList) : null;
  const modules: ModuleEntry[] = [];
  for (const { name } of list?.modules ?? []) modules.push(await loadModule(root, name));
  return { version: list?.version ?? core.version, sdk: readJson(join(sdkDir, "package.json")).version as string, modules, workers: list?.workers ?? {} };
}

/** Команда claude из пакета SDK: ввод — stdin, вывод — stdout и stderr вместе. claude нет — code null со словами. */
export function claudeCli(bin: string | undefined) {
  return (args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }> =>
    new Promise((done) => {
      if (!bin) return done({ code: null, out: "claude не найден в пакете SDK" });
      const p = spawn(bin, args, { env, windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => done({ code: null, out: e.message }));
      p.on("close", (code) => done({ code, out }));
      p.stdin.end(input ?? "");
    });
}

/** Путь к исполняемому claude из пакета SDK для этой платформы. */
export function claudePath(fromDir: string): string | undefined {
  const sdk = createRequire(requireFrom(fromDir).resolve("@anthropic-ai/claude-agent-sdk"));
  const platform = `${process.platform}-${process.arch}`;
  for (const p of [platform, `${platform}-musl`]) {
    try {
      const d = dirname(sdk.resolve(`@anthropic-ai/claude-agent-sdk-${p}/package.json`));
      for (const b of ["claude.exe", "claude"]) if (existsSync(join(d, b))) return join(d, b);
    } catch {
      // нет пакета этой платформы — следующий
    }
  }
  return undefined;
}
