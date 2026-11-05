// Оболочка страницы: список сборки и ядро разом, ядро находит карта импорта; старт. Отказ на любом шаге — причина на странице.
import type { BuildOptions } from "@switchboard/web-core";
import { limited, readList } from "./list.ts";

export async function boot(options: Partial<BuildOptions>) {
  const root = document.getElementById("app")!;
  try {
    const [build, core] = await Promise.all([readList(), limited(import("@switchboard/web-core"))]);
    await core.startBuild({ ...options, root, build });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${(e as Error).message}`;
    throw e;
  }
}
