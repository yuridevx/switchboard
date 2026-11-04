// Старт сборки страницы: модули — по списку build.json, адреса Worker'ов (и relay) — из него же; своих адресов у
// страницы нет. Модуль не загрузился за предел — выключен только он: его функция бросает причину, ловушка ядра его выключает.
import { withLimit } from "@switchboard/protocol";
import { startApp } from "./app.tsx";
import { CORE } from "./gate.ts";
import type { AppPart, BuildList, Manifest, Running, StartOptions } from "./types.ts";

export type BuildOptions = Omit<StartOptions, "workers" | "parts"> & {
  /** список сборки — build.json */
  build: BuildList;
  /** загрузить модуль по имени; по умолчанию — динамический импорт «@switchboard/имя» через import map сборки */
  load?: (name: string) => Promise<unknown>;
  /** предел загрузки одного модуля, мс */
  loadMs?: number;
};

/** Предел загрузки модуля страницы. */
export const LOAD_MS = 30_000;

const importModule = (name: string) => import(/* @vite-ignore */ "@switchboard/" + name);

/** Загрузить модули сборки по порядку списка (ядро страницы — это мы) и запустить приложение. */
export async function startBuild(o: BuildOptions): Promise<Running> {
  const { build, load = importModule, loadMs = LOAD_MS, ...rest } = o;
  const parts = await Promise.all(
    build.modules
      .filter((m) => m.name !== CORE.name)
      .map(async ({ name, version }): Promise<AppPart> => {
        try {
          const x = (await withLimit(load(name), loadMs, () => {
            throw new Error(`не загрузился за ${loadMs} мс`);
          })) as { default?: AppPart["module"] | object; manifest?: Manifest };
          if (!x.default || !x.manifest) throw new Error("в файле модуля нет default или manifest");
          // библиотека страницы (web-view, web-ui) отдаёт только экспорты: default — пустой объект, модуля нет
          return { manifest: x.manifest, module: typeof x.default === "function" ? (x.default as AppPart["module"]) : () => ({}) };
        } catch (e) {
          const why = `импорт: ${e instanceof Error ? e.message : String(e)}`;
          const manifest: Manifest = { name, type: "web", version, provides: {}, uses: {} };
          return {
            manifest,
            module: () => {
              throw new Error(why);
            },
          };
        }
      }),
  );
  return startApp({ ...rest, workers: build.workers, parts, application: build.app });
}
