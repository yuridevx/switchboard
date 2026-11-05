// Запуск сборки: модули по списку build.json, адреса — из него же; файл не загрузился — выключен только его модуль.
import { withLimit } from "@switchboard/protocol";
import { startApp } from "./start.ts";
import type { AppPart, BuildList, Manifest, Running, StartOptions } from "./types.ts";

const LOAD_MS = 30_000;

export type BuildOptions = Omit<StartOptions, "parts" | "workers" | "application"> & {
  build: BuildList;
  /** загрузка файла модуля; по умолчанию — импорт через карту импорта страницы */
  load?: (name: string) => Promise<unknown>;
  loadMs?: number;
};

type File = { default?: unknown; manifest?: Manifest };

/** Модуль файла; что не вышло — бросается функцией модуля, ядро выключает его как любой упавший. */
async function partOf(name: string, version: string, load: (name: string) => Promise<unknown>, ms: number): Promise<AppPart> {
  const broken = (why: string): AppPart => ({
    manifest: { name, type: "web", version, provides: {}, uses: {} },
    module() {
      throw new Error(`импорт: ${why}`);
    },
  });
  try {
    const file = (await withLimit(load(name), ms, () => Promise.reject(new Error(`не загрузился за ${ms} мс`)))) as File;
    const { default: fn, manifest } = file;
    if (!fn || !manifest) return broken("в файле модуля нет default или manifest");
    return { manifest, module: typeof fn === "function" ? (fn as AppPart["module"]) : () => ({}) };
  } catch (e) {
    return broken((e as Error).message);
  }
}

export async function startBuild({ build, load = (n) => import(/* @vite-ignore */ `@switchboard/${n}`), loadMs = LOAD_MS, ...o }: BuildOptions): Promise<Running> {
  const modules = build.modules.filter((m) => m.name !== "web-core");
  const parts = await Promise.all(modules.map((m) => partOf(m.name, m.version, load, loadMs)));
  return startApp({ ...o, parts, workers: build.workers, application: build.app });
}
