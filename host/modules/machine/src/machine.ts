import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";
export const make = (_o: { home?: string } = {}): Module => ({ requests: { "machine.dirs": () => { throw refuse("снесено"); } } });
