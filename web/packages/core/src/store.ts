// Хранилище приложения: разделы по имени в IndexedDB. Его же читает и пишет служебный обработчик
// пушей (у него нет localStorage), поэтому одна база на приложение и одна таблица разделов.

/** Хранилище разделов. Раздел — одно значение JSON под своим именем. */
export interface Store {
  get<T = unknown>(section: string): Promise<T | undefined>;
  set(section: string, value: unknown): Promise<void>;
  /** Прочитать и записать раздел в одной транзакции: обработчик пушей и страница пишут pushes вдвоём. */
  update<T = unknown>(section: string, fn: (old: T | undefined) => T): Promise<T>;
  /** Стереть все разделы: пропуск и данные приложения на этом устройстве. */
  clear(): Promise<void>;
}

const TABLE = "sections";

/** Хранилище в IndexedDB; db — имя базы (одно на приложение и его обработчик пушей). */
export function idbStore(db = "switchboard", idb: IDBFactory = indexedDB): Store {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(db, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(TABLE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));

  async function tx<R>(mode: IDBTransactionMode, fn: (t: IDBObjectStore, done: (r: R) => void) => void): Promise<R> {
    const d = await open();
    return new Promise<R>((resolve, reject) => {
      const t = d.transaction(TABLE, mode);
      let out: R;
      fn(t.objectStore(TABLE), (r) => (out = r));
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    get<T>(section: string) {
      return tx<T | undefined>("readonly", (st, done) => {
        const r = st.get(section);
        r.onsuccess = () => done(r.result as T | undefined);
      });
    },
    set(section: string, value: unknown) {
      return tx<void>("readwrite", (st) => {
        st.put(value, section);
      });
    },
    update<T>(section: string, fn: (old: T | undefined) => T) {
      return tx<T>("readwrite", (st, done) => {
        const r = st.get(section);
        r.onsuccess = () => {
          const v = fn(r.result as T | undefined);
          st.put(v, section);
          done(v);
        };
      });
    },
    clear() {
      return tx<void>("readwrite", (st) => {
        st.clear();
      });
    },
  };
}

/** Хранилище в памяти — для стенда и тестов. */
export function memoryStore(init: Record<string, unknown> = {}): Store & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(init);
  return {
    data,
    async get<T>(section: string) {
      return structuredClone(data[section]) as T | undefined;
    },
    async set(section: string, value: unknown) {
      data[section] = structuredClone(value);
    },
    async update<T>(section: string, fn: (old: T | undefined) => T) {
      const v = fn(structuredClone(data[section]) as T | undefined);
      data[section] = structuredClone(v);
      return v;
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}
