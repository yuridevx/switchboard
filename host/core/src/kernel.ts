// Снесено: новый код — следующим коммитом.
import type { Host, Manifest, Module } from "../contract.ts";
export type HostConfig = { machine: string; modules?: Record<string, unknown> };
export class StartError extends Error {
  readonly reasons: string[] = [];
}
export class Mod {
  constructor(_m: Manifest, _mod: Module) {
    throw new Error("снесено");
  }
}
export class Kernel {
  [k: string]: any;
  constructor(_deps: { exit?: (code: number) => void; [k: string]: unknown }) {
    throw new Error("снесено");
  }
  hostFacade(_m: Mod): Host {
    throw new Error("снесено");
  }
}
