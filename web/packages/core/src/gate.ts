// Снесено.
import core from "../module.json" with { type: "json" };
import type { DefinedPart, Manifest } from "./types.ts";

export const CORE: Manifest = core;
export const appGate = (_parts: DefinedPart[]): string[] => ["снесено"];
