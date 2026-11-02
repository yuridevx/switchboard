// Сборка страницы (пульта, телефона) из архивов каталога — одно правило раскладки для «Выпусков» и проверок:
//   <файлы оболочки>   корень: index.html, app.js, sw.js, значки, манифест PWA — всё из архива оболочки, кроме module.json
//   m/<модуль>.js      модуль одним файлом — WEB_FILE из его архива
//   build.json         список сборки (BuildList): модули в порядке зависимостей, адреса Worker'ов флота
// Код не собирается: только раскладка файлов из архивов.
import { buildFile, type BuildList } from "./build-list.ts";
import { MANIFEST, entries, type TarFile } from "./tar.ts";

/** Файл модуля страницы в его архиве: один ES-модуль. */
export const WEB_FILE = "module.js";

/** Файлы сборки страницы. Модуля нет в архивах или в его архиве нет WEB_FILE — исключение с именем модуля. */
export function webBuild(shell: Buffer, modules: Array<{ name: string; tgz: Buffer }>, list: BuildList): TarFile[] {
  const out: TarFile[] = [];
  for (const e of entries(shell)) if (e.data && e.path !== MANIFEST) out.push({ path: e.path, data: e.data });
  for (const { name } of list.modules) {
    const m = modules.find((x) => x.name === name);
    const file = m && entries(m.tgz).find((e) => e.path === WEB_FILE)?.data;
    if (!file) throw new Error(`${name}: в архиве модуля нет ${WEB_FILE}`);
    out.push({ path: `m/${name}.js`, data: file });
  }
  out.push(buildFile(list));
  return out;
}
