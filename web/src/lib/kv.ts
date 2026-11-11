// Малое хранилище устройства в IndexedDB: его читает и сервис-воркер (localStorage ему недоступен).
// Здесь лежат пропуск и адрес флота — чтобы ответить на вопрос прямо из уведомления.
const DB = "sb2", STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function kvSet(key: string, value: string | null): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      if (value === null) tx.objectStore(STORE).delete(key);
      else tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* без IndexedDB ответ из уведомления не сработает; страница работает */
  }
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    const db = await open();
    const v = await new Promise<string | null>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as string | undefined) ?? null);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}
