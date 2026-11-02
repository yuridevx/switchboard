// Оболочка страницы (пульт, телефон) — классический скрипт app.js сборки: читает build.json рядом, ставит import map
// «@switchboard/<модуль>» → ./m/<модуль>.js и запускает сборку ядром страницы. Своих адресов relay и Worker'ов,
// своего списка модулей у оболочки нет: всё — в списке сборки.
import type { BuildList, BuildOptions } from "@switchboard/web-core";

/** Опции оболочки: вид, имя, порядок разделов, beside. */
export type ShellOptions = Omit<BuildOptions, "root" | "build" | "load">;

export async function boot(o: ShellOptions): Promise<void> {
  const root = document.getElementById("app")!;
  try {
    const build = (await (await fetch("./build.json", { cache: "no-store" })).json()) as BuildList;
    const map = document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: Object.fromEntries(build.modules.map((m) => [`@switchboard/${m.name}`, `./m/${m.name}.js`])) });
    document.head.append(map);
    // имя — строкой: сборщик оболочки его не вкладывает, браузер берёт ядро по import map
    const spec = "@switchboard/web-core";
    const core = (await import(/* @vite-ignore */ spec)) as typeof import("@switchboard/web-core");
    await core.startBuild({ root, build, ...o });
  } catch (e) {
    root.textContent = `Сборка не загрузилась: ${e instanceof Error ? e.message : String(e)}`;
    throw e;
  }
}
