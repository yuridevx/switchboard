// Заглушка сноса.
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };
type Ask = <T>(name: string, body: Record<string, unknown>) => Promise<Answer<T>>;
export type Settings = {
  ready(): boolean;
  get<T>(section: string): T | undefined;
  read(): Promise<string | null>;
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  settled(): Promise<void>;
};
export function settings(_o: { read: Ask; ask: Ask; prefix: string; scope?: string; changed?: () => void }): Settings {
  throw new Error("снесено");
}
