// Равенство ответов выборки: простые объекты и массивы — по содержимому, остальное — по ссылке.
const plain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== "object" || x === null) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === Array.prototype;
};

/** Новый ответ выборки с равными ветвями прошлого: равное сохраняет ссылку, memo строки не срабатывает зря. Всё равно — прошлый ответ. */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next) || !plain(prev) || !plain(next) || Array.isArray(prev) !== Array.isArray(next)) return Object.is(prev, next) ? prev : next;
  const out = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  const keys = Object.keys(next);
  let all = keys.length === Object.keys(prev).length;
  for (const k of keys) {
    out[k] = Object.hasOwn(prev, k) ? share(prev[k], next[k]) : next[k];
    if (!Object.hasOwn(prev, k) || out[k] !== prev[k]) all = false;
  }
  return all ? prev : (out as T);
}
