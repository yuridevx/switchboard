// Хранилище разделов: одно значение JSON под именем раздела. IndexedDB «switchboard», таблица sections — формат устройства; его читает и обработчик пушей.

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

const answer = <T>(r: IDBRequest<T>) =>
  new Promise<T>((done, fail) => {
    r.onsuccess = () => done(r.result);
    r.onerror = () => fail(r.error);
  });

/** Хранилище в IndexedDB; db — имя базы (одно на приложение и его обработчик пушей). */
export function idbStore(db = "switchboard", idb?: IDBFactory): Store {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (opened) return opened;
    const r = (idb ?? indexedDB).open(db, 1);
    r.onupgradeneeded = () => void r.result.createObjectStore(TABLE);
    return (opened = answer(r));
  };
  /** Транзакция: итог — значение fn после записи на диск. */
  async function run<T>(mode: IDBTransactionMode, fn: (table: IDBObjectStore) => Promise<T> | T): Promise<T> {
    const tx = (await open()).transaction(TABLE, mode);
    const done = new Promise<void>((ok, fail) => {
      tx.oncomplete = () => ok();
      tx.onabort = tx.onerror = () => fail(tx.error);
    });
    const [value] = await Promise.all([fn(tx.objectStore(TABLE)), done]);
    return value;
  }
  return {
    get: <T>(section: string) => run("readonly", (t) => answer(t.get(section)) as Promise<T | undefined>),
    set: (section, value) => run("readwrite", (t) => void t.put(value, section)),
    update: <T>(section: string, fn: (old: T | undefined) => T) =>
      run("readwrite", async (t) => {
        const next = fn((await answer(t.get(section))) as T | undefined);
        t.put(next, section);
        return next;
      }),
    clear: () => run("readwrite", (t) => void t.clear()),
  };
}

/** Хранилище в памяти — для стенда и тестов: значения копируются, как в настоящем. */
export function memoryStore(init: Record<string, unknown> = {}): Store & { data: Record<string, unknown> } {
  const s = {
    data: structuredClone(init),
    get: async <T>(section: string) => structuredClone(s.data[section]) as T | undefined,
    set: async (section: string, value: unknown) => void (s.data[section] = structuredClone(value)),
    update: async <T>(section: string, fn: (old: T | undefined) => T) => {
      const next = fn(structuredClone(s.data[section]) as T | undefined);
      s.data[section] = structuredClone(next);
      return next;
    },
    clear: async () => void (s.data = {}),
  };
  return s;
}
