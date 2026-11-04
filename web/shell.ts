// Оболочка страницы (пульт, телефон) — классический скрипт сборки: читает build.json рядом и запускает сборку ядром страницы.
// Карта импорта «@switchboard/<модуль>» уже стоит в index.html сборки. Своих адресов relay и Worker'ов, своего списка
// модулей у оболочки нет: всё — в списке сборки.
import { withLimit } from "@switchboard/protocol";
import type { BuildList, BuildOptions } from "@switchboard/web-core";

/** Предел чтения списка сборки и загрузки ядра. */
const SHELL_MS = 30_000;
const tooLong = (): never => {
  throw new Error(`нет ответа за ${SHELL_MS / 1000} с`);
};

/** Опции оболочки: вид, имя, порядок разделов, beside. */
export type ShellOptions = Omit<BuildOptions, "root" | "build" | "load">;

export async function boot(o: ShellOptions): Promise<void> {
  const root = document.getElementById("app")!;
  try {
    const build = await withLimit(fetch("./build.json", { cache: "no-store" }).then((r) => r.json() as Promise<BuildList>), SHELL_MS, tooLong);
    // имя — строкой: сборщик оболочки его не вкладывает, браузер берёт ядро по import map
    const spec = "@switchboard/web-core";
    const core = await withLimit(import(/* @vite-ignore */ spec) as Promise<typeof import("@switchboard/web-core")>, SHELL_MS, tooLong);
    await core.startBuild({ root, build, ...o });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${e instanceof Error ? e.message : String(e)}`;
    throw e;
  }
}
