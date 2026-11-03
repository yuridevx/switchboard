// Сборка страницы (пульта, телефона) из архивов каталога — одно правило раскладки для «Выпусков» и проверок:
//   <файлы оболочки>     корень: index.html (с картой импорта и modulepreload), app.<версия>.js, sw.js, значки, манифест PWA —
//                        всё из архива оболочки, кроме module.json
//   m/<модуль>.<версия>.js  модуль одним файлом — WEB_FILE из его архива
//   build.json           список сборки (BuildList): модули в порядке зависимостей, адреса Worker'ов флота
//   _headers             правило вечного кэша файлов с версией в имени
// Код не собирается: только раскладка файлов из архивов.
import { buildFile, type BuildList } from "./build-list.ts";
import { moduleFile, withImportMap } from "./importmap.ts";
import { MANIFEST, entries, type TarFile } from "./tar.ts";

/** Файл модуля страницы в его архиве: один ES-модуль. */
export const WEB_FILE = "module.js";
/** Скрипт оболочки в её архиве: в сборке получает версию в имени. */
const SHELL_SCRIPT = "app.js";
/** Файлы с версией в имени не меняются: каталог принимает версию один раз. */
const HEADERS = ["/m/*", "/app.*.js"].map((path) => `${path}\n  Cache-Control: public, max-age=31536000, immutable\n`).join("");

/** Файлы сборки страницы. Модуля нет в архивах или в его архиве нет WEB_FILE — исключение с именем модуля. */
export function webBuild(shell: Buffer, modules: Array<{ name: string; tgz: Buffer }>, list: BuildList): TarFile[] {
  const out: TarFile[] = [];
  const files = entries(shell);
  const { version } = JSON.parse(files.find((e) => e.path === MANIFEST)!.data!.toString("utf8")) as { version: string };
  const script = `app.${version}.js`;
  for (const e of files) {
    if (!e.data || e.path === MANIFEST) continue;
    if (e.path === SHELL_SCRIPT) out.push({ path: script, data: e.data });
    else if (e.path === "index.html") out.push({ path: e.path, data: Buffer.from(withImportMap(e.data.toString("utf8"), list.modules).replace(`src="${SHELL_SCRIPT}"`, `src="${script}"`)) });
    else out.push({ path: e.path, data: e.data });
  }
  for (const m of list.modules) {
    const file = modules.find((x) => x.name === m.name) && entries(modules.find((x) => x.name === m.name)!.tgz).find((e) => e.path === WEB_FILE)?.data;
    if (!file) throw new Error(`${m.name}: в архиве модуля нет ${WEB_FILE}`);
    out.push({ path: moduleFile(m), data: file });
  }
  out.push({ path: "_headers", data: Buffer.from(HEADERS) });
  out.push(buildFile(list));
  return out;
}
