// Оболочка страницы: список сборки, ядро через карту импорта, старт. Отказ на любом шаге — причина на странице.
import type { BuildOptions } from "@switchboard/web-core";
import { limited, readList } from "./list.ts";

export async function boot(options: Partial<BuildOptions>) {
  const root = document.getElementById("app")!;
  try {
    const build = await readList();
    const { startBuild } = await limited(import("@switchboard/web-core"));
    await startBuild({ root, build, ...options });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${(e as Error).message}`;
    throw e;
  }
}
