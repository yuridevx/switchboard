// Старт сборки страницы: модули — по списку build.json, адреса Worker'ов и relay — из него же; своих адресов у страницы нет.
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

const LOAD_MS = 30_000;
const importModule = (name: string) => import(/* @vite-ignore */ "@switchboard/" + name);

/** Файл модуля — default и manifest; у библиотеки страницы (web-view, web-ui) default — пустой объект, модуля нет. */
async function fetchPart(name: string, load: (n: string) => Promise<unknown>, limit: number): Promise<AppPart> {
  const file = (await withLimit(load(name), limit, () => {
    throw new Error(`не загрузился за ${limit} мс`);
  })) as { default?: AppPart["module"] | object; manifest?: Manifest };
  if (!file.default || !file.manifest) throw new Error("в файле модуля нет default или manifest");
  return { manifest: file.manifest, module: typeof file.default === "function" ? (file.default as AppPart["module"]) : () => ({}) };
}

/** Модуль, который выключается при старте: на его экранах — причина, остальные работают. */
const brokenPart = (name: string, version: string, why: string): AppPart => ({
  manifest: { name, type: "web", version, provides: {}, uses: {} },
  module() {
    throw new Error(why);
  },
});

/** Загрузить модули сборки (ядро страницы — это мы) и запустить приложение. */
export async function startBuild({ build, load = importModule, loadMs = LOAD_MS, ...rest }: BuildOptions): Promise<Running> {
  const wanted = build.modules.filter((m) => m.name !== CORE.name);
  const parts = await Promise.all(wanted.map(({ name, version }) => fetchPart(name, load, loadMs).catch((e) => brokenPart(name, version, `импорт: ${e instanceof Error ? e.message : String(e)}`))));
  return startApp({ ...rest, workers: build.workers, parts, application: build.app });
}
