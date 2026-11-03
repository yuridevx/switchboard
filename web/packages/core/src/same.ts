// Равенство ответов выборки: простые объекты и массивы — по содержимому, остальное — по ссылке.
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const pa = Object.getPrototypeOf(a);
  if (pa !== Object.getPrototypeOf(b) || (pa !== Object.prototype && pa !== Array.prototype)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
