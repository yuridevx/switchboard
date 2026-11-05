// Снесено: новый код — следующим коммитом.
import type { Manifest, Module } from "../contract.ts";
export type ModuleEntry = { manifest: Manifest; module: Module; error?: string };
export type Release = { version: string; sdk: string; modules: ModuleEntry[]; workers: Record<string, string> };
export function claudePath(_d: string): string | undefined {
  throw new Error("снесено");
}
