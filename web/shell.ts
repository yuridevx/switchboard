// Оболочка страницы: прочитать список сборки и отдать его ядру страницы со своими опциями.
// Классический скрипт: карта импорта уже стоит в index.html сборки, адресов и списка модулей у оболочки нет.
import { withLimit } from "@switchboard/protocol";
import type { BuildList, BuildOptions } from "@switchboard/web-core";
import { LIST_MS, readList } from "./list.ts";

export type ShellOptions = Omit<BuildOptions, "root" | "build" | "load">;

const late = (): never => {
  throw new Error(`нет ответа за ${LIST_MS / 1000} с`);
};

export async function boot(options: ShellOptions): Promise<void> {
  const root = document.getElementById("app")!;
  try {
    const build = await readList<BuildList>(late);
    // имя строкой: сборщик оболочки ядро не вкладывает, браузер берёт его по карте импорта
    const core = "@switchboard/web-core";
    const { startBuild } = await withLimit(import(/* @vite-ignore */ core) as Promise<typeof import("@switchboard/web-core")>, LIST_MS, late);
    await startBuild({ root, build, ...options });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${e instanceof Error ? e.message : String(e)}`;
    throw e;
  }
}
