// Настройки этого устройства: вид, свёрнутость, выбранный фильтр. Живут в браузере и не уходят на другие устройства.
import { useSyncExternalStore } from "react";

const PREFIX = "sb2.ui.";
const subs = new Set<() => void>();
const cache = new Map<string, unknown>();

function read<T>(key: string, initial: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let v = initial;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) v = JSON.parse(raw) as T;
  } catch {
    /* хранилище недоступно: значение живёт до перезагрузки */
  }
  cache.set(key, v);
  return v;
}

export function setLocal<T>(key: string, value: T): void {
  cache.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* см. выше */
  }
  for (const s of subs) s();
}

export const getLocal = read;

/** Значение устройства и запись в него. */
export function useLocal<T>(key: string, initial: T): [T, (v: T) => void] {
  const v = useSyncExternalStore((cb) => (subs.add(cb), () => void subs.delete(cb)), () => read(key, initial));
  return [v, (next) => setLocal(key, next)];
}

/** Стереть всё, что страница хранит на устройстве: пропуск, настройки вида, копию для сервис-воркера. */
export async function wipeDevice(): Promise<void> {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("sb2.")) localStorage.removeItem(k);
  } catch {
    /* нечего стирать */
  }
  cache.clear();
  await new Promise<void>((res) => {
    try {
      const r = indexedDB.deleteDatabase("sb2");
      r.onsuccess = r.onerror = r.onblocked = () => res();
    } catch {
      res();
    }
  });
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    await reg?.unregister();
  } catch {
    /* сервис-воркера нет */
  }
}
