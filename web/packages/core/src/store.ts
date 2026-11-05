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

const answer = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });

/** Хранилище в IndexedDB; db — имя базы, одно на приложение и его обработчик пушей. */
export function idbStore(db = "switchboard", idb?: IDBFactory): Store {
  let opened: Promise<IDBDatabase> | undefined;
  function open() {
    if (opened) return opened;
    const r = (idb ?? indexedDB).open(db, 1);
    r.onupgradeneeded = () => void r.result.createObjectStore(TABLE);
    return (opened = answer(r));
  }
  /** Транзакция: итог — значение fn после записи на диск. */
  async function run<T>(mode: IDBTransactionMode, fn: (table: IDBObjectStore) => Promise<T> | T) {
    const tx = (await open()).transaction(TABLE, mode);
    const done = new Promise<void>((ok, no) => {
      tx.oncomplete = () => ok();
      tx.onabort = tx.onerror = () => no(tx.error);
    });
    const [value] = await Promise.all([fn(tx.objectStore(TABLE)), done]);
    return value;
  }
  return {
    get: <T>(section: string) => run("readonly", (t) => answer<T | undefined>(t.get(section))),
    set: (section, value) => run("readwrite", (t) => void t.put(value, section)),
    update: <T>(section: string, change: (old: T | undefined) => T) =>
      run("readwrite", async (t) => {
        const next = change(await answer<T | undefined>(t.get(section)));
        t.put(next, section);
        return next;
      }),
    clear: () => run("readwrite", (t) => void t.clear()),
  };
}
