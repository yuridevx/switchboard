// Старт сборки страницы: модули — по списку build.json, адреса Worker'ов (и relay) — из него же; своих адресов у
// страницы нет. Модуль не загрузился — выключен только он: его start бросает причину, ловушка ядра его выключает.
import { startApp } from "./app.ts";
import { CORE } from "./gate.ts";
import type { AppModule, AppPart, BuildList, Manifest, Running, StartOptions } from "./types.ts";

export type BuildOptions = Omit<StartOptions, "workers" | "parts"> & {
  /** список сборки — build.json */
  build: BuildList;
  /** загрузить модуль по имени; по умолчанию — динамический импорт «@switchboard/имя» через import map сборки */
  load?: (name: string) => Promise<unknown>;
};

const importModule = (name: string) => import(/* @vite-ignore */ "@switchboard/" + name);

/** Загрузить модули сборки по порядку списка (ядро страницы — это мы) и запустить приложение. */
export async function startBuild(o: BuildOptions): Promise<Running> {
  const { build, load = importModule, ...rest } = o;
  const parts = await Promise.all(
    build.modules
      .filter((m) => m.name !== CORE.name)
      .map(async ({ name, version }): Promise<AppPart> => {
        try {
          const x = (await load(name)) as { default?: AppModule; manifest?: Manifest };
          if (!x.default || !x.manifest) throw new Error("в файле модуля нет default или manifest");
          return { manifest: x.manifest, module: x.default };
        } catch (e) {
          const why = `импорт: ${e instanceof Error ? e.message : String(e)}`;
          const manifest: Manifest = { name, type: "web", version, provides: {}, uses: {} };
          return {
            manifest,
            module: {
              start() {
                throw new Error(why);
              },
            },
          };
        }
      }),
  );
  return startApp({ ...rest, workers: build.workers, parts });
}
