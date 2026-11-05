// Снесено: заглушка контракта до реализации.
const gone = (): never => {
  throw new Error("снесено");
};
export type HoldFile = { id: string; owner: string; pid: number; port: number; key: string };
export type HolderApi = { spawn(s: { id: string; cwd?: string; env?: Record<string, string | undefined>; command: string; args: string[] }): Promise<HoldFile>; files(): HoldFile[] };
export const frame = (..._a: unknown[]): any => gone();
export const frames = (..._a: unknown[]): any => gone();
export const realHolders = (..._a: unknown[]): any => gone();
