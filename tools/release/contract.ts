// Снесено: формат выпуска пишется заново.
const gone = (): never => {
  throw new Error("снесено");
};
export const BUILD_FILE = "build.json";
export const WEB_FILE = "module.js";
export type BuildList = { app: string; version: string; fleet: string; modules: Array<{ name: string; version: string }>; workers: Record<string, string> };
export type TarFile = { path: string; data: Buffer; mode?: number };
export const pack = gone as (files: TarFile[]) => Buffer;
export const entries = gone as (tgz: Uint8Array) => Array<{ path: string; data?: Buffer; mode: number }>;
export const manifestOf = gone as (head: Uint8Array) => Promise<Record<string, unknown> | null>;
export const sha256hex = gone as (data: string | Uint8Array) => string;
export const shaLine = gone as (hash: string, version: string) => string;
export const presign = gone as (key: { accessKeyId: string; secretAccessKey: string; region?: string }, link: { method: string; host: string; path: string; now?: Date; expires?: number }) => Promise<string>;
export const packModule = gone as (dir: string, o?: { bundle?: (dir: string) => Buffer }) => { name: string; version: string; tgz: Buffer; sha: string };
export const webBuild = gone as (shell: Uint8Array, mods: Array<{ name: string; tgz: Uint8Array }>, list: BuildList) => TarFile[];
