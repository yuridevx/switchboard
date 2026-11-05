// Снесено: вход контракта отвечает словом.
export interface Store {
  get<T = unknown>(section: string): Promise<T | undefined>;
  set(section: string, value: unknown): Promise<void>;
  update<T = unknown>(section: string, fn: (old: T | undefined) => T): Promise<T>;
  clear(): Promise<void>;
}
export const idbStore = (_db?: string, _idb?: IDBFactory): Store => {
  throw new Error("снесено");
};
export const memoryStore = (_init?: Record<string, unknown>): Store & { data: Record<string, unknown> } => {
  throw new Error("снесено");
};
