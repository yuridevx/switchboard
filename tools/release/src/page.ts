// Список сборки любого приложения (пишут «Выпуски», читают ядра Host и страницы на старте) и раскладка сборки страницы:
//   файлы оболочки            корень; index.html с картой импорта и modulepreload, app.js с версией в имени
//   m/<модуль>.<версия>.js    модуль одним файлом
//   build.json                список сборки
//   _headers                  вечный кэш файлов с версией в имени: каталог принимает версию один раз
// Код не собирается: только раскладка файлов из архивов.
import { entries, MANIFEST, type TarFile } from "./archive.ts";

/** Список сборки: модули без корня в порядке зависимостей и адреса Worker'ов флота, которыми пользуется сборка. */
export type BuildList = {
  app: string;
  version: string;
  fleet: string;
  modules: Array<{ name: string; version: string }>;
  /** имя Worker-модуля → адрес https; relay — объекты машин (wss того же адреса, /m/<машина>), gate — список машин */
  workers: Record<string, string>;
};

export const BUILD_FILE = "build.json";
/** Файл модуля страницы в его архиве: один ES-модуль. */
export const WEB_FILE = "module.js";

const SHELL_SCRIPT = "app.js";
const FOREVER = "Cache-Control: public, max-age=31536000, immutable";
const HEADERS = `/m/*\n  ${FOREVER}\n/app.*.js\n  ${FOREVER}\n`;

export const buildFile = (list: BuildList): TarFile => ({ path: BUILD_FILE, data: Buffer.from(`${JSON.stringify(list, null, 2)}\n`) });

type Module = BuildList["modules"][number];
const moduleFile = (m: Module) => `m/${m.name}.${m.version}.js`;

/**
 * Карта импорта и modulepreload — раньше любого модульного скрипта, и того, что вставляет домен сам (маячок Cloudflare Web Analytics
 * на домене прода): карта после модуля браузером не принимается.
 */
function withImportMap(html: string, modules: Module[]): string {
  const map = { imports: Object.fromEntries(modules.map((m) => [`@switchboard/${m.name}`, `./${moduleFile(m)}`])) };
  const tags = [`<script type="importmap">${JSON.stringify(map)}</script>`, ...modules.map((m) => `<link rel="modulepreload" href="./${moduleFile(m)}">`)].join("\n");
  const script = html.search(/<script\b/i);
  if (script >= 0) return `${html.slice(0, script)}${tags}\n${html.slice(script)}`;
  const head = html.search(/<\/head>/i);
  if (head >= 0) return `${html.slice(0, head)}${tags}\n${html.slice(head)}`;
  const doctype = /^<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return doctype + tags + html.slice(doctype.length);
}

/** Файлы сборки страницы. В архиве модуля нет его файла — исключение с именем. */
export function webBuild(shell: Buffer, modules: Array<{ name: string; tgz: Buffer }>, list: BuildList): TarFile[] {
  const shellFiles = entries(shell).filter((e) => e.data) as Array<{ path: string; data: Buffer }>;
  const { version } = JSON.parse(shellFiles.find((e) => e.path === MANIFEST)!.data.toString("utf8")) as { version: string };
  const script = `app.${version}.js`;
  const own = shellFiles
    .filter((e) => e.path !== MANIFEST)
    .map(({ path, data }) => {
      if (path === SHELL_SCRIPT) return { path: script, data };
      if (path === "index.html") return { path, data: Buffer.from(withImportMap(data.toString("utf8"), list.modules).replace(`src="${SHELL_SCRIPT}"`, `src="${script}"`)) };
      return { path, data };
    });
  const code = list.modules.map((m) => {
    const tgz = modules.find((x) => x.name === m.name)?.tgz;
    const data = tgz && entries(tgz).find((e) => e.path === WEB_FILE)?.data;
    if (!data) throw new Error(`${m.name}: в архиве модуля нет ${WEB_FILE}`);
    return { path: moduleFile(m), data };
  });
  return [...own, ...code, { path: "_headers", data: Buffer.from(HEADERS) }, buildFile(list)];
}
