// Выпуск Host: ядро, список модулей и Agent SDK точных версий.
// Пакеты находятся обычным разрешением Node от папки выпуска: @switchboard/host — ядро,
// его modules.json — список модулей по порядку старта, @switchboard/<имя> — пакет модуля.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest, Module } from "../contract.ts";

export type ModuleEntry = { manifest: Manifest; module: Module };

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
  const rel = existsSync(join(coreDir, "release.json")) ? (readJson(join(coreDir, "release.json")) as { version?: string }) : {};
  const coreReq = createRequire(join(coreDir, "noop.js"));
  const sdkDir = packageDir(coreReq.resolve("@anthropic-ai/claude-agent-sdk"), "@anthropic-ai/claude-agent-sdk");
  const sdk = readJson(join(sdkDir, "package.json")).version as string;
  const names = readJson(join(coreDir, "modules.json")) as string[];
  const modules: ModuleEntry[] = [];
  for (const name of names) {
    const entry = realpathSync(coreReq.resolve(`@switchboard/${name}`));
    const dir = dirname(entry);
    const manifest = readJson(join(dir, "module.json")) as Manifest;
    const module = ((await import(pathToFileURL(entry).href)) as { default: Module }).default;
    modules.push({ manifest, module });
  }
  return { version: rel.version ?? core.version, sdk, modules };
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
