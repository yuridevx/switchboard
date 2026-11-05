// Снесено: новый код — следующим коммитом.
export type HoldFile = { id: string; owner: string; pid: number; port: number; key: string; tag?: string };
export type HolderApi = {
  spawn(s: { id: string; cwd?: string; env?: Record<string, string | undefined>; command: string; args: string[] }): Promise<HoldFile>;
  files(): HoldFile[];
};
export function frame(_t: string, _d?: Buffer | string): Buffer {
  throw new Error("снесено");
}
export function frames(_on: (t: string, data: Buffer) => void): (b: Buffer) => void {
  throw new Error("снесено");
}
export function realHolders(_h: string, _b: string | undefined): HolderApi {
  throw new Error("снесено");
}
