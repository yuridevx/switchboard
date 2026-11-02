// Карта импорта страницы: «@switchboard/<модуль>» → ./m/<модуль>.js — одно правило для сборки «Выпусков» и оболочки.
// Без зависимостей: её берёт и классический скрипт оболочки в браузере.

/** Карта импорта по модулям сборки. */
export function importMap(modules: Array<{ name: string }>): { imports: Record<string, string> } {
  return { imports: Object.fromEntries(modules.map((m) => [`@switchboard/${m.name}`, `./m/${m.name}.js`])) };
}

/**
 * index.html сборки с картой импорта в начале head: карта должна встать раньше любого модульного скрипта — и того,
 * что домен вставляет сам (маячок Cloudflare Web Analytics на своём домене прода — модуль; карта после него браузером
 * не принимается). Карта уже есть — страница как есть.
 */
export function withImportMap(html: string, modules: Array<{ name: string }>): string {
  if (html.includes('type="importmap"')) return html;
  const tag = `<script type="importmap">${JSON.stringify(importMap(modules))}</script>`;
  const at = html.search(/<script\b/i);
  if (at >= 0) return html.slice(0, at) + tag + "\n" + html.slice(at);
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}
