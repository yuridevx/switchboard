// Сборка страницы: оболочка, модули одним файлом под вечным кэшем, список сборки. Сборщик только раскладывает.
import { entries, MANIFEST } from "./archive.ts";

export const BUILD_FILE = "build.json";
export const WEB_FILE = "module.js";

/** Список сборки: один для Host и страниц. */
export type BuildList = { app: string; version: string; fleet: string; modules: Array<{ name: string; version: string }>; workers: Record<string, string> };

export const buildFile = (list: BuildList) => JSON.stringify(list, null, 2) + "\n";

const FOREVER = "  Cache-Control: public, max-age=31536000, immutable\n";
const HEADERS = `/m/*\n${FOREVER}/app.*.js\n${FOREVER}`;

/** Карта импорта встаёт раньше первого скрипта страницы: маячок домена её не опередит. */
function withImportMap(html: string, list: BuildList, file: (m: { name: string; version: string }) => string): string {
  const imports = Object.fromEntries(list.modules.map((m) => [`@switchboard/${m.name}`, `./${file(m)}`]));
  const links = list.modules.map((m) => `<link rel="modulepreload" href="./${file(m)}">`).join("");
  const block = `<script type="importmap">${JSON.stringify({ imports })}</script>${links}`;
  const script = html.indexOf("<script");
  if (script >= 0) return html.slice(0, script) + block + html.slice(script);
  const head = html.indexOf("</head>");
  if (head >= 0) return html.slice(0, head) + block + html.slice(head);
  const doctype = /^<!doctype html>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + block + html.slice(at);
}

/** Файлы сборки страницы. У каждого модуля списка должен быть module.js. */
export function webBuild(shell: Uint8Array, modules: Array<{ name: string; tgz: Uint8Array }>, list: BuildList): Array<{ path: string; data: Buffer }> {
  const items = entries(shell).filter((e) => e.data);
  const manifest = items.find((e) => e.path === MANIFEST);
  const appFile = `app.${(JSON.parse(manifest!.data!.toString("utf8")) as { version: string }).version}.js`;
  const moduleFile = (m: { name: string; version: string }) => `m/${m.name}.${m.version}.js`;
  const files = items
    .filter((e) => e.path !== MANIFEST)
    .map((e) => {
      if (e.path === "app.js") return { path: appFile, data: e.data! };
      if (e.path !== "index.html") return { path: e.path, data: e.data! };
      const html = withImportMap(e.data!.toString("utf8"), list, moduleFile).replace('src="app.js"', `src="${appFile}"`);
      return { path: e.path, data: Buffer.from(html) };
    });
  const scripts = list.modules.map((m) => {
    const tgz = modules.find((x) => x.name === m.name)?.tgz;
    const file = tgz && entries(tgz).find((e) => e.path === WEB_FILE)?.data;
    if (!file) throw new Error(`${m.name}: в архиве модуля нет ${WEB_FILE}`);
    return { path: moduleFile(m), data: file };
  });
  return [...files, ...scripts, { path: "_headers", data: Buffer.from(HEADERS) }, { path: BUILD_FILE, data: Buffer.from(buildFile(list)) }];
}
