// Оболочка страницы: список сборки и ядро; модули и адреса приносит список, ядро находит карта импорта страницы.
import type { BuildOptions } from "@switchboard/web-core";
import { inTime, readList } from "./list.ts";

export type ShellOptions = Omit<BuildOptions, "root" | "build">;

export async function boot(options: ShellOptions): Promise<void> {
  const root = document.getElementById("app")!;
  try {
    const [build, core] = await Promise.all([readList(), inTime(import("@switchboard/web-core"))]);
    await core.startBuild({ ...options, root, build });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${(e as Error).message}`;
    throw e;
  }
}
