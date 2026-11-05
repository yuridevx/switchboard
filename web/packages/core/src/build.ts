// Сборка страницы: модули по списку build.json через карту импорта; модуль не загрузился — выключен только он.
import { withLimit } from "@switchboard/protocol";
import core from "../module.json" with { type: "json" };
import { startApp } from "./start.ts";
import type { AppPart, BuildList, Manifest, Running, StartOptions } from "./types.ts";

const LOAD_MS = 30_000;

export type BuildOptions = Omit<StartOptions, "workers" | "parts"> & {
  /** список сборки — build.json */
  build: BuildList;
  /** загрузить модуль по имени; по умолчанию — динамический импорт «@switchboard/имя» через import map сборки */
  load?: (name: string) => Promise<unknown>;
  /** предел загрузки одного модуля, мс */
  loadMs?: number;
};

const importModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `@switchboard/${name}`);

/** Заглушка модуля, который не загрузился: на старте он упадёт с этой причиной. */
const broken = (name: string, version: string, why: unknown): AppPart => ({
  manifest: { name, version, type: "web", provides: {}, uses: {} },
  module() {
    throw new Error(`импорт: ${why instanceof Error ? why.message : String(why)}`);
  },
});

async function partOf({ name, version }: { name: string; version: string }, load: (name: string) => Promise<unknown>, ms: number): Promise<AppPart> {
  try {
    const file = (await withLimit(load(name), ms, () => {
      throw new Error(`не загрузился за ${ms} мс`);
    })) as { default?: AppPart["module"] | object; manifest?: Manifest };
    if (!file.default || !file.manifest) throw new Error("в файле модуля нет default или manifest");
    // библиотека страницы: default — пустой объект, экранов нет
    return { manifest: file.manifest, module: typeof file.default === "function" ? (file.default as AppPart["module"]) : () => ({}) };
  } catch (e) {
    return broken(name, version, e);
  }
}

/** Загрузить модули сборки (ядро страницы — это мы) и запустить приложение. */
export async function startBuild({ build, load = importModule, loadMs = LOAD_MS, ...rest }: BuildOptions): Promise<Running> {
  const list = build.modules.filter((m) => m.name !== core.name);
  const parts = await Promise.all(list.map((m) => partOf(m, load, loadMs)));
  return startApp({ ...rest, workers: build.workers, parts, application: build.app });
}
