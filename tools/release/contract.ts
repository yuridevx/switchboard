// Снесено: каталог модулей пишется заново. Входы контракта отказывают словом.
const gone = (): never => {
  throw new Error("снесено");
};
export type TarFile = { path: string; data: Buffer; mode?: number };
export type BuildList = { app: string; version: string; fleet: string; modules: Array<{ name: string; version: string }>; workers: Record<string, string> };
export const BUILD_FILE = "build.json";
export const MANIFEST = "module.json";
export const WEB_FILE = "module.js";
export const pack: (files: TarFile[]) => Buffer = () => Buffer.alloc(0);
export const entries: (tgz: Buffer) => Array<{ path: string; data: Buffer | null; mode: number }> = gone;
export const manifestOf: (head: Uint8Array) => Promise<Record<string, unknown> | null> = gone;
export const sha256hex: (b: Uint8Array | string) => string = gone;
export const shaLine: (hex: string, v: string) => string = gone;
export const presign: (k: { accessKeyId: string; secretAccessKey: string; region?: string }, o: { method: "GET" | "PUT"; host: string; path: string; now: Date; expires?: number }) => Promise<string> = gone;
export const packModule: (at: string, o?: { bundle?: (dir: string, m: { name: string; version: string; type: string }) => Buffer }) => { name: string; version: string; tgz: Buffer; sha: string } = gone;
export const webBuild: (shell: Buffer, modules: Array<{ name: string; tgz: Buffer }>, list: BuildList) => TarFile[] = gone;
