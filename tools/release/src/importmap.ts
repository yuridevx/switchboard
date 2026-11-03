// Страница сборки: карта импорта «@switchboard/<модуль>» → ./m/<модуль>.<версия>.js и заранее загружаемые файлы модулей.
// Каталог принимает каждую версию один раз, поэтому файл с этим именем не меняется и кэшируется навсегда.
type Mod = { name: string; version: string };

/** Файл модуля в сборке страницы. */
export const moduleFile = (m: Mod) => `m/${m.name}.${m.version}.js`;

/** Карта импорта по модулям сборки. */
export function importMap(modules: Mod[]): { imports: Record<string, string> } {
  return { imports: Object.fromEntries(modules.map((m) => [`@switchboard/${m.name}`, `./${moduleFile(m)}`])) };
}

/**
 * index.html сборки с картой импорта и modulepreload в начале head: карта должна встать раньше любого модульного скрипта — и того,
 * что домен вставляет сам (маячок Cloudflare Web Analytics на своём домене прода — модуль; карта после него браузером
 * не принимается).
 */
export function withImportMap(html: string, modules: Mod[]): string {
  const tag = `<script type="importmap">${JSON.stringify(importMap(modules))}</script>\n${modules.map((m) => `<link rel="modulepreload" href="./${moduleFile(m)}">`).join("\n")}`;
  const at = html.search(/<script\b/i);
  if (at >= 0) return html.slice(0, at) + tag + "\n" + html.slice(at);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  // ни скрипта, ни head — сразу после doctype
  const dt = html.match(/^<!doctype[^>]*>/i)?.[0] ?? "";
  return dt + tag + html.slice(dt.length);
}
