// Сравнение ответов выборки: простые объекты и массивы — по содержимому, остальное — по ссылке.
const isPlain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== "object" || x === null) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === Array.prototype;
};

/** Новый ответ, в котором равные ветви — прежние ссылки: memo строки не срабатывает зря. Равно всё — прежний ответ. */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (!isPlain(prev) || !isPlain(next) || Array.isArray(prev) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  const merged = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  let same = keys.length === Object.keys(prev).length;
  for (const k of keys) {
    const known = Object.hasOwn(prev, k);
    merged[k] = known ? share(prev[k], next[k]) : next[k];
    if (!known || merged[k] !== prev[k]) same = false;
  }
  return same ? prev : (merged as T);
}
