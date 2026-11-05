// Адрес страницы: #путь?пары. Экран находит реестр, здесь — только форма адреса и выбор списка рядом.
import type { Params } from "./types.ts";

/** Разобрать адрес после #. */
export function parseHash(hash: string): { path: string; params: Params } {
  const text = hash.replace(/^#/, "");
  const q = text.indexOf("?");
  return q < 0 ? { path: text, params: {} } : { path: text.slice(0, q), params: Object.fromEntries(new URLSearchParams(text.slice(q + 1))) };
}

/** Адрес экрана с параметрами. */
export function toHash(path: string, params: Params = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#${path}${q ? `?${q}` : ""}`;
}

/** Те же ли параметры. */
export const sameParams = (a: Params = {}, b: Params = {}): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Список слева: тот, что уже стоит слева или открыт сейчас, иначе первый. */
export function masterOf(lists: string | string[] | undefined, was: { screen: string; master: string | null } | null): string | null {
  if (!lists) return null;
  const all = [lists].flat();
  return all.find((l) => l === was?.master) ?? all.find((l) => l === was?.screen) ?? all[0];
}
