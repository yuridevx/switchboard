// Оболочка страницы (пульт, телефон) — классический скрипт сборки: читает build.json рядом и запускает сборку ядром страницы.
// Карта импорта «@switchboard/<модуль>» уже стоит в index.html сборки. Своих адресов relay и Worker'ов, своего списка
// модулей у оболочки нет: всё — в списке сборки.
import type { BuildList, BuildOptions } from "@switchboard/web-core";

/** Опции оболочки: вид, имя, порядок разделов, beside. */
export type ShellOptions = Omit<BuildOptions, "root" | "build" | "load">;

export async function boot(o: ShellOptions): Promise<void> {
  const root = document.getElementById("app")!;
  try {
    const build = (await (await fetch("./build.json", { cache: "no-store" })).json()) as BuildList;
    // имя — строкой: сборщик оболочки его не вкладывает, браузер берёт ядро по import map
    const spec = "@switchboard/web-core";
    const core = (await import(/* @vite-ignore */ spec)) as typeof import("@switchboard/web-core");
    await core.startBuild({ root, build, ...o });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${e instanceof Error ? e.message : String(e)}`;
    throw e;
  }
}
