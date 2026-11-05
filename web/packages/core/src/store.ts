// снесено
export type Store = { get<T>(section: string): Promise<T | undefined>; set(section: string, value: unknown): Promise<void>; update<T>(section: string, change: (v: T | undefined) => T): Promise<T>; clear(): Promise<void> };
export const memoryStore = (_init?: Record<string, unknown>): Store & { data: Record<string, unknown> } => {
  throw new Error("снесено");
};
export const idbStore = (_db?: string, _idb?: IDBFactory): Store => {
  throw new Error("снесено");
};
