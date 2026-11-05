// Хранилище приложения: разделы по имени. Его же читает и пишет служебный обработчик пушей (у него нет localStorage),
// поэтому одна база на приложение и одна таблица разделов.

/** Раздел — одно значение JSON под своим именем. */
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
  let opening: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(db, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(TABLE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));

  /** Одна транзакция: обещание исполнено, когда она записана. */
  async function inTransaction<R>(mode: IDBTransactionMode, work: (table: IDBObjectStore, finish: (r: R) => void) => void): Promise<R> {
    const base = await open();
    return new Promise<R>((resolve, reject) => {
      const t = base.transaction(TABLE, mode);
      let result: R;
      work(t.objectStore(TABLE), (r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    get: <T,>(section: string) =>
      inTransaction<T | undefined>("readonly", (table, finish) => {
        const r = table.get(section);
        r.onsuccess = () => finish(r.result as T | undefined);
      }),
    set: (section, value) => inTransaction<void>("readwrite", (table) => void table.put(value, section)),
    update: <T,>(section: string, fn: (old: T | undefined) => T) =>
      inTransaction<T>("readwrite", (table, finish) => {
        const r = table.get(section);
        r.onsuccess = () => {
          const value = fn(r.result as T | undefined);
          table.put(value, section);
          finish(value);
        };
      }),
    clear: () => inTransaction<void>("readwrite", (table) => void table.clear()),
  };
}

/** Хранилище в памяти — для стенда и тестов: значения копируются, как в настоящем. */
export function memoryStore(init: Record<string, unknown> = {}): Store & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(init);
  return {
    data,
    get: async <T,>(section: string) => structuredClone(data[section]) as T | undefined,
    async set(section, value) {
      data[section] = structuredClone(value);
    },
    async update<T>(section: string, fn: (old: T | undefined) => T) {
      const value = fn(structuredClone(data[section]) as T | undefined);
      data[section] = structuredClone(value);
      return value;
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}
