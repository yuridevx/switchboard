// Раскладка сборки приложения: что лежит в её архиве. Список сборки один для Host и страниц.
import { entries, MANIFEST, type TarFile } from "./tar.ts";

export const BUILD_FILE = "build.json";
export const WEB_FILE = "module.js";

export type BuildList = { app: string; version: string; fleet: string; modules: Array<{ name: string; version: string }>; workers: Record<string, string> };
export type Packed = { name: string; tgz: Uint8Array };

/** Вечный кэш: в именах этих файлов есть номер. */
const HEADERS = ["/m/*", "/app.*.js"].map((path) => `${path}\n  Cache-Control: public, max-age=31536000, immutable\n`).join("");

const filesOf = (tgz: Uint8Array) => entries(tgz).filter((e): e is TarFile & { mode: number } => !!e.data);
const listFile = (list: BuildList): TarFile => ({ path: BUILD_FILE, data: Buffer.from(`${JSON.stringify(list, null, 2)}\n`) });

/** Карта импорта — раньше первого скрипта: иначе модуль, вставленный доменом, опередит её и страница не стартует. */
function withImports(html: string, list: BuildList): string {
  const file = (m: BuildList["modules"][number]) => `./m/${m.name}.${m.version}.js`;
  const imports = Object.fromEntries(list.modules.map((m) => [`@switchboard/${m.name}`, file(m)]));
  const links = list.modules.map((m) => `<link rel="modulepreload" href="${file(m)}">`).join("");
  const at = [html.indexOf("<script"), html.indexOf("</head>")].find((i) => i >= 0) ?? "<!doctype html>".length;
  return `${html.slice(0, at)}<script type="importmap">${JSON.stringify({ imports })}</script>${links}${html.slice(at)}`;
}

/** Страница: оболочка в корне, app.js с номером, модули в m/, правила кэша и список сборки. */
export function webBuild(shell: Uint8Array, mods: Packed[], list: BuildList): TarFile[] {
  const files = filesOf(shell);
  const { version } = JSON.parse(files.find((f) => f.path === MANIFEST)!.data.toString("utf8")) as { version: string };
  const app = `app.${version}.js`;
  const page = files.filter((f) => f.path !== MANIFEST).map((f) => {
    if (f.path === "app.js") return { ...f, path: app };
    if (f.path === "index.html") return { ...f, data: Buffer.from(withImports(f.data.toString("utf8"), list).replace('src="app.js"', `src="${app}"`)) };
    return f;
  });
  const modules = list.modules.map((m) => {
    const tgz = mods.find((x) => x.name === m.name)?.tgz;
    const file = tgz && filesOf(tgz).find((f) => f.path === WEB_FILE);
    if (!file) throw new Error(`${m.name}: в архиве модуля нет ${WEB_FILE}`);
    return { path: `m/${m.name}.${m.version}.js`, data: file.data };
  });
  return [...page, ...modules, { path: "_headers", data: Buffer.from(HEADERS) }, listFile(list)];
}

/** Host: файлы ядра, список сборки и модули в modules/<имя>/. */
export const hostBuild = (core: Uint8Array, mods: Packed[], list: BuildList): TarFile[] => [
  ...filesOf(core),
  listFile(list),
  ...mods.flatMap((m) => filesOf(m.tgz).map((f) => ({ ...f, path: `modules/${m.name}/${f.path}` }))),
];
