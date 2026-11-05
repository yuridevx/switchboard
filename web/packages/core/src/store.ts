// Разделы страницы: IndexedDB (страница и обработчик пушей) и память (стенд). Без вида: этот файл берёт sw.
export type Store = {
  get<T>(section: string): Promise<T | undefined>;
  set(section: string, value: unknown): Promise<void>;
  update<T>(section: string, change: (old: T | undefined) => T): Promise<T>;
  clear(): Promise<void>;
};

export function memoryStore(init: Record<string, unknown> = {}): Store & { data: Record<string, unknown> } {
  const data = structuredClone(init);
  return {
    data,
    get: async <T>(section: string) => structuredClone(data[section]) as T | undefined,
    async set(section, value) {
      data[section] = structuredClone(value);
    },
    async update<T>(section: string, change: (old: T | undefined) => T) {
      const next = change(structuredClone(data[section]) as T | undefined);
      data[section] = structuredClone(next);
      return next;
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}

const TABLE = "sections";

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });

/** Хранилище в IndexedDB; db — имя базы, одно на приложение и его обработчик пушей. */
export function idbStore(db = "switchboard", idb: IDBFactory = indexedDB): Store {
  let opened: Promise<IDBDatabase> | undefined;
  const table = async (mode: IDBTransactionMode) => {
    opened ??= (() => {
      const r = idb.open(db, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(TABLE);
      return done(r);
    })();
    return (await opened).transaction(TABLE, mode).objectStore(TABLE);
  };
  return {
    get: async <T>(section: string) => done<T | undefined>((await table("readonly")).get(section)),
    async set(section, value) {
      await done((await table("readwrite")).put(value, section));
    },
    async update<T>(section: string, change: (old: T | undefined) => T) {
      const t = await table("readwrite");
      const next = change(await done<T | undefined>(t.get(section)));
      await done(t.put(next, section));
      return next;
    },
    async clear() {
      await done((await table("readwrite")).clear());
    },
  };
}
