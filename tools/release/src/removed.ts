// Снесено: вход контракта отказывает словом.
const gone = (): never => { throw new Error("снесено"); };
export const entries: (t: Uint8Array) => Array<{ path: string; data?: Buffer; mode: number }> = gone, pack: (f: Array<{ path: string; data: Buffer; mode?: number }>) => Buffer = gone, manifestOf: (t: Uint8Array) => Promise<Record<string, unknown> | null> = gone;
export const sha256hex: (d: string | Uint8Array) => string = gone, shaLine: (h: string, v: string) => string = gone;
export const presign: (k: unknown, o: unknown) => Promise<string> = gone, packModule: (d: string, o?: unknown) => { name: string; version: string; tgz: Buffer; sha: string } = gone, webBuild: (s: Uint8Array, m: unknown[], l: unknown) => Array<{ path: string; data: Buffer }> = gone;
export const BUILD_FILE = "build.json", WEB_FILE = "module.js";
export type BuildList = { app: string; version: string; fleet: string; modules: Array<{ name: string; version: string }>; workers: Record<string, string> };
